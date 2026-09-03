import { useEffect } from 'react'
import { useFavoriteStore } from '../stores/favoriteStore'
import { favoriteService } from '../services/favoriteService'

/**
 * 收藏数据编排的挂载点：在整个应用里只应被调用一次（MainRoute 顶部）。
 * 内部委托 favoriteService 单例：启动拉取、把快照喂给 StreamChecker、
 * 周期复查已确认 live 的主播。重复调用是幂等的（service.start 有守卫）。
 *
 * 之前的问题：这些副作用长在 useFavorites 里，而 useFavorites 被 App 和
 * FavoriteList 各调一次 → 收藏列表拉两遍、每个在线主播的 cam 查询发两遍。
 * 副作用收敛到单例后，useFavorites 变成纯选择器，可以被任意多处使用。
 */
export function useFavoritesSync(): void {
  useEffect(() => favoriteService.start(), [])
}

/**
 * 收藏列表的只读视图 + action 转发（无副作用，可被任意多个组件使用）。
 */
export function useFavorites() {
  const favorites = useFavoriteStore((s) => s.favorites)
  const streamStatus = useFavoriteStore((s) => s.streamStatus)
  const loading = useFavoriteStore((s) => s.loading)
  const selectedModels = useFavoriteStore((s) => s.selectedModels)
  const error = useFavoriteStore((s) => s.error)
  const videoPreview = useFavoriteStore((s) => s.videoPreview)
  const toggleSelect = useFavoriteStore((s) => s.toggleSelect)
  const selectAll = useFavoriteStore((s) => s.selectAll)
  const deselectAll = useFavoriteStore((s) => s.deselectAll)
  const toggleVideoPreview = useFavoriteStore((s) => s.toggleVideoPreview)

  return {
    favorites,
    selectedModels,
    streamStatus,
    videoPreview,
    loading,
    error,
    fetchFavorites: () => favoriteService.fetchFavorites(),
    refreshStatus: () => favoriteService.refreshStatus(),
    toggleVideoPreview,
    toggleSelect,
    selectAll,
    deselectAll
  }
}
