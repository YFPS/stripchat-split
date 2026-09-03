import { useCallback, useMemo, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { LoginStatus } from './components/LoginStatus'
import { FavoriteList } from './components/FavoriteList'
import { SplitPlayer } from './components/SplitPlayer'
import { PlayerWindow } from './components/PlayerWindow'
import { useFavoritesSync } from './hooks/useFavorites'
import { useFavoriteStore } from './stores/favoriteStore'
import { ErrorBoundary } from './components/ErrorBoundary'

/**
 * 主窗口内容。useFavoritesSync 在这里挂载一次 —— 它是全应用唯一的副作用入口
 * （启动拉取 + 把快照喂给 StreamChecker 单例）。
 */
function MainRoute() {
  useFavoritesSync()

  const [showSplitView, setShowSplitView] = useState(false)
  const favorites = useFavoriteStore((s) => s.favorites)
  const selectedModels = useFavoriteStore((s) => s.selectedModels)
  const setSplitViewActive = useFavoriteStore((s) => s.setSplitViewActive)
  const deselectAll = useFavoriteStore((s) => s.deselectAll)

  // Set 查找替代 O(n·m) 的 includes 过滤
  const selectedSet = useMemo(() => new Set(selectedModels), [selectedModels])
  const selectedModelObjects = useMemo(
    () => favorites.filter((m) => selectedSet.has(m.id)),
    [favorites, selectedSet]
  )

  // 开关分屏时同步告知 store：预览墙据此整体让出解码配额
  const openSplitView = useCallback(() => {
    setSplitViewActive(true)
    setShowSplitView(true)
  }, [setSplitViewActive])

  const closeSplitView = useCallback(() => {
    setSplitViewActive(false)
    setShowSplitView(false)
    // 选择状态是粘性的（跨收藏刷新/分组变动都保留），看完分屏不清掉的话，
    // 下次再选人开分屏会把上次选过的主播一起带进来 —— 表现为"出现没选的主播"。
    deselectAll()
  }, [setSplitViewActive, deselectAll])

  return (
    <div className="h-screen flex flex-col bg-just-black overflow-hidden">
      {/* 分屏打开时由 SplitPlayer 自带窗口控制，避免 TitleBar 重复订阅 IPC */}
      {!showSplitView && <TitleBar />}

      {/* 顶部分隔线（GSAP hairline divider） */}
      <div className="h-px bg-surface-25 w-full shrink-0" />

      <header className="py-4 px-6">
        <div className="max-w-[1280px] mx-auto flex items-center justify-between">
          <h1 className="text-[23px] font-semibold text-surface-cream tracking-[-0.23px] font-mori">
            <span className="text-surface-50">{'{ '}</span>
            <span className="text-shockingly-green">Stripchat</span>
            <span className="text-surface-cream"> Split</span>
            <span className="text-surface-50">{ ' }'}</span>
          </h1>
          <LoginStatus />
        </div>
      </header>

      {/* hairline divider */}
      <div className="h-px bg-surface-25 w-full" />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[1280px] w-full mx-auto px-6 py-10">
          <FavoriteList onStartSplitView={openSplitView} />
        </div>
      </main>

      {showSplitView && selectedModelObjects.length > 0 && (
        <SplitPlayer models={selectedModelObjects} onClose={closeSplitView} />
      )}
    </div>
  )
}

/**
 * 播放器窗口页（双击卡片打开）：#/player?username=… 只渲染独立播放器。
 *
 * 拆成独立路由组件而不是在 MainRoute 里提前 return —— 后者会让
 * useState/useMemo/useFavorites 变成条件 Hook（原先的写法），
 * 一旦判断依据变成可变的就会直接崩在 Hook 顺序错乱上。
 */
function PlayerRoute() {
  return <PlayerWindow />
}

export default function App() {
  const [isPlayerWindow] = useState(() => window.location.hash.startsWith('#/player'))

  return (
    <ErrorBoundary>
      {isPlayerWindow ? <PlayerRoute /> : <MainRoute />}
    </ErrorBoundary>
  )
}
