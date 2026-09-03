import { FavoriteModel, User } from '../types'
import { StreamResult, ApiResponse, StreamModelInput } from '../bridge'

// 统一走 /api/front 相对路径，但请求本身经主进程 API 网关转发：
// - Electron：window.electronAPI.apiRequest → 主进程 net.fetch（Chromium 网络栈，
//   TLS 指纹与真实 Chrome 一致）→ stripchat.com。Cloudflare 对 Node TLS 指纹
//   （Vite proxy / 直连）做校验并 403，所以渲染进程不再直接 fetch。
// - 浏览器（Chrome MCP 调试）：mock 的 apiRequest 回退走 Vite dev proxy（可能被 CF 拒，仅调试用）。
const BASE_URL = '/api/front'

/** 错误分类：调用方能区分"没登录"、"被 CF 拦"、"网络断"、"接口异常" */
export type ApiErrorKind = 'network' | 'blocked' | 'server' | 'unknown'

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 把任意异常归一到 ApiError（fetch 网络层错误等） */
function toApiError(err: unknown, fallback: string): ApiError {
  if (err instanceof ApiError) return err
  const e = err as Error | undefined
  const message = e?.message || fallback
  if (e?.name === 'TypeError') return new ApiError('network', message)
  return new ApiError('unknown', message)
}

/** 可重试的错误：网络抖动（代理断链/TLS 握手失败）与服务端 5xx */
function isRetryable(err: unknown): boolean {
  return err instanceof ApiError && (err.kind === 'network' || err.kind === 'server')
}

const RETRY_DELAYS = [800, 1600] // 两次重试的间隔（ms）

