import { net } from 'electron'
import { CHROME_UA } from './login'

/**
 * API 网关：渲染进程的 stripchat API 请求统一经主进程 net.fetch 转发。
 * 原因：Cloudflare 对 Node TLS 指纹（Vite proxy / 直连 curl 都是 Node 指纹）
 * 做校验并返回 403（今日实测已从 cam 端点蔓延到全部 /api/front 接口），
 * 而主进程 net.fetch 走 Chromium 网络栈，TLS 指纹与真实 Chrome 一致，CF 放行。
 * 渲染进程不再直接请求 /api，改经 ipc('api-request') 到此网关。
 */

export interface ApiGatewayRequest {
  /** 以 /api 开头的路径（相对 stripchat.com） */
  path: string
  method?: string
  headers?: Record<string, string>
}

export interface ApiGatewayResponse {
  ok: boolean
  /** HTTP 状态码；网络失败时为 0 */
  status: number
  data: any
  error?: string
}

/** 允许渲染进程透传的请求头白名单（小写）。防止渲染进程被 XSS 后伪造
 *  Cookie / Origin / Referer 等敏感头去打任意接口。 */
const ALLOWED_REQUEST_HEADERS = new Set([
  'content-type',
  'accept',
  'accept-language',
  'authorization',
  'x-csrf-token'
])

export async function handleApiRequest(req: ApiGatewayRequest): Promise<ApiGatewayResponse> {
  // 安全校验：只允许请求 stripchat.com 的 /api 路径，防止渲染进程被攻破后
  // 把网关当 SSRF 跳板（如 path 传 //evil.com/x 或 /../../admin）
  if (typeof req.path !== 'string' || !req.path.startsWith('/api/') && req.path !== '/api') {
    return { ok: false, status: 0, data: null, error: `blocked path: ${req.path}` }
  }
  // 白名单过滤透传头
  const safeHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (ALLOWED_REQUEST_HEADERS.has(k.toLowerCase())) {
      safeHeaders[k] = v
    }
  }
  const url = `https://stripchat.com${req.path}`
  try {
    const res = await net.fetch(url, {
      method: req.method || 'GET',
      headers: {
        'User-Agent': CHROME_UA,
        'front-version': '11.7.74',
        Accept: 'application/json',
        Referer: 'https://stripchat.com/',
        Origin: 'https://stripchat.com',
        ...safeHeaders
      },
      // 网络异常时请求可能长时间挂起（连接堆积），20s 超时快速失败，
      // 渲染进程侧会按重试计划自动重试
      signal: AbortSignal.timeout(20000)
    })
    let data: any = null
    try {
      data = await res.json()
    } catch {
      /* 非 JSON 响应（CF 挑战页等），data 保持 null */
    }
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: (e as Error).message }
  }
}
