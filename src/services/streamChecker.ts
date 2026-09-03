import { FavoriteModel } from '../types'

/**
 * 直播状态三态：显式判别联合，替代原先 Record<string, string | null | undefined>
 * 的隐式约定（undefined=检查中 / null=离线 / string=直播 id）。
 */
export type StreamStatus =
  | { phase: 'checking' }
  | { phase: 'offline' }
  | { phase: 'live'; id: string }

export function isLiveStatus(s: StreamStatus | undefined): s is { phase: 'live'; id: string } {
  return s?.phase === 'live'
}

interface RetryPlan {
  attempts: number
  nextRetryAt: number
}

export interface StreamCheckerOptions {
  /** 单主播直播状态探测：失败必须 reject（否则重试计划永不生效） */
  fetchStreamId(model: FavoriteModel): Promise<string | null>
  /** 并发批大小，默认 8（700+ 收藏时避免打爆网络） */
  concurrency?: number
  /** 重试退避间隔序列，长度即最大尝试次数，默认 [5s, 15s, 45s] */
  retryDelays?: number[]
  /**
   * 状态更新 flush 间隔（ms）。默认 0 = 每批结果立即回调；
   * 设为 >0 时会把多批结果合并后按间隔回调，减少高频批量场景下 React 列表重渲染。
   */
  flushIntervalMs?: number
  /** 每批结果就绪时回调（渐进填充 store） */
  onUpdate(statuses: Record<string, StreamStatus>): void
}

/**
 * 批量确认收藏列表的真实直播状态：
 * - 只查 isOnline 且外部状态 phase==='checking'（尚未确认）的主播
 * - 小批量并发，每批完成立即回调
 * - 失败项按退避计划自动重试，耗尽后按离线处理，避免永远"检查中"
 * - settled 集合保证每个目标一轮内只查一次：外部 store 的 statuses 更新
 *   要等 React effect 再跑 syncTargets 才到达，期间 kick 自旋必须靠内部
 *   settled 去重（否则快照过期会导致重复查询/死循环）
 * - reset()（刷新时调用）清空 settled 与退避计划，配合外部把状态置回 checking
 * 原先这些逻辑以模块级可变单例（pendingUsernames/retryPlan/retryTimer）散在
 * useFavorites.ts 里，跨测试残留、无法单测；收敛进本模块后可独立用假时钟测。
 */
export class StreamChecker {
  private pending = new Set<string>()
  private settled = new Set<string>()
  private retryPlan = new Map<string, RetryPlan>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private pendingUpdates: Record<string, StreamStatus> = {}
  private running = false
  private disposed = false
  private snapshot: { models: FavoriteModel[]; statuses: Record<string, StreamStatus> } | null = null

  private readonly concurrency: number
  private readonly retryDelays: number[]
  private readonly maxAttempts: number
  private readonly flushIntervalMs: number

  constructor(private readonly opts: StreamCheckerOptions) {
    this.concurrency = opts.concurrency ?? 8
    this.retryDelays = opts.retryDelays ?? [5000, 15000, 45000]
    this.maxAttempts = this.retryDelays.length
    this.flushIntervalMs = opts.flushIntervalMs ?? 0
  }

  /** 喂入最新收藏快照与状态，触发一轮确认（重复调用由 pending/settled/running 去重） */
  syncTargets(models: FavoriteModel[], statuses: Record<string, StreamStatus>): void {
    if (this.disposed) return
    this.snapshot = { models, statuses }
    this.kick()
  }

  /** 清空失败退避计划与已处理标记（"刷新"时调用；外部会把在线主播置回 checking） */
  reset(): void {
    this.retryPlan.clear()
    this.settled.clear()
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pendingUpdates = {}
  }

  /**
   * 使指定目标的结果失效并立即复查（周期轮询用）：
   * 只清 settled（不清 retryPlan —— 上轮失败的退避计划继续生效），
   * 随后 kick 会把外部状态仍为 checking 的目标重新查询。
   * 调用方需同步把 store 里这些目标置回 checking。
   */
  invalidate(ids: Iterable<string>): void {
    if (this.disposed) return
    let touched = false
    for (const id of ids) {
      if (this.settled.delete(id)) touched = true
    }
    if (touched) this.kick()
  }

