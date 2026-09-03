import React, { memo, useEffect, useRef, useState } from 'react'
import { Model } from '../types'
import { useFavoriteStore } from '../stores/favoriteStore'
import { StripchatPlayer } from './StripchatPlayer'
import { useStreamSlot } from '../hooks/useStreamSlot'
import { useSharedInView } from '../hooks/useSharedInView'
import { addVisibleLive, removeVisibleLive } from '../services/previewBudget'
import { enqueueMount } from '../services/mountQueue'

interface ModelCardProps {
  model: Model
  isSelected: boolean
  onToggleSelect: (modelId: string) => void
  /** 是否允许视频预览（= 全局"视频预览"开关；具体挂不挂播放器还取决于视口与解码配额） */
  videoEnabled?: boolean
}

const ModelCardInner: React.FC<ModelCardProps> = ({ model, isSelected, onToggleSelect, videoEnabled = true }) => {
  // 直播状态由 useFavorites 统一 cam 确认（favorites 接口的 isOnline 不可靠，
  // offline 列表里也混着 isOnline=true 但实际没直播的），这里只消费结果：
  // live=正在直播（携带流 id，直接给播放器用），offline=无流，checking=尚未确认
  const status = useFavoriteStore((s) => s.streamStatus[model.id])

  const live = status?.phase === 'live'
  const streamId = status?.phase === 'live' ? status.id : ''
  const checking = status === undefined || status.phase === 'checking'

  // 视口可见性：卡片滚出预览区域即释放解码配额（观察点从播放器上移到卡片）
  // 所有卡片共用一个 IntersectionObserver，减少几百张卡各自的 observer 开销
  const { ref: cardRef, inView } = useSharedInView<HTMLDivElement>()

  // 分屏是全屏覆盖层，它底下的预览墙并没有卸载，而 IntersectionObserver
  // 只判断「与视口是否相交」、不感知遮挡，被盖住的卡片 inView 依然是 true。
  // 不显式让位就会出现「分屏 N 路 + 预览墙 6 路」同时解码，软件渲染下必卡。
  const splitViewActive = useFavoriteStore((s) => s.splitViewActive)

  // 只有「直播中 + 允许视频 + 卡片在视口内 + 分屏未开 + 拿到全局解码配额」
  // 才真正挂载播放器；配额没拿到的卡片显示封面 + LIVE 角标（等空位），
  // 滚出视口立即释放。
  const wantsLive = live && videoEnabled && inView && !splitViewActive
  const granted = useStreamSlot(model.id, wantsLive)

  // 拿到配额 ≠ 立刻挂载：分屏关闭 / 首屏加载时十几张卡会在同一个 tick 同时
  // 拿到配额、同时冷启动（建 Worker + 拉 manifest + 首帧软解），形成启动风暴。
  // 挂载限速把「真正挂播放器」错峰到同一时刻最多 CONCURRENT_MOUNTS 路；
  // 稳态滚动时队列空闲、同步放行，不引入任何额外延迟。
  const [mountReady, setMountReady] = useState(false)
  useEffect(() => {
    if (!granted) {
      setMountReady(false)
      return
    }
    let cancelled = false
    const revoke = enqueueMount(() => {
      if (!cancelled) setMountReady(true)
    })
    return () => {
      cancelled = true
      revoke()
    }
  }, [granted])

  const showVideo = live && granted && mountReady

  // 预算声明：让 previewBudget 统计「此刻视口内有多少张卡需要解码」，
  // 从而把预览池容量动态调到恰好覆盖可视卡片（全部可视直播卡都能播）。
  // 依赖 wantsLive 而不是 granted —— 容量正是根据这份需求算出来的。
  useEffect(() => {
    if (!wantsLive) return
    addVisibleLive()
    return () => removeVisibleLive()
  }, [wantsLive])

  // 单击选择延迟 250ms 判定，双击时不触发选择（避免双击开窗口时选择状态闪变）
  const clickTimerRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current)
    }
  }, [])

  const handleSingleClick = () => {
    if (clickTimerRef.current) return
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      onToggleSelect(model.id)
    }, 250)
  }

  // 双击：打开独立播放器窗口（新 BrowserWindow，页内 #/player 路由）
  const handleDoubleClick = () => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    window.electronAPI.openPlayerWindow({
      id: model.id,
      username: model.username,
      displayName: model.displayName,
      avatar: model.avatar
    })
  }

  // GSAP 风格：无阴影，选中用 shockingly-green 边框
  const cardClasses = [
    'relative rounded-card overflow-hidden cursor-pointer transition-all duration-150',
    isSelected
      ? 'ring-1 ring-shockingly-green'
      : 'ring-1 ring-transparent hover:ring-surface-25'
  ].join(' ')

  return (
    <div
      ref={cardRef}
      className={cardClasses}
      onClick={handleSingleClick}
      onDoubleClick={handleDoubleClick}
      title="单击选择 / 双击打开播放器窗口"
    >
      {showVideo ? (
        // 真在直播且拿到配额：hls.js + Mouflon 解密播放纯直播画面（cam API 确认有流）
        <div className="aspect-video bg-just-black relative">
          <StripchatPlayer id={streamId} fallbackImage={model.avatar} preview />
          {/* 选择交互用独立按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleSelect(model.id)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className={`absolute top-2 right-2 z-10 w-7 h-7 rounded-full text-sm flex items-center justify-center transition-all duration-150 ${
              isSelected
                ? 'bg-shockingly-green text-just-black'
                : 'bg-just-black/60 text-surface-cream hover:bg-just-black/80 border border-surface-25'
            }`}
            title={isSelected ? '取消选择' : '选择'}
          >
            {isSelected ? '✓' : '+'}
          </button>
          <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1">
            <span className="w-2 h-2 bg-pink rounded-full animate-pulse" />
            <span className="text-xs text-surface-cream bg-just-black/50 px-1 rounded font-mori">LIVE</span>
            {model.viewers > 0 && (
              <span className="text-xs text-orangey bg-just-black/50 px-1 rounded font-mori">
                {model.viewers} 观看
              </span>
            )}
          </div>
        </div>
      ) : (
        // 离线 / 假在线（cam 确认无流）/ 封面模式 / 未拿到解码配额：显示封面图，单击切换选择
        <div className="aspect-video bg-just-black relative">
          <img
            src={model.avatar}
            alt={model.displayName}
            className="w-full h-full object-cover"
            loading="lazy"
          />
          {live && (
            // 封面模式下仍在直播：叠加 LIVE 标记，与视频预览模式保持一致
            <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1">
              <span className="w-2 h-2 bg-pink rounded-full animate-pulse" />
              <span className="text-xs text-surface-cream bg-just-black/50 px-1 rounded font-mori">LIVE</span>
              {model.viewers > 0 && (
                <span className="text-xs text-orangey bg-just-black/50 px-1 rounded font-mori">
                  {model.viewers} 观看
                </span>
              )}
            </div>
          )}
          {isSelected && (
            <div className="absolute inset-0 bg-shockingly-green/15 flex items-center justify-center">
              <div className="w-8 h-8 bg-shockingly-green rounded-full flex items-center justify-center">
                <svg className="w-5 h-5 text-just-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="p-2 bg-just-black">
        <h3 className="font-medium text-sm truncate text-surface-cream font-mori">{model.displayName}</h3>
        <p className="text-xs text-surface-50 font-mori">
          {live ? `${model.viewers} 观看` : checking ? '检查中...' : '离线'}
        </p>
      </div>
    </div>
  )
}

// memo：streamStatus 每次批量更新会触发列表重渲染，几百张卡里只有状态变化的
// 卡（zustand 选择器）需要重渲染；其余靠 memo + 稳定 props 跳过
export const ModelCard = memo(ModelCardInner)
