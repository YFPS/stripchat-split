import { app, net, session } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fetchCookiesViaCdp } from './cdp-client'
import { BrowserBinary } from './browser-path'

// ── 登录方案：真实 Chrome/Edge + CDP 取 cookie ─────────────────────────
// Electron 内置窗口登录会被 Cloudflare 反自动化检测拦截（UA、TLS、GPU、
// 字体等多维指纹无法在 Chromium 里完全伪装成 Chrome；Turnstile 报
// "No available adapters"）。可靠做法（GitHub 社区 miketeeranan-cmyk/BotPM 等）：
// 让用户在有完美指纹的真实 Chrome 里登录，再把登录 cookie 同步回应用。
// 这里用 CDP（Network.getAllCookies）读取，绕开 Chrome 127+ 的 cookie 文件
// app-bound 加密（文件读取路径已死）。
//
// 流程：
//   1) spawn 真实浏览器（独立 profile + remote-debugging-port，不带
//      --enable-automation → navigator.webdriver 保持 false）
//   2) 用户手动登录
//   3) 主进程轮询 CDP 取 stripchat cookie → session.cookies.set 注入
//   4) 验证 initial-dynamic.user 非空 → 触发登录成功回调
// 浏览器路径由 browser-path.ts 多级探测（Chrome → Edge 回退），
// CDP 读取由内置的 cdp-client.ts 完成，不依赖目标机器的 Node。

export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const CDP_PORT = 9333
/** 登录整体超时：超时后停止轮询并关闭登录浏览器（原先会无限轮询直到用户关浏览器） */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const LOGIN_PROFILE_DIR = path.join(app.getPath('userData'), 'login-profile')
const STRIPCHAT_DOMAIN = 'stripchat.com'

/**
 * 从登录 profile 读 Chrome 实际使用的 CDP 端口（DevToolsActivePort 文件，
 * 内容为 "端口\n浏览器 ws 地址"）。--remote-debugging-port 指定的端口被占用时
 * Chrome 会静默换一个端口 —— 只认固定端口会永远等不到 CDP 就绪。
 */