  dispose(): void {
    this.disposed = true
    this.reset()
    this.pending.clear()
    this.snapshot = null
  }

  /** 从当前快照挑出应查询的目标并分批处理，直到没有目标或进入重试等待 */
  private kick(): void {
    if (this.running || this.disposed) return
    const snap = this.snapshot
    if (!snap) return
    const now = Date.now()
    const targets = snap.models.filter((m) => {
      if (!m.isOnline) return false
      if (snap.statuses[m.id]?.phase !== 'checking') return false
      if (this.settled.has(m.id)) return false
      const plan = this.retryPlan.get(m.id)
      if (plan && plan.nextRetryAt > now) return false
      return !this.pending.has(m.id)
    })
    if (targets.length === 0) {
      this.scheduleRetry() // 只剩未到重试时间的失败项，交给定时器唤醒
      return
    }
    this.running = true
    targets.forEach((m) => this.pending.add(m.id))
    void this.processBatches(targets).finally(() => {
      this.running = false
      targets.forEach((m) => this.pending.delete(m.id))
      // 处理期间可能有新快照到达（syncTargets 在 running 时被丢弃），补踢一次；
      // settled 保证已出结果的目标不会被重复查询
      this.kick()
    })
  }

  private async processBatches(targets: FavoriteModel[]): Promise<void> {
    for (let i = 0; i < targets.length; i += this.concurrency) {
      const batch = targets.slice(i, i + this.concurrency)
      const results = await Promise.allSettled(
        batch.map(async (m) => [m.id, await this.opts.fetchStreamId(m)] as const)
      )
      const merged: Record<string, StreamStatus> = {}
      results.forEach((r, idx) => {
        const id = batch[idx].id
        if (r.status === 'fulfilled') {
          this.retryPlan.delete(id)
          this.settled.add(id)
          const streamId = r.value[1]
          merged[id] = streamId ? { phase: 'live', id: streamId } : { phase: 'offline' }
          return
        }
        // 查询失败：按间隔重试，耗尽后标记为离线（不再显示"检查中"）
        const plan = this.retryPlan.get(id) ?? { attempts: 0, nextRetryAt: 0 }
        plan.attempts += 1
        if (plan.attempts >= this.maxAttempts) {
          this.retryPlan.delete(id)
          this.settled.add(id)
          merged[id] = { phase: 'offline' }
        } else {
          plan.nextRetryAt = Date.now() + this.retryDelays[plan.attempts - 1]
          this.retryPlan.set(id, plan)
        }
      })
      this.queueUpdate(merged)
    }
    // 合并模式下，全部批处理完后把剩余 pending 结果一次推出
    this.flushUpdates()
  }

  /** 累积状态更新；flushIntervalMs=0 时保持原来的"每批立即回调"行为 */
  private queueUpdate(statuses: Record<string, StreamStatus>): void {
    Object.assign(this.pendingUpdates, statuses)
    if (this.flushIntervalMs <= 0) {
      this.flushUpdates()
      return
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.flushUpdates()
      }, this.flushIntervalMs)
    }
  }

  private flushUpdates(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (Object.keys(this.pendingUpdates).length === 0) return
    const updates = this.pendingUpdates
    this.pendingUpdates = {}
    this.opts.onUpdate(updates)
  }

  /** 按 retryPlan 里最早的重试时间安排一次定时器；已有定时器在等则不重复安排 */
  private scheduleRetry(): void {
    if (this.timer !== null || this.disposed) return
    let earliest = Infinity
    this.retryPlan.forEach((p) => {
      if (p.nextRetryAt < earliest) earliest = p.nextRetryAt
    })
    if (earliest === Infinity) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.kick()
    }, Math.max(1000, earliest - Date.now()))
  }
}
