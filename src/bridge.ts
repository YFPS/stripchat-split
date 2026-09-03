/**
 * 渲染进程 ↔ Electron 主进程的唯一契约。
 * - 适配器一：electron/preload.ts（contextBridge 实现）
 * - 适配器二：src/main.tsx 里的浏览器调试 mock
 * 两个适配器都必须完整实现本接口，由类型系统强制同步，防止各自漂移。
 */

export interface PlayerWindowParams {
  /** 主播数字 id（收藏列表自带；用于 doppiocdn 流探测） */
  id?: string
  username: string
  displayName: string
  avatar?: string
}

/** 直播状态查询入参：优先用数字 id 探测，缺 id 时主进程兜底解析模型页 */
export interface StreamModelInput {
  id?: string | null
  username: string
  /**
   * true = 绕过 CDN 边缘缓存探测（master 有 max-age=6 缓存；复查确认等
   * "结果会影响状态翻牌"的场景必须拿新鲜数据，否则两次探测读到同一份
   * 缓存，"二次确认"形同虚设）
   */
  fresh?: boolean
}

export interface WindowControlsBridge {
  minimize(): Promise<void>
  maximizeToggle(): Promise<void>
  close(): Promise<void>
  /** 订阅窗口最大化状态变化；返回取消订阅函数 */
  onMaximizedChange(callback: (isMaximized: boolean) => void): () => void
}

/**
 * 直播状态查询结果：区分"明确知道直播状态"与"查询失败"。
 * - ok 且 id 有值：直播中（流数字 id，可拼 doppiocdn master playlist）
 * - ok 且 id 为 null：未开播/离线
 * - !ok：请求失败（网络/CF），调用方应安排重试而非当成离线
 */
export type StreamResult =
  | { ok: true; id: string | null }
  | { ok: false; message: string }

/**
 * 渲染进程 stripchat API 请求（经主进程 Chromium 网络栈转发，绕 Cloudflare
 * 的 TLS 指纹拦截；浏览器调试 mock 回退走 Vite proxy）
 */
export interface ApiRequest {
  /** 以 /api 开头的路径（相对 stripchat.com） */
  path: string
  method?: string
  headers?: Record<string, string>
}

export interface ApiResponse {
  ok: boolean
  /** HTTP 状态码；网络失败时为 0 */
  status: number
  data: any
  error?: string
}

export interface ElectronBridge {
  getCookies(domain: string): Promise<any[]>
  setCookie(cookie: any): Promise<void>
  clearCookies(domain: string): Promise<void>
  openLogin(): Promise<void>
  /** doppiocdn master 探测直播状态（doppiocdn 无 CF 拦截；缺数字 id 时主进程兜底解析模型页过 CF） */
  getStreamId(model: StreamModelInput): Promise<StreamResult>
  /** 通用 API 转发（同上，Chromium 网络栈绕 CF 的 TLS 指纹拦截） */
  apiRequest(req: ApiRequest): Promise<ApiResponse>
  openPlayerWindow(params: PlayerWindowParams): Promise<void>
  /** 订阅登录窗口关闭事件；返回取消订阅函数 */
  onLoginClosed(callback: () => void): () => void
  windowControls: WindowControlsBridge
}
