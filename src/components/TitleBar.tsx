import { WindowControls } from './WindowControls'

// -webkit-app-region 不在标准 CSSProperties 里，类型断言兜底
const dragStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties

/** 自定义标题栏：替代系统标题栏（frame:false），支持拖拽与最小化/最大化/关闭 */
export const TitleBar: React.FC = () => {
  return (
    <div
      className="h-9 shrink-0 flex items-center bg-just-black select-none"
      style={dragStyle}
    >
      {/* 左侧应用标识 */}
      <div className="flex items-center gap-2 px-3">
        <span className="w-2.5 h-2.5 rounded-full bg-shockingly-green" />
        <span className="text-surface-cream text-xs font-medium tracking-wide font-mori">
          Stripchat Split
        </span>
      </div>

      <div className="flex-1" />

      {/* 窗口控制按钮（Windows 风格 44px 宽） */}
      <WindowControls />
    </div>
  )
}
