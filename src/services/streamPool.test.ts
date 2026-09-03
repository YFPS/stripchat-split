import { describe, it, expect } from 'vitest'
import { StreamPool } from './streamPool'

describe('StreamPool', () => {
  it('容量内放行，超额拒绝', () => {
    const pool = new StreamPool(2)
    expect(pool.request('a', true)).toBe(true)
    expect(pool.request('b', true)).toBe(true)
    expect(pool.request('c', true)).toBe(false)
    expect(pool.size()).toBe(2)
  })

  it('wanted=false 立即释放并返回 false', () => {
    const pool = new StreamPool(2)
    pool.request('a', true)
    expect(pool.request('a', false)).toBe(false)
    expect(pool.size()).toBe(0)
  })

  it('释放后通知等待者，被拒的 key 重新请求可获得空位', () => {
    const pool = new StreamPool(1)
    pool.request('a', true)
    expect(pool.request('b', true)).toBe(false)

    let notified = 0
    const off = pool.subscribe(() => {
      notified += 1
    })
    pool.release('a')
    expect(notified).toBe(1)
    expect(pool.request('b', true)).toBe(true)
    off()
  })

  it('已持有者重复请求不重复占位', () => {
    const pool = new StreamPool(1)
    pool.request('a', true)
    expect(pool.request('a', true)).toBe(true)
    expect(pool.size()).toBe(1)
  })

  it('取消订阅后不再收到通知', () => {
    const pool = new StreamPool(1)
    pool.request('a', true)
    let notified = 0
    const off = pool.subscribe(() => {
      notified += 1
    })
    off()
    pool.release('a')
    expect(notified).toBe(0)
  })

  it('setCapacity 调大后等待者获得空位（重竞争）', () => {
    const pool = new StreamPool(1)
    pool.request('a', true)
    expect(pool.request('b', true)).toBe(false) // 超额排队

    pool.setCapacity(2)
    // notify 后等待 key 重新请求即可拿到空位
    expect(pool.request('b', true)).toBe(true)
    expect(pool.size()).toBe(2)
    expect(pool.capacity).toBe(2)
  })

  it('setCapacity 调小不踢已持有者，只影响后续新申请', () => {
    const pool = new StreamPool(3)
    pool.request('a', true)
    pool.request('b', true)
    pool.request('c', true)

    pool.setCapacity(1)
    // 已持有的不被踢
    expect(pool.size()).toBe(3)
    // 释放一个后，新申请仍被容量挡在外面
    pool.release('c')
    expect(pool.request('d', true)).toBe(false)
  })

  it('setCapacity 钳制非法值与幂等', () => {
    const pool = new StreamPool(2)
    pool.setCapacity(0) // 下限 1
    expect(pool.capacity).toBe(1)
    pool.setCapacity(1) // 相同值：无通知、容量不变
    expect(pool.capacity).toBe(1)
  })
})
