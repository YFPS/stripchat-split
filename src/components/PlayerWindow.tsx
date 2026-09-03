import React from 'react'
import { StripchatPlayer } from './StripchatPlayer'
import { WindowControls } from './WindowControls'
import { useModelStream } from '../hooks/useModelStream'

// -webkit-app-region 不在标准 CSSProperties 里，类型断言兜底
const dragStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties

/**
 * 独立播放器窗口页（双击卡片打开，经 hash 路由 #/player?username=… 加载）。
 * 布局：自定义标题栏（主播名 + 窗口控制）+ 全屏直播画面。
 */
export const PlayerWindow: React.FC = () => {
  // 解析 hash query：#/player?username=xx&id=123&displayName=yy&avatar=zz
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const username = params.get('username') ?? ''
  const id = params.get('id') ?? undefined
  const displayName = params.get('displayName') ?? username
  const avatar = params.get('avatar') ?? ''

  const status = useModelStream({ id, username })
  const streamId = status.phase === 'live' ? status.id : null
  const checking = status.phase === 'checking'

  return (
    <div className="h-screen flex flex-col bg-just-black overflow-hidden">
      {/* 自定义标题栏：主播名 + 窗口控制 */}
      <div
        className="h-9 shrink-0 flex items-center bg-just-black select-none"
        style={dragStyle}
      >
        <div className="flex items-center gap-2 px-3 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full bg-shockingly-green shrink-0" />
          <span className="text-surface-cream text-xs font-medium tracking-wide truncate font-mori">
            {displayName}
          </span>
        </div>
        <div className="flex-1" />
        <WindowControls />
      </div>

      {/* hairline divider */}
      <div className="h-px bg-surface-25 w-full shrink-0" />

      <div className="flex-1 min-h-0 relative bg-just-black">
        {streamId ? (
          <StripchatPlayer id={streamId} fallbackImage={avatar} />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-center px-4">
            <p className="text-surface-cream text-sm font-medium mb-1 font-mori">
              {checking ? '检查直播状态...' : '该主播当前未开播'}
            </p>
            <p className="text-surface-50 text-xs font-mori">{displayName}</p>
          </div>
        )}
      </div>
    </div>
  )
}
