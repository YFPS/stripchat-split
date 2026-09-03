import { useFavoriteStore } from '../stores/favoriteStore'
import { stripchatAPI, ApiError } from './stripchat-api'
import { StreamChecker } from './streamChecker'
import type { StreamStatus } from './streamChecker'

/**
 * 收藏数据编排单例：全应用唯一一份 StreamChecker + 拉取/刷新/周期复查逻辑。
 *
 * 原先这些副作用长在 useFavorites hook 里，而 hook 被 App 与 FavoriteList
 * 各调用一次 → 收藏列表拉两遍、每个在线主播的 cam 查询发两遍（dev-run.log
 * 实测 60 次查询 / 30 个去重主播）。状态的所有权必须是全局唯一的，
 * hook 只应做选择器；副作用收敛到这里。
 *
 * 生命周期：MainRoute 挂载时 start()、卸载时 stop()（StrictMode 双挂载安全）。
 */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case 'network':
        return '网络错误，无法获取收藏列表'
      case 'blocked':
        return '请求被拦截（未登录或安全验证），请重新登录'
      case 'server':
        return '服务器错误，请稍后重试'
      default:
        return `${fallback}（HTTP ${err.status ?? '?'}）`
    }
  }
  return fallback
}

/** live 主播每 90s 后台复查一轮（下播及时发现，且不打断正在播放的画面） */
const LIVE_RECHECK_MS = 90 * 1000
/** 每轮复查顺带抽查的离线主播数（轮转指针，新开播的不用等手动刷新就能回来） */
const OFFLINE_SWEEP_PER_TICK = 3

class FavoriteService {
  private started = false
  private unsubscribe: (() => void) | null = null
  private recheckTimer: ReturnType<typeof setInterval> | null = null
  private fetched = false
  /** 复查进行中标记：上一轮未跑完时不开启新一轮（避免重叠风暴） */
  private rechecking = false
  /** 离线抽查轮转指针 */
  private offlineProbeIdx = 0
  private checker: StreamChecker = this.createChecker()

