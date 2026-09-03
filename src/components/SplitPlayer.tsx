import React, { useEffect, useMemo, useState } from 'react'
import { Model, LayoutConfig } from '../types'
import { StripchatPlayer } from './StripchatPlayer'
import { WindowControls } from './WindowControls'
import { useModelStream } from '../hooks/useModelStream'
import { useFavoriteStore } from '../stores/favoriteStore'

// -webkit-app-region 不在标准 CSSProperties 里，类型断言兜底
const noDragStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties
const dragStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties

/**
 * 分屏清晰度策略（CPU 安全的两道闸之一）：
 * 分屏每格默认全画质（ABR 自动 + capLevelToPlayerSize 按格子实际尺寸限档），
 * 路数超过 SPLIT_FULL_QUALITY_LIMIT 后自动把每格降为最低档解码
 * （240p 约 2–4% 核，见 previewBudget.ts 调研注释）。
 * 视觉上：路数越多每格越小，低档位损失人眼几乎不可感，换来不掉帧、不崩。
 * 数量的第二道闸见下方 MAX_SPLIT_CELLS。
 */
export const SPLIT_FULL_QUALITY_LIMIT = 9

/**
 * 分屏格数硬上限。`SPLIT_FULL_QUALITY_LIMIT` 只负责降清晰度、不砍数量，
 * 而「全选在线」在有上百个直播收藏时会一次性选中上百路 —— 即便每路锁最低档，
 * 上百个 hls 实例各自的 Worker、缓冲和软解线程也足以把客户端拖死。
 * 超出的部分不渲染，并在顶栏明确告知被截断了多少路（不静默丢弃）。
 */
export const MAX_SPLIT_CELLS = 16

interface SplitPlayerProps {
  models: Model[]
  onClose: () => void
}

function calculateLayout(count: number): LayoutConfig {
  if (count <= 0) return { cols: 1, rows: 1 }
  if (count === 1) return { cols: 1, rows: 1 }
  if (count === 2) return { cols: 2, rows: 1 }
  if (count === 3) return { cols: 2, rows: 2 }
  if (count === 4) return { cols: 2, rows: 2 }
  if (count <= 6) return { cols: 3, rows: 2 }
  if (count <= 9) return { cols: 3, rows: 3 }
  // 超出 9 路：正方形网格逼近（12→4×3，16→4×4，25→5×5 …），
  // 格数越多格子越小，每格内容仍完整可看
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  return { cols, rows }
}

/**
 * 单个分屏格子：只信收藏墙已确认的 live（预览墙刚探测过，避免分屏
 * 再对几十路重复发探测请求）；checking / 未知 / offline 都走 useModelStream
 * 实时复核 —— store 的 offline 可能是查询失败被误标的（StreamChecker 重试
 * 耗尽即判离线，而每 90s 只抽查 3 个离线主播翻案），用户既然把格子打开了，
 * 值得为这一路再确认一次，而不是直接显示"未开播"。
 *
 * 关键设计：播放器才是真相源。后台探测说"没流"而播放器明明还在解码时，
 * 绝不能用探测结果撤掉正在播的画面（官方网页也不会这么做）——复核期间
 * 继续播旧流，复核也确认无流才显示"未开播"。整个组件始终渲染同一个
 * SplitCellView，store 翻牌时 StripchatPlayer 不卸载不重挂，画面零中断。
 */
const SplitCell: React.FC<{ model: Model; lowQuality: boolean }> = ({ model, lowQuality }) => {
  const storeStatus = useFavoriteStore((s) => s.streamStatus[model.id])
  const storeLiveId = storeStatus?.phase === 'live' ? storeStatus.id : null
  const setStreamStatus = useFavoriteStore((s) => s.setStreamStatus)

  // 复核期间持有的旧流 id：store live 时同步为最新；复核出结果时更新
  // （live→新 id，offline→清空）。checking 期间继续持有旧流，画面不被
  // 探测结果打断；自愈复核时 heldId 已是 null，不会反复闪挂死流。
  const [heldId, setHeldId] = useState<string | null>(storeLiveId)
  const [refreshKey, setRefreshKey] = useState(0)
  const probing = !storeLiveId
  const probe = useModelStream({ id: model.id, username: model.username }, refreshKey, probing)

  useEffect(() => {
    if (storeLiveId) setHeldId(storeLiveId)
  }, [storeLiveId])

  // 复核出结果：更新持有的流 id + 回写 store（纠正误标 offline、让预览墙
  // /下次分屏直接受益）。不会与 StreamChecker 打架 —— checker 只查 checking
  // 状态的目标。
  useEffect(() => {
    if (!probing || probe.phase === 'checking') return
    setHeldId(probe.phase === 'live' ? probe.id : null)
    setStreamStatus({ [model.id]: probe })
  }, [probing, probe, model.id, setStreamStatus])

  // offline 自愈：探测判"未开播"后每 30s 自动复核一次。CDN 窗口期误报 /
  // 主播刚开播的缓存延迟都能在下轮翻回来，不会永久定格在"未开播"。
  useEffect(() => {
    if (!probing || probe.phase !== 'offline') return
    const t = setTimeout(() => setRefreshKey((k) => k + 1), 30000)
    return () => clearTimeout(t)
  }, [probe, probing])

  const streamId = storeLiveId ?? (probe.phase === 'live' ? probe.id : probe.phase === 'checking' ? heldId : null)
  const checking = probing && probe.phase === 'checking' && !heldId
  return <SplitCellView model={model} streamId={streamId} lowQuality={lowQuality} checking={checking} />
}