function readActualCdpPort(): number | null {
  try {
    const content = fs.readFileSync(path.join(LOGIN_PROFILE_DIR, 'DevToolsActivePort'), 'utf-8')
    const port = Number(content.split('\n', 1)[0])
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

/** CDP cookie → Electron session.cookies.set 需要的结构 */
function toElectronCookie(c: any) {
  // CDP: domain='.stripchat.com' → url 用 https://stripchat.com
  const host = c.domain.replace(/^\./, '')
  const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`
  // Electron CookiesSetDetails.sameSite 只接受这几个字面量
  type SameSiteValue = 'strict' | 'lax' | 'no_restriction' | 'unspecified'
  const sameSiteMap: Record<string, SameSiteValue> = {
    Strict: 'strict',
    Lax: 'lax',
    None: 'no_restriction',
    unspecified: 'unspecified'
  }
  // 关键：CDP 里登录 cookie 多为 session 型（expires<=0），若不补过期时间，
  // Electron 只存内存、重启即丢。这里统一赋予 30 天过期，保证持久化。
  const expirationDate =
    c.expires > 0 ? c.expires : Math.floor(Date.now() / 1000) + 30 * 24 * 3600
  return {
    url,
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: sameSiteMap[c.sameSite] || 'unspecified',
    expirationDate
  }
}

/** 把 cookie 注入 Electron 默认 session */
async function injectCookies(cookies: any[]) {
  for (const c of cookies) {
    try {
      await session.defaultSession.cookies.set(toElectronCookie(c))
    } catch (e) {
      console.log(`[login] cookie set failed: ${c.name}`, (e as Error).message)
    }
  }
}

/** 用注入后的 session 请求 initial-dynamic，验证是否已登录 */
async function verifyLoggedIn(): Promise<boolean> {
  try {
    const res = await net.fetch(
      'https://stripchat.com/api/front/v3/config/initial-dynamic?requestPath=%2F',
      {
        headers: { 'User-Agent': CHROME_UA, 'front-version': '11.7.74', Accept: 'application/json' }
      }
    )
    if (!res.ok) return false
    const data = (await res.json()) as any
    return !!data?.initialDynamic?.user
  } catch {
    return false
  }
}

export interface LoginFlowOptions {
  /** 登录成功（cookie 注入且 initial-dynamic.user 非空）时回调 */
  onLoggedIn(): void
  /** 登录超时（浏览器已被关闭）时回调，可选 */
  onTimeout?(): void
}

export interface LoginFlow {
  /** 主动停止轮询（浏览器退出时也会自动停止） */
  stop(): void
}

/** 当前进行中的登录流程（防止重复点击按钮拉起多个浏览器） */
let activeFlow: LoginFlow | null = null
/** 当前 spawn 出去的外部浏览器进程（退出应用时必须回收，否则留孤儿进程） */
let activeChild: ReturnType<typeof spawn> | null = null

/**
 * 强制结束登录浏览器。应用退出（before-quit）时调用 ——
 * 原先 stopPolling 只清定时器不杀进程，关掉应用后 Chrome/Edge 会一直留在后台。
 */
export function killLoginBrowser(): void {
  const child = activeChild
  activeChild = null
  activeFlow = null
  if (child && !child.killed && child.exitCode === null) {
    child.kill()
  }
}

/** 打开真实浏览器登录并轮询同步 cookie；成功或浏览器退出则停止 */
export function startLoginFlow(browser: BrowserBinary, opts: LoginFlowOptions): LoginFlow {
  // 防重复触发：上一轮登录流程未结束时忽略新的 open-login
  if (activeFlow) return activeFlow

  // 确保独立登录 profile 存在
  fs.mkdirSync(LOGIN_PROFILE_DIR, { recursive: true })

  // 启动真实浏览器：独立 profile + 远程调试端口。
  // 不带 --enable-automation → navigator.webdriver 保持 false，CF 不识别为自动化。
  const child = spawn(browser.path, [
    `--user-data-dir=${LOGIN_PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://stripchat.com/login'
  ], { stdio: 'ignore' })
  activeChild = child
  // 必须监听 error：spawn 失败（路径不存在/权限/被杀软拦截）时事件异步触发，
  // 无监听器会变成未捕获异常，且 child.pid 为 undefined
  child.on('error', (e) => {
    const code = (e as NodeJS.ErrnoException).code
    console.error(`[login] ${browser.name} spawn failed:`, code, e.message)
    stopPolling()
  })
  console.log(`[login] external ${browser.name} spawned (${browser.path}), pid =`, child.pid)

  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let timeoutTimer: NodeJS.Timeout | null = null
  // 实际 CDP 端口：DevToolsActivePort 文件出现后以它为准，固定端口只是兜底
  let cdpPort = CDP_PORT

  /** 回收本流程 spawn 的浏览器（登录成功/超时后调用；应用退出走 killLoginBrowser） */
  const killChild = () => {
    if (activeChild === child) activeChild = null
    if (activeFlow === flowRef) activeFlow = null
    if (!child.killed && child.exitCode === null) child.kill()
  }
  // killChild 需要在 flow 定义前使用，这里先声明一个自引用占位
  const flowRef: LoginFlow = { stop: () => stopPolling() }

  const stopPolling = () => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    if (timeoutTimer) clearTimeout(timeoutTimer)
    activeFlow = null
  }

  child.on('exit', (code) => {
    console.log(`[login] external ${browser.name} exited, code =`, code)
    if (activeChild === child) activeChild = null
    stopPolling()
  })

  const poll = async () => {
    if (stopped) return
    // 内置 CDP 客户端直读 cookie（不再 spawn 系统 node）
    const cookies = await fetchCookiesViaCdp(cdpPort, STRIPCHAT_DOMAIN)
    if (cookies.length === 0) return // 浏览器还没起来或还没登录

    console.log('[login] got', cookies.length, 'stripchat cookies, injecting...')
    await injectCookies(cookies)

    const ok = await verifyLoggedIn()
    if (ok) {
      console.log('[login] ✅ 登录成功（initial-dynamic.user 非空）')
      stopPolling()
      // cookie 已到手，登录浏览器使命结束：立即回收，避免常驻后台
      killChild()
      opts.onLoggedIn()
    } else {
      console.log('[login] cookie 已注入但未登录，继续等待...')
    }
  }

  // 整体超时：到点仍未登录成功就放弃（原先会无限轮询，用户忘了关浏览器就永远挂着）
  timeoutTimer = setTimeout(() => {
    if (stopped) return
    console.warn('[login] 登录超时，停止轮询并关闭登录浏览器')
    stopPolling()
    killChild()
    opts.onTimeout?.()
  }, LOGIN_TIMEOUT_MS)

  // 先等浏览器起来（CDP 端口就绪），再开始轮询。
  // 每 500ms 尝试一次：优先读 DevToolsActivePort 拿真实端口（Chrome 换端口时仍能命中），
  // 文件未出现时退回固定端口探测（老版本/异常情况兜底）。
  const waitPort = async (attempt = 0) => {
    if (stopped) return
    if (attempt > 40) return // ~20s 仍不就绪则放弃（浏览器启动失败会被 exit 事件兜住）
    const filePort = readActualCdpPort()
    if (filePort && filePort !== cdpPort) {
      cdpPort = filePort
      console.log(`[login] DevToolsActivePort 指示实际 CDP 端口: ${cdpPort}`)
    }
    try {
      const res = await net.fetch(`http://127.0.0.1:${cdpPort}/json/version`)
      if (res.ok) {
        console.log(`[login] CDP port ${cdpPort} ready`)
        timer = setInterval(poll, 3000)
        poll()
        return
      }
    } catch {
      /* 端口未就绪，重试 */
    }
    setTimeout(() => waitPort(attempt + 1), 500)
  }
  waitPort()

  const flow: LoginFlow = flowRef
  activeFlow = flow
  return flow
}
