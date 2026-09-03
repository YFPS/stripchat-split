import React, { useEffect, useRef, useState } from 'react'
import { createMouflonLoader, masterUrlFor, pickLowestLevelIndex } from '../services/streamSource'

/** 记录 HLS 播放器崩溃到 localStorage */
function logHlsCrash(id: string, error: string, details?: Record<string, unknown>) {
  const record = {
    timestamp: new Date().toISOString(),
    type: 'hls-crash',
    streamId: id,
    error,
    ...details
  }
  console.error('[hls-crash]', record)
  try {
    const existing = localStorage.getItem('crash-logs')
    const logs = existing ? JSON.parse(existing) : []
    logs.push(record)
    if (logs.length > 20) logs.splice(0, logs.length - 20)
    localStorage.setItem('crash-logs', JSON.stringify(logs))
  } catch { /* ignore */ }
}

interface StripchatPlayerProps {
  /** 主播数字 id（来自 cam API 的 user.user.id） */
  id: string
  fallbackImage?: string
  /** 视频元数据就绪后回调实际宽高（供外层按 16:9 / 9:16 等比例自适应布局） */
  onMetadata?: (width: number, height: number) => void
  /** 预览模式：锁最低清晰度 + 更小的缓冲上限（预览墙用；分屏/播放器窗口不传） */
  preview?: boolean
}

/** 清晰度档位（对应 hls.js levels 中的一个变体） */
interface QualityLevel {
  /** hls.js levels 下标；-1 表示自动 */
  idx: number
  label: string
}

/**
 * Stripchat 直播播放器：hls.js + Mouflon 解密（纯视频，替代 webview）。
 * 流链路（实测验证）：
 *   master: edge-hls.doppiocdn.com/hls/{id}/master/{id}_auto.m3u8（含 PSCH pkey）
 *   变体:   +?psch=v2&pkey={pkey} → 真实直播 playlist（#EXT-X-MOUFLON:URI 段）
 *   段:     段 URL 倒数第二段反转+base64+XOR SHA256(pdkey) 解密 → fMP4
 * 协议细节（URL 模板、loader 补丁）已收敛到 services/streamSource.ts。
 * 右下角带官网同款清晰度选择（自动/各分辨率，切换 hls.currentLevel）。
 */