  /** 启动编排：订阅 store 变化驱动 StreamChecker + 周期复查 + 首次拉取 */
  start(): () => void {
    if (this.started) return () => this.stop()
    this.started = true

    // favorites / streamStatus 更新时喂给 checker（引用比较过滤无关更新）
    let lastFavorites: unknown = null
    let lastStatus: unknown = null
    this.unsubscribe = useFavoriteStore.subscribe((s) => {
      if (s.loading) return
      if (s.favorites === lastFavorites && s.streamStatus === lastStatus) return
      lastFavorites = s.favorites
      lastStatus = s.streamStatus
      this.checker.syncTargets(s.favorites, s.streamStatus)
    })

    this.recheckTimer = setInterval(() => this.recheckLive(), LIVE_RECHECK_MS)

    if (!this.fetched) {
      this.fetched = true
      void this.fetchFavorites()
    }

    return () => this.stop()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.recheckTimer !== null) {
      clearInterval(this.recheckTimer)
      this.recheckTimer = null
    }
    this.checker.dispose()
    // stop 后可能再次 start（StrictMode）：checker 需要可用，重建一个干净的
    this.checker = this.createChecker()
  }

  private createChecker(): StreamChecker {
    return new StreamChecker({
      fetchStreamId: async (m) => {
        const result = await stripchatAPI.getStreamId(m)
        if (!result.ok) throw new Error(result.message)
        return result.id
      },
      concurrency: 12,
      flushIntervalMs: 100,
      onUpdate: (statuses) => useFavoriteStore.getState().setStreamStatus(statuses)
    })
  }

  async fetchFavorites(): Promise<void> {
    useFavoriteStore.getState().setLoading(true)
    try {
      const list = await stripchatAPI.getFavorites()
      useFavoriteStore.getState().setFavorites(list)
    } catch (err) {
      useFavoriteStore.getState().setError(errorMessage(err, '获取收藏列表失败'))
    }
  }

  /** 手动刷新：清掉失败重试计划与已确认标记，把在线主播置回 checking 后全量重拉 */
  async refreshStatus(): Promise<void> {
    this.checker.reset()
    useFavoriteStore.setState((s) => {
      const streamStatus = { ...s.streamStatus }
      s.favorites.forEach((m) => {
        if (m.isOnline) streamStatus[m.id] = { phase: 'checking' }
      })
      return { streamStatus }
    })
    await this.fetchFavorites()
  }

  /**
   * 周期复查（每 90s）：
   * 1) 对全部已确认 live 的主播后台逐路复查 —— 不在复查前把 store 置回 checking，
   *    播放器继续用旧流画面播放，只有确认下播才切 offline（杜绝"整墙闪断重挂"）；
   * 2) 轮转抽查 OFFLINE_SWEEP_PER_TICK 个离线主播 —— 在站上新开播的主播
   *    自动回到在线区，不用等手动刷新。
   * 查询失败一律静默（保持原状态，下轮再试），避免网络抖动引发状态抖动。
   */
  private recheckLive(): void {
    if (!this.started || this.rechecking) return
    const { favorites, streamStatus } = useFavoriteStore.getState()
    const live = favorites.filter((m) => streamStatus[m.id]?.phase === 'live')
    const offline = favorites.filter((m) => streamStatus[m.id]?.phase === 'offline')
    if (live.length === 0 && offline.length === 0) return

    this.rechecking = true
    const merged: Record<string, StreamStatus> = {}

    // live 复查：全部并发（数量少），逐个结果落地；失败静默保留 live
    const liveChecks = live.map(async (m) => {
      try {
        const r = await stripchatAPI.getStreamId({ id: m.id, username: m.username })
        if (!r.ok) return
        const cur = streamStatus[m.id]
        if (!r.id) {
          // 单次"无流"不立即判下播：edge-hls 在 CDN 抖动/换档窗口期会对在播流
          // 瞬时返回 403/404，被 probe 归类成"未开播"（而非查询失败，不走重试）。
          // 5s 后二次确认仍无流才翻 offline —— 否则分屏里播得好好的格子会被
          // 一次误报拆掉并定格"未开播"。二次确认必须 fresh 绕 CDN 缓存：
          // master 有 6s 边缘缓存，不绕缓存两次探测会读到同一份瞬时状态。
          await new Promise((res) => setTimeout(res, 5000))
          const r2 = await stripchatAPI.getStreamId({ id: m.id, username: m.username, fresh: true })
          if (r2.ok && !r2.id) {
            console.log(`[recheck] 确认下播 ${m.username}(${m.id})`)
            merged[m.id] = { phase: 'offline' }
          }
          return
        }
        if (cur?.phase === 'live' && cur.id !== r.id) {
          // 仍 live：流 id 可能变化（CDN 重排），更新为最新 id
          merged[m.id] = { phase: 'live', id: r.id }
        }
        // 其余情况（仍 live 且 id 未变）：状态无需更新，画面继续播
      } catch {
        /* 网络抖动：保持原状态 */
      }
    })

    // 离线抽查：轮转指针取一小批，探测到 live 立即转正
    const n = offline.length
    const picked: typeof offline = []
    for (let i = 0; i < OFFLINE_SWEEP_PER_TICK && n > 0; i++) {
      picked.push(offline[(this.offlineProbeIdx + i) % n])
    }
    this.offlineProbeIdx = (this.offlineProbeIdx + OFFLINE_SWEEP_PER_TICK) % Math.max(n, 1)
    const offlineChecks = picked.map(async (m) => {
      try {
        const r = await stripchatAPI.getStreamId({ id: m.id, username: m.username })
        if (r.ok && r.id) merged[m.id] = { phase: 'live', id: r.id }
      } catch {
        /* 静默 */
      }
    })

    void Promise.allSettled([...liveChecks, ...offlineChecks]).then(() => {
      this.rechecking = false
      if (Object.keys(merged).length > 0) {
        useFavoriteStore.getState().setStreamStatus(merged)
      }
    })
  }
}

export const favoriteService = new FavoriteService()
