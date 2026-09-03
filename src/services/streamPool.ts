type Listener = () => void

/**
 * 全局视频解码器配额池：同时真正解码的 hls 实例数封顶。
 * 预览墙里的卡片经 useStreamSlot 申请/释放槽位；滚出视口的卡片释放槽位，
 * 被拒绝的卡片订阅变动，待空位出现时竞争。
 * 分屏与独立播放器窗口不走配额 —— 它们是用户显式打开的全质量播放。
 */
export class StreamPool {
  private granted = new Map<string, true>()
  /** 申请过但当前因容量满被拒绝的 key（等待空位） */
  private waiting = new Set<string>()
  /** 全局监听器（旧接口，无 key 时 release 也会通知） */
  private listeners = new Set<Listener>()
  /** 按 key 的监听器：只通知真正在等待该 key 的卡片，避免每次释放唤醒全部卡片 */
  private keyListeners = new Map<string, Set<Listener>>()
  /** 当前容量（初始值来自构造参数；可视卡片数变化时由外部动态调大/调小） */
  private _capacity: number

  constructor(capacity: number) {
    this._capacity = capacity
  }

  /** 当前容量 */
  get capacity(): number {
    return this._capacity
  }

  /**
   * 动态调整容量。调大时通知等待者（空位出现，重新竞争）；调小时不踢已持有者
   * （只在它们主动释放后自然收缩）——避免滚动瞬间容量震荡导致视频反复挂/卸。
   */
  setCapacity(next: number): void {
    const clamped = Math.max(1, Math.floor(next))
    if (clamped === this._capacity) return
    const grew = clamped > this._capacity
    this._capacity = clamped
    if (grew) this.notify()
  }

  /** 申请或维持配额：wanted=false 时立即释放并返回 false；额度满时拒绝 */
  request(key: string, wanted: boolean): boolean {
    if (!wanted) {
      this.release(key)
      this.waiting.delete(key)
      return false
    }
    if (this.granted.has(key)) {
      this.waiting.delete(key)
      return true
    }
    if (this.granted.size >= this._capacity) {
      this.waiting.add(key)
      return false
    }
    this.granted.set(key, true)
    this.waiting.delete(key)
    return true
  }

  /** 释放配额；若有等待者则通知它们竞争空位 */
  release(key: string): void {
    // 无论是否真的持有配额都要清 waiting：卡片可能在"排队"状态下直接卸载，
    // 只走 release 而不走 request(key, false)，残留的 key 会让 notify 一直遍历僵尸项
    this.waiting.delete(key)
    if (this.granted.delete(key)) this.notify()
  }

  /**
   * 订阅配额变动（释放时通知）；返回取消订阅函数。
   * 传 key 时只在该 key 处于等待状态时通知（推荐卡片使用）；
   * 不传 key 保持旧的全局通知语义（测试/兼容用）。
   */
  subscribe(listener: Listener, key?: string): () => void {
    if (key) {
      let set = this.keyListeners.get(key)
      if (!set) {
        set = new Set()
        this.keyListeners.set(key, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) this.keyListeners.delete(key)
      }
    }

    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  size(): number {
    return this.granted.size
  }

  private notify(): void {
    // 兼容旧接口：全局订阅者每次都通知
    this.listeners.forEach((l) => l())

    // key 订阅者只通知正在等待的 key
    if (this.waiting.size === 0) return
    const waitingKeys = [...this.waiting]
    for (const key of waitingKeys) {
      const set = this.keyListeners.get(key)
      if (set) set.forEach((l) => l())
    }
  }
}

/**
 * 预览墙全局配额池。容量不再固定：由 previewBudget 按「可视范围内直播卡数量」
 * 动态调整（可视多少张就放行多少路解码），这里的初始值只是首帧渲染前的兜底。
 * 分屏与独立播放器窗口不走本配额，但它们打开时预览墙会整体让位（见 ModelCard）。
 */
export const INITIAL_PREVIEW_CAPACITY = 4
export const previewStreamPool = new StreamPool(INITIAL_PREVIEW_CAPACITY)
