import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamChecker, StreamStatus } from './streamChecker'
import { FavoriteModel } from '../types'

function model(id: string, username: string, isOnline = true): FavoriteModel {
  return {
    id,
    username,
    displayName: username,
    avatar: '',
    isOnline,
    viewers: 0,
    addedAt: 0
  }
}

function statuses(entries: Record<string, StreamStatus>): Record<string, StreamStatus> {
  return entries
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** 推进假时钟并空转微任务，让批处理 / onUpdate / finally-kick 链跑完 */
async function flush(ms = 0) {
  if (ms > 0) await vi.advanceTimersByTimeAsync(ms)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('StreamChecker', () => {
  it('批量确认：有流→live，无流→offline，且只查 checking 状态的目标', async () => {
    const fetch = vi.fn(async (m: FavoriteModel) => (m.username === 'u1' ? '101' : null))
    const updates: Record<string, StreamStatus>[] = []
    const checker = new StreamChecker({ fetchStreamId: fetch, onUpdate: (s) => updates.push(s) })

    const models = [model('1', 'u1'), model('2', 'u2'), model('3', 'u3', false)]
    checker.syncTargets(models, statuses({
      '1': { phase: 'checking' },
      '2': { phase: 'checking' },
      '3': { phase: 'checking' }
    }))
    await flush()

    // 离线主播不查询（isOnline=false 直接离线）
    expect(fetch.mock.calls.map((c) => c[0].username)).toEqual(['u1', 'u2'])
    const merged = Object.assign({}, ...updates)
    expect(merged['1']).toEqual({ phase: 'live', id: '101' })
    expect(merged['2']).toEqual({ phase: 'offline' })
  })

  it('已确认（live/offline）的目标不再重复查询', async () => {
    const fetch = vi.fn(async () => '101')
    const checker = new StreamChecker({ fetchStreamId: fetch, onUpdate: () => {} })

    checker.syncTargets(
      [model('1', 'u1'), model('2', 'u2')],
      statuses({ '1': { phase: 'live', id: '9' }, '2': { phase: 'checking' } })
    )
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ username: 'u2' }))
  })

  it('重复 syncTargets 去重：同一主播在途时不重复发起', async () => {
    let release!: (v: string | null) => void
    const fetch = vi.fn(() => new Promise<string | null>((res) => { release = res }))
    const checker = new StreamChecker({ fetchStreamId: fetch, onUpdate: () => {} })

    checker.syncTargets([model('1', 'u1')], statuses({ '1': { phase: 'checking' } }))
    checker.syncTargets([model('1', 'u1')], statuses({ '1': { phase: 'checking' } }))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    release('7')
    await flush()
  })

  it('查询失败按退避重试，成功后被标记为 live', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('net down'))
      .mockResolvedValueOnce('123')
    const updates: Record<string, StreamStatus>[] = []
    const checker = new StreamChecker({
      fetchStreamId: fetch,
      retryDelays: [5000, 5000], // 最多 2 次尝试
      onUpdate: (s) => updates.push(s)
    })

    checker.syncTargets([model('1', 'u1')], statuses({ '1': { phase: 'checking' } }))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    // 第一轮失败后不应立刻标记离线（等待重试）
    expect(Object.assign({}, ...updates)['1']).toBeUndefined()

    await flush(5000) // 到达重试时间
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(Object.assign({}, ...updates)['1']).toEqual({ phase: 'live', id: '123' })
  })

  it('重试耗尽后标记为 offline（不再永远"检查中"）', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('net down'))
    const updates: Record<string, StreamStatus>[] = []
    const checker = new StreamChecker({
      fetchStreamId: fetch,
      retryDelays: [1000, 1000], // 最多 2 次尝试
      onUpdate: (s) => updates.push(s)
    })

    checker.syncTargets([model('1', 'u1')], statuses({ '1': { phase: 'checking' } }))
    await flush()
    await flush(1000)
    await flush(1000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(Object.assign({}, ...updates)['1']).toEqual({ phase: 'offline' })
  })

  it('reset 清空重试计划：刷新后不再触发旧重试', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('net down'))
    const checker = new StreamChecker({ fetchStreamId: fetch, retryDelays: [5000], onUpdate: () => {} })

    checker.syncTargets([model('1', 'u1')], statuses({ '1': { phase: 'checking' } }))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    checker.reset()
    await flush(5000)
    await flush(5000)
    // reset 后不再有自动重试
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('dispose 后 syncTargets 不再工作', async () => {
    const fetch = vi.fn(async () => '101')
    const checker = new StreamChecker({ fetchStreamId: fetch, onUpdate: () => {} })

    checker.dispose()
    checker.syncTargets([model('1', 'u1')], statuses({ '1': { phase: 'checking' } }))
    await flush()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('invalidate：周期复查把 live 置回 checking 后，invalidate 解除 settled 去重并重查', async () => {
    const fetch = vi.fn(async () => '101')
    const checker = new StreamChecker({ fetchStreamId: fetch, onUpdate: () => {} })

    // 第一轮：确认 live
    checker.syncTargets([model('1', 'u1')], statuses({ '1': { phase: 'checking' } }))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    // 外部把 live 置回 checking（周期复查场景），但 settled 去重仍会拦住
    checker.syncTargets([model('1', 'u1')], statuses({ '1': { phase: 'checking' } }))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    // invalidate 解除 settled → kick 立即重查
    checker.invalidate(['1'])
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)

    checker.dispose()
  })

  it('invalidate 未命中任何 settled id 时不触发重查（无副作用）', async () => {
    const fetch = vi.fn(async () => '101')
    const checker = new StreamChecker({ fetchStreamId: fetch, onUpdate: () => {} })

    checker.syncTargets([model('1', 'u1')], statuses({ '1': { phase: 'checking' } }))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    // 不存在的 id / 从未查询过的 id
    checker.invalidate(['nonexistent'])
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    checker.dispose()
  })

  it('dispose 后 invalidate 是空操作', async () => {
    const fetch = vi.fn(async () => '101')
    const checker = new StreamChecker({ fetchStreamId: fetch, onUpdate: () => {} })

    checker.syncTargets([model('1', 'u1')], statuses({ '1': { phase: 'checking' } }))
    await flush()
    checker.dispose()

    checker.invalidate(['1'])
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
