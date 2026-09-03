import { describe, it, expect, beforeEach } from 'vitest'
import { useFavoriteStore } from './favoriteStore'
import { FavoriteModel } from '../types'

function model(id: string, isOnline = true): FavoriteModel {
  return {
    id,
    username: id,
    displayName: id,
    avatar: '',
    isOnline,
    viewers: 0,
    addedAt: 0
  }
}

/** zustand store 是模块级单例，每个用例前重置回初始状态 */
beforeEach(() => {
  useFavoriteStore.setState({
    favorites: [],
    selectedModels: [],
    loading: false,
    error: null,
    streamStatus: {},
    videoPreview: true,
    splitViewActive: false
  })
})

describe('favoriteStore', () => {
  it('setFavorites：离线主播直接 offline，在线主播置 checking', () => {
    const store = useFavoriteStore.getState()
    store.setFavorites([model('on', true), model('off', false)])

    const s = useFavoriteStore.getState()
    expect(s.favorites).toHaveLength(2)
    expect(s.streamStatus['on']).toEqual({ phase: 'checking' })
    expect(s.streamStatus['off']).toEqual({ phase: 'offline' })
    expect(s.loading).toBe(false)
  })

  it('setFavorites：保留已确认的 live/offline 结果，不回退成 checking', () => {
    const store = useFavoriteStore.getState()
    store.setFavorites([model('1', true)])
    store.setStreamStatus({ '1': { phase: 'live', id: '42' } })

    // 再次落库同一列表（如手动刷新），已确认状态必须保留
    store.setFavorites([model('1', true)])
    expect(useFavoriteStore.getState().streamStatus['1']).toEqual({ phase: 'live', id: '42' })
  })

  it('setFavorites：清理已不在列表里的旧状态与选中项（防内存累积）', () => {
    const store = useFavoriteStore.getState()
    store.setFavorites([model('1', true), model('2', true)])
    store.setStreamStatus({ '1': { phase: 'live', id: '9' }, '2': { phase: 'offline' } })
    store.toggleSelect('2')

    // 2 被移除后：其 streamStatus 与选中项都应被清掉
    store.setFavorites([model('1', true)])
    const s = useFavoriteStore.getState()
    expect(s.streamStatus['2']).toBeUndefined()
    expect(s.selectedModels).toEqual([])
    expect(s.streamStatus['1']).toEqual({ phase: 'live', id: '9' })
  })

  it('setStreamStatus：增量合并而非整表覆盖', () => {
    const store = useFavoriteStore.getState()
    store.setFavorites([model('1', true), model('2', true)])
    store.setStreamStatus({ '1': { phase: 'live', id: '7' } })
    store.setStreamStatus({ '2': { phase: 'offline' } })

    const s = useFavoriteStore.getState()
    expect(s.streamStatus['1']).toEqual({ phase: 'live', id: '7' })
    expect(s.streamStatus['2']).toEqual({ phase: 'offline' })
  })

  it('toggleSelect / deselectAll', () => {
    const store = useFavoriteStore.getState()
    store.setFavorites([model('1', true), model('2', true)])

    store.toggleSelect('1')
    expect(useFavoriteStore.getState().selectedModels).toEqual(['1'])
    store.toggleSelect('1')
    expect(useFavoriteStore.getState().selectedModels).toEqual([])
    store.toggleSelect('1')
    store.toggleSelect('2')
    expect(useFavoriteStore.getState().selectedModels).toEqual(['1', '2'])
    store.deselectAll()
    expect(useFavoriteStore.getState().selectedModels).toEqual([])
  })

  it('selectAll：只选 cam 确认在直播的（含流 id），不选 offline/checking', () => {
    const store = useFavoriteStore.getState()
    store.setFavorites([model('live1', true), model('offline1', true), model('checking1', true)])
    store.setStreamStatus({
      live1: { phase: 'live', id: '1' },
      offline1: { phase: 'offline' },
      checking1: { phase: 'checking' }
    })

    store.selectAll()
    expect(useFavoriteStore.getState().selectedModels).toEqual(['live1'])
  })

  it('videoPreview / splitViewActive 开关', () => {
    const store = useFavoriteStore.getState()
    expect(useFavoriteStore.getState().videoPreview).toBe(true)
    store.toggleVideoPreview()
    expect(useFavoriteStore.getState().videoPreview).toBe(false)

    expect(useFavoriteStore.getState().splitViewActive).toBe(false)
    store.setSplitViewActive(true)
    expect(useFavoriteStore.getState().splitViewActive).toBe(true)
  })

  it('setError 同时清掉 loading（错误不该卡住加载态）', () => {
    const store = useFavoriteStore.getState()
    store.setLoading(true)
    store.setError('boom')
    const s = useFavoriteStore.getState()
    expect(s.error).toBe('boom')
    expect(s.loading).toBe(false)
  })
})
