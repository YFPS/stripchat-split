import { useEffect, useState } from 'react'

// -webkit-app-region 不在标准 CSSProperties 里，类型断言兜底
const noDragStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

/** 窗口控制按钮组（最小化/最大化/关闭），供标题栏与分屏等全屏覆盖层复用 */
export const WindowControls: React.FC = () => {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // 订阅最大化状态变化，返回的取消订阅函数作为 effect 清理
    return window.electronAPI.windowControls.onMaximizedChange(setMaximized)
  }, [])

  return (
    <div className="flex h-full" style={noDragStyle}>
      <button
        onClick={() => window.electronAPI.windowControls.minimize()}
        title="最小化"
        className="w-11 h-full flex items-center justify-center text-surface-50 hover:bg-surface-25 hover:text-surface-cream transition-colors duration-150"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>

      <button
        onClick={() => window.electronAPI.windowControls.maximizeToggle()}
        title={maximized ? '还原' : '最大化'}
        className="w-11 h-full flex items-center justify-center text-surface-50 hover:bg-surface-25 hover:text-surface-cream transition-colors duration-150"
      >
        {maximized ? (
          // 还原：两个重叠方框
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M3.5 0.5 h6 v6 h-6 z" />
            <path d="M0.5 3.5 v6 h6 v-6 z" />
          </svg>
        ) : (
          // 最大化：单个方框
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>

      <button
        onClick={() => window.electronAPI.windowControls.close()}
        title="关闭"
        className="w-11 h-full flex items-center justify-center text-surface-50 hover:bg-red-900/60 hover:text-surface-cream transition-colors duration-150"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1">
          <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" />
          <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" />
        </svg>
      </button>
    </div>
  )
}