export const StripchatPlayer: React.FC<StripchatPlayerProps> = ({ id, fallbackImage, onMetadata, preview = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<any>(null)
  const [failed, setFailed] = useState(false)
  // 清晰度控件状态
  const [levels, setLevels] = useState<QualityLevel[]>([])
  const [currentLabel, setCurrentLabel] = useState('自动')
  const [menuOpen, setMenuOpen] = useState(false)
  // 用户手动选过档位后才跟随 LEVEL_SWITCHED 更新标签（初始自动模式固定显示"自动"）
  const manualRef = useRef(false)
  /**
   * 重建 nonce：致命的「其他错误」分支需要销毁并重建 hls 实例。
   * 原先那里靠 setFailed(false) 触发重建，但 effect 依赖只有 [id]，
   * setFailed(false) 不会让 effect 重跑 —— 实例销毁后就永久卡在空 <video> 上。
   */
  const [retryKey, setRetryKey] = useState(0)

  /**
   * 致命错误累计次数。必须放在 ref 里跨重建存活 —— 原先它是 effect 内的局部
   * 变量，每次 retryKey 触发重建都归零，于是 `count > MAX_RETRIES` 那条分支
   * 永远走不到：一路坏流会以 2 秒为周期无限重建，每轮都要新建 Worker 并重新
   * 拉 master + level playlist。主播下播后格子越多，这个循环越滚越大。
   */
  const fatalCountRef = useRef(0)

  /** 判死后的自动重挂定时器（见下方 max-retries 分支） */
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 换流（id 变化）才清零重试计数；retryKey 引起的重建不清零。
  // 声明在下面的主 effect 之前，保证 id 变化时先于主 effect 执行。
  useEffect(() => {
    fatalCountRef.current = 0
  }, [id])

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      setFailed(true)
      return
    }
    let cancelled = false

    // hls.js 本地 vendor 约 428KB，动态 import 拆出独立 chunk，
    // 只有真正进入播放时才加载，避免拖慢主界面首屏。
    ;(async () => {
      try {
        const { default: Hls } = await import('../vendor/hls.min.mjs')
        if (cancelled || !videoRef.current) return
        if (!Hls.isSupported()) {
          setFailed(true)
          return
        }

        const hls = new Hls({
          loader: createMouflonLoader(Hls.DefaultConfig.loader),
          // 预览模式：缓冲上限减半，几十路流同时挂载时少囤内存
          ...(preview ? { maxBufferLength: 15 } : {}),
          // 直播回缓冲保留窗口。缺了这一项，hls.js 会回落到 backBufferLength
          // 的默认值 Infinity，而 flushBackBuffer 的守卫是
          // isFiniteNumber(Infinity)（即 Number.isFinite）=== false，
          // 于是回缓冲永远不淘汰 —— 每路 SourceBuffer 从开播一路涨到
          // Chromium MSE 的配额上限。这是整套系统里唯一随时间单调恶化的量，
          // 也是「分屏越播越卡」的主因之一。
          liveBackBufferLength: 15,
          // 按 <video> 的实际渲染尺寸限制自动档位上限：分屏 9 格时每格只有屏幕
          // 1/9，却让 ABR 去拉 1080p 纯属把 CPU 烧在看不见的像素上（GPU 已全局
          // 禁用，这些像素全是软解）。这正是 previewBudget.ts 注释里引的
          // "别解码超过所需的像素" 原则，hls.js 已经内置了实现。
          // 只影响 ABR 自动模式：预览墙走的是下面的 currentLevel 硬锁，
          // 无需再按尺寸限档，preview 时关掉可省掉每秒一次的 getBoundingClientRect。
          capLevelToPlayerSize: !preview,
          // 分片加载策略。默认值对 2 秒一段的直播过于宽容：
          // errorRetry.maxNumRetry 默认 6（退避到 8s）、maxLoadTimeMs 默认 120s，
          // 于是一路 CDN 抖动的分片会静默重试六七次后才升级成 fatal，
          // 期间刷出一串 non-fatal fragLoadError 却始终播不出画面。
          // 直播场景宁可早点判死让上层重建/回退封面。
          fragLoadPolicy: {
            default: {
              maxTimeToFirstByteMs: 8000,
              maxLoadTimeMs: 15000,
              timeoutRetry: { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 2000 },
              errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 }
            }
          },
          // 放到 Worker 里做解封装/转封装。此前为了"避免兼容性问题"关掉了，
          // 结果 6 路预览的 demux 全压在主线程上，而 GPU 又已被全局禁用，
          // 主线程既要软解又要绘制，UI 会周期性卡顿。Electron 的 Chromium
          // 版本是固定的，Worker 行为完全可控。
          enableWorker: true,
          lowLatencyMode: false,
          maxMaxBufferLength: 30
        })
        hlsRef.current = hls
        
        const MAX_RETRIES = 3

        hls.on(Hls.Events.ERROR, (_e: unknown, data: any) => {
          if (data?.fatal) {
            fatalCountRef.current++
            const fatalErrorCount = fatalCountRef.current
            console.warn(`[hls] Fatal error #${fatalErrorCount}/${MAX_RETRIES}:`, { type: data.type, details: data.details, id })

            if (fatalErrorCount > MAX_RETRIES) {
              // 超过重试次数，放弃本轮 —— 但不永久定格：20s 后自动重建一次。
              // 原先的写法是 setFailed(true) 后无任何恢复路径，CDN 抖动/主播
              // 短暂断流会让格子永久停在封面/"未开播"，只能关分屏重开。
              logHlsCrash(id, 'Fatal HLS error - max retries exceeded', {
                type: data.type,
                details: data.details,
                retries: fatalErrorCount
              })
              setFailed(true)
              hls.destroy()
              hlsRef.current = null
              recoverTimerRef.current = setTimeout(() => {
                recoverTimerRef.current = null
                if (cancelled) return
                fatalCountRef.current = 0
                setFailed(false)
                setRetryKey((k) => k + 1)
              }, 20000)
              return
            }
            
            // 尝试恢复
            const hlsInstance = hlsRef.current
            if (!hlsInstance) return
            
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              // 网络错误：等待后重试加载
              console.log('[hls] Recovering from network error...')
              setTimeout(() => {
                if (!cancelled && hlsRef.current) {
                  // @ts-ignore - HLS.js 方法
                  hlsRef.current.startLoad()
                }
              }, 1000 * fatalErrorCount)  // 递增延迟
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              // 媒体错误：尝试交换音视频轨道
              console.log('[hls] Recovering from media error...')
              // @ts-ignore - HLS.js 方法
              hlsInstance.recoverMediaError()
            } else {
              // 其他致命错误：销毁后重建实例。必须靠 retryKey 让 effect 重跑，
              // 只 setFailed(false) 是无效的（依赖里没有 failed）
              console.log('[hls] Recovering from unknown error by re-creating instance...')
              setTimeout(() => {
                if (cancelled) return
                hlsInstance.destroy()
                hlsRef.current = null
                setRetryKey((k) => k + 1)
              }, 2000)
            }
          } else {
            // 非致命错误，只在开发环境记录（带 URL，方便定位是 master 还是 level）
            if (import.meta.env.DEV) {
              console.debug('[hls] non-fatal:', data.type, data.details, data.url || data.frag?.url || '')
            }
          }
        })
        hls.attachMedia(video)
        hls.loadSource(masterUrlFor(id))
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // 恢复成功后清零计数，避免短暂抖动累积到 MAX_RETRIES 直接判死
          fatalCountRef.current = 0
          // 预览模式：锁最低清晰度，卡片那么小 1080p 纯属浪费带宽和 CPU。
          // 之前这里写的是 `levels.length - 1`，而 hls.js 的 levels 是升序，
          // 那拿到的是**最高档**，导致预览墙 16 路全部按 720p/1080p 软解
          // （解码像素为 240p 方案的 9～20 倍）。档位选取已收敛到
          // pickLowestLevelIndex（含回归测试），不要在这里再手写索引。
          if (preview && hls.levels.length > 0) {
            const lowest = pickLowestLevelIndex(hls.levels)
            hls.autoLevelCapping = lowest
            hls.currentLevel = lowest
          }
          // 构建清晰度档位列表（按高度降序，去掉重复高度）
          const seen = new Set<number>()
          const lvls: QualityLevel[] = []
          hls.levels.forEach((l: any, i: number) => {
            if (l?.height && !seen.has(l.height)) {
              seen.add(l.height)
              lvls.push({ idx: i, label: `${l.height}p` })
            }
          })
          // hls.js levels 通常已按码率排序（高的在前），这里再按高度降序
          lvls.sort((a, b) => {
            const ha = hls.levels[a.idx]?.height || 0
            const hb = hls.levels[b.idx]?.height || 0
            return hb - ha
          })
          setLevels(lvls)
          setCurrentLabel('自动')
          manualRef.current = false
          // 挂载即意味着已拿到解码配额且在视口内，直接播放
          video.play().catch(() => {})
        })
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e: unknown, data: any) => {
          if (!manualRef.current) return // 自动模式：标签固定显示"自动"
          const l = data?.level >= 0 ? hls.levels[data.level] : null
          setCurrentLabel(l?.height ? `${l.height}p` : '自动')
        })
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
      if (recoverTimerRef.current !== null) {
        clearTimeout(recoverTimerRef.current)
        recoverTimerRef.current = null
      }
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      video.removeAttribute('src')
      video.load()
    }
  }, [id, retryKey])

  /** 选择档位：idx=-1 为自动 */
  const selectLevel = (idx: number) => {
    const hls = hlsRef.current
    if (!hls) return
    manualRef.current = true
    hls.currentLevel = idx
    setCurrentLabel(idx === -1 ? '自动' : (levels.find((l) => l.idx === idx)?.label ?? '自动'))
    setMenuOpen(false)
  }

  if (failed) {
    return fallbackImage ? (
      <img src={fallbackImage} alt="" className="w-full h-full object-cover" loading="lazy" />
    ) : (
      <div className="w-full h-full bg-gray-900 flex items-center justify-center text-gray-400 text-xs">
        未开播
      </div>
    )
  }

  return (
    <div className="relative w-full h-full bg-black">
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        muted
        autoPlay
        playsInline
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          if (v.videoWidth > 0 && v.videoHeight > 0) {
            onMetadata?.(v.videoWidth, v.videoHeight)
          }
        }}
      />
      {levels.length > 0 && (
        <div className="absolute bottom-3 right-3 z-30">
          {/* 清晰度切换按钮：GSAP ghost pill 风格 */}
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium font-mori text-surface-cream bg-just-black/70 hover:bg-just-black/90 border border-surface-25 hover:border-surface-cream rounded-tag transition-all duration-150 backdrop-blur-sm"
            title="清晰度"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            <span>{currentLabel}</span>
            <svg className={`w-2.5 h-2.5 transition-transform duration-150 ${menuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* 下拉菜单：GSAP 深色面板 */}
          {menuOpen && (
            <div className="absolute bottom-full right-0 mb-2 min-w-[100px] bg-off-black border border-surface-25 rounded-card overflow-hidden">
              {/* 自动选项 */}
              <button
                onClick={() => selectLevel(-1)}
                className={`block w-full px-3 py-2 text-[13px] text-left font-mori transition-colors duration-100 ${
                  currentLabel === '自动'
                    ? 'text-shockingly-green bg-shockingly-green/10'
                    : 'text-surface-cream hover:bg-surface-25'
                }`}
              >
                自动
              </button>
              {/* 分隔线 */}
              <div className="h-px bg-surface-25" />
              {/* 分辨率选项 */}
              {levels.map((l) => (
                <button
                  key={l.idx}
                  onClick={() => selectLevel(l.idx)}
                  className={`block w-full px-3 py-2 text-[13px] text-left font-mori transition-colors duration-100 ${
                    currentLabel === l.label
                      ? 'text-shockingly-green bg-shockingly-green/10'
                      : 'text-surface-cream hover:bg-surface-25'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