/** 有界并发 map：按顺序保留结果，避免一次性打满所有分页请求 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return out
}

async function fetchJson(url: string, options: RequestInit = {}): Promise<any> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((res) => setTimeout(res, RETRY_DELAYS[attempt - 1]))
    }
    try {
      const response: ApiResponse = await window.electronAPI.apiRequest({
        path: url,
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers as Record<string, string> | undefined)
        }
      })
      if (!response.ok) {
        // 401/403 大多是 CF 挑战或未登录；500+ 是服务端异常；status 0 = 网络失败
        const kind: ApiErrorKind =
          response.status === 0
            ? 'network'
            : response.status === 401 || response.status === 403
              ? 'blocked'
              : response.status >= 500
                ? 'server'
                : 'unknown'
        throw new ApiError(kind, `API error: ${response.status || response.error} ${url}`, response.status || undefined)
      }
      return response.data
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : toApiError(err, `网络请求失败: ${url}`)
      // 网络错误/5xx 自动重试；重试耗尽或不可重试（blocked/4xx）直接抛出
      if (!isRetryable(apiErr) || attempt === RETRY_DELAYS.length) throw apiErr
      lastErr = apiErr
    }
  }
  throw lastErr
}

// ── initial-dynamic 单次拉取 + 缓存 ──────────────────────────────────────
// checkAuth / getUser / getJwtToken 之前各自请求同一端点；initial-dynamic 同时
// 下发 user 与 jwtToken（页面 JS 内存持有，cookie/localStorage 都没有），
// 这里拉一次缓存 30 分钟，三处共享。
const INITIAL_DYNAMIC_URL = `${BASE_URL}/v3/config/initial-dynamic?requestPath=%2F`
const INITIAL_TTL_MS = 30 * 60 * 1000

interface InitialDynamic {
  user: any
  jwtToken: string | null
}

let initialCache: { data: InitialDynamic; at: number } | null = null

async function getInitialDynamic(force = false): Promise<InitialDynamic> {
  if (!force && initialCache && Date.now() - initialCache.at < INITIAL_TTL_MS) {
    return initialCache.data
  }
  const data = await fetchJson(INITIAL_DYNAMIC_URL)
  const parsed: InitialDynamic = {
    user: data?.initialDynamic?.user ?? null,
    jwtToken: data?.initialDynamic?.jwtToken ?? null
  }
  initialCache = { data: parsed, at: Date.now() }
  return parsed
}

export class StripchatAPI {
  /** 登录态 + 用户信息（一次请求，缓存 30 分钟）。失败抛 ApiError。 */
  async getAuthInfo(force = false): Promise<{ authenticated: boolean; user: User | null }> {
    const { user } = await getInitialDynamic(force)
    if (!user) return { authenticated: false, user: null }
    return {
      authenticated: true,
      user: {
        id: String(user.id ?? ''),
        username: String(user.username ?? ''),
        email: String(user.email ?? ''),
        avatar: String(user.avatarUrl ?? user.avatar ?? '')
      }
    }
  }

  /** 强制重新鉴权（登录窗口关闭后调用），不命中缓存 */
  async checkAuth(force = false): Promise<boolean> {
    const { authenticated } = await this.getAuthInfo(force)
    return authenticated
  }

  /** 在线收藏端点要求 Authorization: <jwtToken> 头（缓存 30 分钟，随 initial-dynamic 下发） */
  private async getJwtToken(): Promise<string | null> {
    const { jwtToken } = await getInitialDynamic()
    return jwtToken
  }

  /** 分页拉全收藏（接口默认每页 100 条，totalCount 是真实总数） */
  private async fetchAllFavorites(url: string, headers: Record<string, string> = {}): Promise<any[]> {
    const PAGE = 100
    const CONCURRENCY = 4

    // 第一页同时充当 totalCount 探测；剩余页按 offset 有界并发拉取
    const first = await fetchJson(`${url}?offset=0`, { headers })
    const models = first?.models || []
    const total = first?.totalCount ?? models.length
    if (models.length === 0 || total <= models.length) return models

    const offsets: number[] = []
    for (let offset = PAGE; offset < total; offset += PAGE) {
      offsets.push(offset)
    }
    const pages = await mapWithConcurrency(offsets, CONCURRENCY, async (offset) => {
      const data = await fetchJson(`${url}?offset=${offset}`, { headers })
      return data?.models || []
    })

    // 与旧逻辑一致：totalCount 仅用于决定拉多少页，最终以实际返回条数为准
    return [models, ...pages].flat()
  }

  async getFavorites(): Promise<FavoriteModel[]> {
    // 真实端点（经 CDP 抓包实测）：
    //   /api/front/models/favorites         —— 在线收藏，必须带 Authorization: <jwtToken>
    //                                         头，否则 200 但返回空列表
    //   /api/front/models/favorites/offline —— 离线收藏，无需鉴权头
    // 接口默认每页 100 条，必须分页拉全，否则收藏数量与实际不一致。
    const jwt = await this.getJwtToken()
    const authHeaders: Record<string, string> = jwt ? { Authorization: jwt } : {}
    const [online, offline] = await Promise.all([
      this.fetchAllFavorites(`${BASE_URL}/models/favorites`, authHeaders),
      this.fetchAllFavorites(`${BASE_URL}/models/favorites/offline`)
    ])
    // 按 id 去重（分页或接口分类可能导致重复）
    const seen = new Set<string>()
    const models = [...online, ...offline].filter((m: any) => {
      const id = m.id?.toString() || m.username
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    return models.map((m: any) => ({
      id: m.id?.toString() || m.username,
      username: m.username,
      displayName: m.displayName || m.username,
      // 封面优先用头像（avatarUrl）。previewUrlThumbSmall 是直播快照，
      // 给离线主播当封面会让人误以为在直播。
      avatar: m.avatarUrl || m.previewUrlThumbSmall || '',
      // 只信真实布尔字段 isOnline；status 字符串（'public' 等）不等于正在直播。
      isOnline: !!m.isOnline,
      viewers: m.viewersCount || 0,
      addedAt: Date.now()
    }))
  }

  /** 拿主播的直播流结果（doppiocdn master 探测，返回流数字 id 或离线）。
   *  doppiocdn 无 Cloudflare 拦截，任何网络栈可达；但缺数字 id 时需主进程
   *  net.fetch 拉 Chrome TLS 指纹过 CF 解析模型页，统一经 bridge 调用 ——
   *  Electron 走主进程，浏览器调试走直接探测（仅调试用）。 */
  async getStreamId(model: StreamModelInput): Promise<StreamResult> {
    return window.electronAPI.getStreamId(model)
  }
}

export const stripchatAPI = new StripchatAPI()
