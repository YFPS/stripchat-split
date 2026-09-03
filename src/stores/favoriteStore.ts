import { create } from 'zustand'
import { FavoriteModel } from '../types'
import { StreamStatus } from '../services/streamChecker'

interface FavoriteStore {
  favorites: FavoriteModel[]
  selectedModels: string[]
  loading: boolean
  error: string | null
  /**
   * 真实直播状态（cam 确认）：
   * - live: 有流，值为直播流数字 id（播放用）
   * - offline: 无流（离线/未开播/重试耗尽）
   * - checking: 尚未确认（在线主播待 cam 查询）
   */
  streamStatus: Record<string, StreamStatus>
  /** 卡片显示模式：true=视频流预览，false=封面图片 */
  videoPreview: boolean
  /**
   * 分屏是否打开。分屏是全屏覆盖层，但它底下的预览墙并没有卸载，
   * 而 IntersectionObserver 不感知遮挡（被盖住的卡片仍是 isIntersecting），
   * 不显式让位就会出现「分屏 N 路 + 预览墙 6 路」同时解码。
   */
  splitViewActive: boolean
  setFavorites: (favorites: FavoriteModel[]) => void
  setStreamStatus: (status: Record<string, StreamStatus>) => void
  toggleVideoPreview: () => void
  setSplitViewActive: (active: boolean) => void
  addFavorite: (model: FavoriteModel) => void
  removeFavorite: (modelId: string) => void
  toggleSelect: (modelId: string) => void
  selectAll: () => void
  deselectAll: () => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

export const useFavoriteStore = create<FavoriteStore>((set) => ({
  favorites: [],
  selectedModels: [],
  loading: false,
  error: null,
  streamStatus: {},
  videoPreview: true, // 默认视频流预览
  splitViewActive: false,
  setFavorites: (favorites) => set((state) => {
    // 新列表落库时补全状态：离线主播无需 cam 确认直接 offline；
    // 在线主播保留已确认结果，尚未确认的置为 checking。
    // 同时清理已不在列表里的旧状态与选中项，避免长期运行内存累积。
    const streamStatus = { ...state.streamStatus }
    const nextIds = new Set(favorites.map((m) => m.id))
    for (const id of Object.keys(streamStatus)) {
      if (!nextIds.has(id)) delete streamStatus[id]
    }
    favorites.forEach((m) => {
      if (streamStatus[m.id] === undefined) {
        streamStatus[m.id] = m.isOnline ? { phase: 'checking' } : { phase: 'offline' }
      }
    })
    const selectedModels = state.selectedModels.filter((id) => nextIds.has(id))
    return { favorites, selectedModels, loading: false, streamStatus }
  }),
  setStreamStatus: (status) => set((state) => ({
    streamStatus: { ...state.streamStatus, ...status }
  })),
  toggleVideoPreview: () => set((state) => ({ videoPreview: !state.videoPreview })),
  setSplitViewActive: (active) => set({ splitViewActive: active }),
  addFavorite: (model) => set((state) => ({
    favorites: [...state.favorites, model]
  })),
  removeFavorite: (modelId) => set((state) => ({
    favorites: state.favorites.filter(m => m.id !== modelId),
    selectedModels: state.selectedModels.filter(id => id !== modelId)
  })),
  toggleSelect: (modelId) => set((state) => ({
    selectedModels: state.selectedModels.includes(modelId)
      ? state.selectedModels.filter(id => id !== modelId)
      : [...state.selectedModels, modelId]
  })),
  // 全选在线 = 全选真实在直播的（cam 确认有流）
  selectAll: () => set((state) => ({
    selectedModels: state.favorites.filter((m) => state.streamStatus[m.id]?.phase === 'live').map((m) => m.id)
  })),
  deselectAll: () => set({ selectedModels: [] }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false })
}))