/** 纯渲染：直播格子出视频流；未开播/检查中出占位 + 主播名覆盖层 */
const SplitCellView: React.FC<{
  model: Model
  streamId: string | null
  lowQuality: boolean
  checking: boolean
}> = ({ model, streamId, lowQuality, checking }) => {
  return (
    <div className="relative w-full h-full bg-just-black rounded-card overflow-hidden">
      {streamId ? (
        // lowQuality=true（路数超阈值）时锁最低档解码省 CPU；每格仍可手动切高清
        <StripchatPlayer id={streamId} fallbackImage={model.avatar} preview={lowQuality} />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center text-center px-4">
          <p className="text-surface-cream text-sm font-medium mb-1 font-mori">
            {checking ? '检查直播状态...' : '该主播当前未开播'}
          </p>
          <p className="text-surface-50 text-xs font-mori">{model.displayName}</p>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-just-black/80 p-2">
        <p className="text-surface-cream text-xs truncate pr-16 font-mori">{model.displayName}</p>
        <p className="text-surface-50 text-xs pr-16 font-mori">
          {streamId ? `${model.viewers} 观看` : '未开播'}
        </p>
      </div>
    </div>
  )
}

export const SplitPlayer: React.FC<SplitPlayerProps> = ({ models, onClose }) => {
  const cells = useMemo(() => models.slice(0, MAX_SPLIT_CELLS), [models])
  const overflow = models.length - cells.length
  const layout = useMemo(() => calculateLayout(cells.length), [cells.length])
  const lowQuality = cells.length > SPLIT_FULL_QUALITY_LIMIT

  return (
    // 整个分屏是覆盖在标题栏（-webkit-app-region: drag）之上的全屏层，
    // 根节点必须显式 no-drag，否则 Electron 会把该区域的点击当窗口拖拽吞掉
    // （按钮点不了、格子交互失效）。
    <div className="fixed inset-0 bg-just-black z-50 flex flex-col" style={noDragStyle}>
      {/*
        顶栏 = 拖动条：分屏全屏层盖住了系统标题栏，窗口要移动只能靠这条顶栏。
        整条设为 drag 区域，可交互子元素（关闭按钮 / WindowControls）单独 no-drag。
        注意：-webkit-app-region: drag 区域的子元素必须显式 no-drag 才能收到点击。
      */}
      <div
        className="flex items-center justify-between px-6 py-3 bg-off-black select-none cursor-grab active:cursor-grabbing"
        style={dragStyle}
      >
        {/* 左侧：curly-bracket annotation + 分类色标签 */}
        <div className="flex items-center gap-4 shrink-0">
          <span className="text-[14px] text-surface-50 font-mori tracking-[-0.01em]">
            {'{ '}
          </span>
          <h2 className="text-[19px] font-normal text-lilac font-mori tracking-[-0.01em]">
            Split View
          </h2>
          <span className="text-[14px] text-surface-50 font-mori tracking-[-0.01em]">
            {' }'}
          </span>
          <span className="text-[14px] text-surface-cream font-mori">
            {cells.length} 路
          </span>

          {/* 警告：小号分类色文字 */}
          {overflow > 0 && (
            <span
              className="text-[13px] text-orangey font-mori"
              title={`一次最多同时解码 ${MAX_SPLIT_CELLS} 路，请取消部分选择后重开分屏`}
            >
              {overflow} 路被截断
            </span>
          )}
          {lowQuality && (
            <span
              className="text-[13px] text-orangey font-mori"
              title={`超过 ${SPLIT_FULL_QUALITY_LIMIT} 路后自动以最低清晰度解码以保护 CPU；每格右下角仍可手动切回高清`}
            >
              低清晰度
            </span>
          )}
        </div>

        {/* 右侧：幽灵 pill 关闭按钮 + 窗口控制 */}
        <div className="flex items-center gap-3 shrink-0" style={noDragStyle}>
          <button
            onClick={onClose}
            className="btn-ghost-sm font-mori"
          >
            关闭分屏
          </button>
          <div className="w-px h-4 bg-surface-25" />
          <WindowControls />
        </div>
      </div>

      {/* hairline divider */}
      <div className="h-px bg-surface-25 w-full shrink-0" />

      <div
        className="flex-1 min-h-0 grid gap-1 p-1"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`
        }}
      >
        {cells.map((model) => (
          <SplitCell key={model.id} model={model} lowQuality={lowQuality} />
        ))}
      </div>
    </div>
  )
}
