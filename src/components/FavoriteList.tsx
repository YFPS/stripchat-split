import React, { useMemo } from 'react'
import { ModelCard } from './ModelCard'
import { useFavorites } from '../hooks/useFavorites'

interface FavoriteListProps {
  onStartSplitView: () => void
}

export const FavoriteList: React.FC<FavoriteListProps> = ({ onStartSplitView }) => {
  const {
    favorites,
    selectedModels,
    streamStatus,
    videoPreview,
    loading,
    error,
    fetchFavorites,
    refreshStatus,
    toggleVideoPreview,
    toggleSelect,
    selectAll,
    deselectAll
  } = useFavorites()

  // 按真实直播状态分组（cam 确认有流才算"正在直播"，favorites 接口的
  // isOnline 不可靠，offline 列表里也混着 isOnline=true 但实际没直播的）
  const liveFavorites = favorites.filter(m => streamStatus[m.id]?.phase === 'live')
  const offlineFavorites = favorites.filter(m => streamStatus[m.id]?.phase !== 'live')

  // 选中集合：把 O(n·m) 的 includes 判断换成 Set 查找
  const selectedSet = useMemo(() => new Set(selectedModels), [selectedModels])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-shockingly-green" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-orangey mb-4 font-mori">{error}</p>
        <button
          onClick={fetchFavorites}
          className="btn-ghost-sm font-mori"
        >
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-10">
      {/* 工具栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-[34px] font-semibold text-surface-cream tracking-[-0.34px] leading-[1.2] font-mori">
          <span className="text-surface-50">{'{ '}</span>
          我的收藏
          <span className="text-surface-50">{ ' }'}</span>
          <span className="text-[16px] font-normal text-surface-50 ml-3 tracking-[-0.01em]">
            {liveFavorites.length} 直播中 / {favorites.length} 总计
          </span>
        </h2>
        <div className="flex gap-2">
          <button
            onClick={toggleVideoPreview}
            title={videoPreview ? '切换为封面图片显示' : '切换为视频流预览'}
            className="btn-ghost-sm font-mori"
          >
            {videoPreview ? '封面显示' : '视频预览'}
          </button>
          <button
            onClick={refreshStatus}
            className="btn-ghost-sm font-mori"
          >
            刷新状态
          </button>
          <button
            onClick={selectAll}
            className="btn-ghost-sm font-mori"
          >
            全选在线
          </button>
          <button
            onClick={deselectAll}
            className="btn-ghost-sm font-mori"
          >
            取消全选
          </button>
          {selectedModels.length > 0 && (
            <button
              onClick={onStartSplitView}
              title={`分屏 ${selectedModels.length} 个主播；超过 9 路自动切低清晰度以保护 CPU，每格仍可手动切高清`}
              className="btn-cta font-mori"
            >
              分屏观看 ({selectedModels.length})
            </button>
          )}
        </div>
      </div>

      {/* 正在直播 */}
      {liveFavorites.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <span className="text-[19px] font-normal text-pink font-mori">直播中</span>
            <span className="text-[14px] text-surface-50 font-mori">{'{ ' + liveFavorites.length + ' }'}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {liveFavorites.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                isSelected={selectedSet.has(model.id)}
                onToggleSelect={toggleSelect}
                videoEnabled={videoPreview}
              />
            ))}
          </div>
        </section>
      )}

      {/* hairline divider */}
      {liveFavorites.length > 0 && offlineFavorites.length > 0 && (
        <div className="h-px bg-surface-25 w-full" />
      )}

      {/* 离线 */}
      {offlineFavorites.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <span className="text-[19px] font-normal text-surface-50 font-mori">离线</span>
            <span className="text-[14px] text-surface-50 font-mori">{'{ ' + offlineFavorites.length + ' }'}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 opacity-60">
            {offlineFavorites.map(model => (
              <ModelCard
                key={model.id}
                model={model}
                isSelected={selectedSet.has(model.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        </section>
      )}

      {/* 空状态 */}
      {favorites.length === 0 && (
        <div className="text-center py-20">
          <p className="text-[23px] text-surface-50 mb-2 font-mori tracking-[-0.23px]">
            <span className="text-surface-50">{'{ '}</span>
            暂无收藏的主播
            <span className="text-surface-50">{ ' }'}</span>
          </p>
          <p className="text-[16px] text-surface-50 font-mori">登录后在网站上添加收藏，然后点击刷新</p>
        </div>
      )}
    </div>
  )
}
