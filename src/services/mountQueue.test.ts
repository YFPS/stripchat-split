import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONCURRENT_MOUNTS, HOLD_MS, __resetForTest, enqueueMount } from './mountQueue'

beforeEach(() => {
  __resetForTest()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('enqueueMount', () => {
  it('队列空闲时同步放行，不产生延迟', () => {
    let started = false
    enqueueMount(() => {
      started = true
    })
    expect(started).toBe(true)
  })

  it('名额满时排队，启动窗口到期后放行下一批', () => {
    const started: number[] = []
    for (let i = 0; i < CONCURRENT_MOUNTS + 3; i++) {
      enqueueMount(() => started.push(i))
    }
    // 首批同步放行 CONCURRENT_MOUNTS 路，其余排队
    expect(started).toEqual([0, 1, 2, 3])
    vi.advanceTimersByTime(HOLD_MS)
    // 一个窗口到期后，剩下的 3 路全部放行
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('排队期间撤销：不再放行', () => {
    const started: number[] = []
    const revokes: Array<() => void> = []
    for (let i = 0; i < CONCURRENT_MOUNTS + 2; i++) {
      revokes.push(enqueueMount(() => started.push(i)))
    }
    // 撤销还在排队的队尾一路
    revokes[CONCURRENT_MOUNTS + 1]()
    vi.advanceTimersByTime(HOLD_MS)
    vi.advanceTimersByTime(HOLD_MS)
    expect(started).toEqual([0, 1, 2, 3, 4])
  })

  it('已放行后调用撤销是无害的空操作', () => {
    let count = 0
    const revoke = enqueueMount(() => {
      count++
    })
    revoke()
    expect(count).toBe(1)
    vi.advanceTimersByTime(HOLD_MS * 3)
    expect(count).toBe(1)
  })

  it('启动窗口到期后名额释放，稳态滚动零延迟', () => {
    // 首批放行并等窗口过期，名额全部释放
    enqueueMount(() => {})
    vi.advanceTimersByTime(HOLD_MS)
    // 此时再来一路：应同步放行（不排队）
    let started = false
    enqueueMount(() => {
      started = true
    })
    expect(started).toBe(true)
  })
})
