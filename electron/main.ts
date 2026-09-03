import { app, BrowserWindow, session, ipcMain, dialog, powerMonitor, crashReporter } from 'electron'
import path from 'path'

// ── GPU 兼容性设置 ──────────────────────────────────────────
// 根因：GPU 进程 TDR（超时检测恢复）导致 Windows 强制终止 Electron，
// 完全绕过 Node.js 事件循环，所有 JS 层日志都无法捕获。
// 方案：禁用 GPU 硬件加速，用软件渲染。虽然 CPU 占用略高，但不会崩溃。
app.disableHardwareAcceleration()                           // 彻底禁用 GPU 加速
app.commandLine.appendSwitch('disable-gpu')                 // 双重保险
// 注意：不要加 disable-software-rasterizer。disable-gpu 之后 GPU 进程靠
// SwiftShader（软件光栅化）跑显示合成器，再禁它就是「GPU 禁了、软件也不许用」，
// GPU 进程无光栅化器可用 → 反复崩溃 → Chromium 直接退出。
// Windows 11 26200 实测：GPU 进程（沙箱内）启动即被系统终止（exit_code=1
// 反复复现，最终 "GPU process isn't usable. Goodbye."，裸 Electron 零开关同挂，
// 与本仓库代码无关）。--disable-gpu-sandbox 让 GPU 进程脱离沙箱后即可正常存活，
// 且保留独立进程模型（比 --in-process-gpu 更抗崩）。GPU 已禁用硬件加速，
// 解沙箱带来的攻击面增量可忽略。
app.commandLine.appendSwitch('disable-gpu-sandbox')
// Audio Service 同病：本机也会杀死沙箱化的 audio utility 进程（复现于
// 2026-09-03，反复 killed/exitCode=1）。强制音频服务在主进程内运行，
// 绕开沙箱击杀；代价仅是音频不再隔离于主进程，可接受。
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess')
import { createMainWindow, openPlayerWindow } from './window'
import { startLoginFlow, killLoginBrowser, CHROME_UA } from './login'
import { fetchStreamId } from './stream-gateway'
import { findBrowserBinary } from './browser-path'
import { handleApiRequest } from './api-gateway'
import { crashLog } from './crash-logger'

let mainWindow: BrowserWindow | null = null

// 关键：必须在 app ready 之前全局覆盖 UA。
// 默认 navigator.userAgent 含 "Electron/x.y.z" 和 "stripchat-desktop/1.0.0"，
// Cloudflare 的 JS 挑战会据此识别 Electron 并强制 reCAPTCHA（登录被拒）。
// appendSwitch 同时改网络层 UA 和渲染进程的 navigator.userAgent。
app.commandLine.appendSwitch('user-agent', CHROME_UA)

// 强制直连：net.fetch（Chromium 网络栈）默认跟随系统代理，本机 Clash
// (127.0.0.1:7897) 会改变 TLS 指纹 → cam 端点全部 418（项目注释早已记录此
// 现象，但此前从未真正禁过代理）。实测 2026-09-03 直连可达（curl direct 403
// = 仅指纹挑战，网络通），直连后 TLS 指纹与真实 Chrome 一致，CF 放行。
app.commandLine.appendSwitch('no-proxy-server')



function createWindow() {
  mainWindow = createMainWindow()

  // 设置 session 持久化
  const ses = session.defaultSession

  // 网络层 UA 与 navigator.userAgent 保持一致（appendSwitch 已全局设置，
  // 这里冗余设置一次，确保网络请求头也使用同一 UA）
  ses.setUserAgent(CHROME_UA)

  // 注：这里曾经有一个 webRequest.onBeforeSendHeaders 给 localhost:5174/api
  // 请求注入 cookie 并重写 Referer/Origin —— 那是"渲染进程直接 fetch 经 Vite
  // 代理"时代的产物。现在渲染进程一律走 ipc('api-request') → 主进程 net.fetch，
  // 该 handler 永远不会命中（且硬编码了 5174），已移除。

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 自定义标题栏：窗口最大化状态变化时通知渲染进程（用于切换图标）
  const notifyMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximized-changed', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', notifyMaximized)
  mainWindow.on('unmaximize', notifyMaximized)
}

// ── 崩溃日志 ──────────────────────────────────────────────

// Electron 内置 crashReporter：收集 Chromium 崩溃报告
crashReporter.start({
  submitURL: '',
  uploadToServer: false,
  compress: true
})

// 未捕获异常 → 记录到 crash.log（不调用 console 避免 EPIPE 死循环）
process.on('uncaughtException', (error) => {
  // EPIPE 错误单独处理：管道断开是正常的，不应该让应用崩溃
  if ((error as any).code === 'EPIPE') {
    // 静默忽略，管道断开不影响应用功能
    return
  }
  crashLog.fatal('process', 'Uncaught Exception', {
    name: error.name,
    message: error.message,
    stack: error.stack
  })
})

// 未处理的 Promise rejection
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  if ((error as any).code === 'EPIPE') return
  crashLog.error('process', 'Unhandled Rejection', {
    reason: reason instanceof Error ? { name: reason.name, message: reason.message, stack: reason.stack } : String(reason)
  })
})

// GPU 进程崩溃
app.on('gpu-info-update', () => {
  crashLog.warn('gpu', 'GPU info updated')
  console.log('[main] GPU info updated')
})

// GPU 进程崩溃
app.on('gpu-process-crashed', (_event, killed) => {
  crashLog.fatal('gpu', 'GPU process crashed', { killed })
  console.error('[main] GPU process crashed, killed:', killed)
})

powerMonitor.on('suspend', () => {
  crashLog.info('system', 'System suspending')
})

powerMonitor.on('resume', () => {
  crashLog.info('system', 'System resumed')
})

app.whenReady().then(() => {
  crashLog.info('app', 'Application starting', { version: app.getVersion() })
  
  // 不设置代理：net.fetch 走 Chromium 网络栈，TLS 指纹与真实 Chrome 一致，
  // Cloudflare 放行。代理会改变 TLS 指纹导致 418。
  
  createWindow()
})

app.on('window-all-closed', () => {
  crashLog.info('app', 'All windows closed')
  // macOS 惯例：关闭全部窗口不退出应用（dock 图标仍在，activate 时重建窗口）；
  // 其他平台必须退出。此前这里被注释成"调试模式"导致 Windows 上关窗后进程常驻后台。
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出前日志 + 回收登录流程 spawn 出去的外部浏览器
app.on('before-quit', (event) => {
  crashLog.info('app', 'before-quit event', {
    defaultPrevented: event.defaultPrevented
  })
  // 登录流程会 spawn 一个独立的 Chrome/Edge（独立 profile + CDP 端口），
  // 不主动 kill 的话关掉应用后它会作为孤儿进程一直留在后台
  killLoginBrowser()
})

app.on('will-quit', (event) => {
  crashLog.info('app', 'will-quit event', {
    defaultPrevented: event.defaultPrevented
  })
  console.log('[main] will-quit 事件触发')
})

// 进程退出 - 立即写入文件（同步操作，确保日志不丢失）
// 注意：exit 事件中 app 可能已不可用，所以缓存路径
const EXIT_LOG = path.join(app.getPath('userData'), 'logs', 'exit.log')
process.on('exit', (code) => {
  try {
    const fs = require('fs')
    const line = `[${new Date().toISOString()}] process.exit code=${code}\n`
    fs.appendFileSync(EXIT_LOG, line)
  } catch (e) {
    // 最后手段：写到 temp
    try {
      const fs = require('fs')
      const os = require('os')
      fs.appendFileSync(path.join(os.tmpdir(), 'stripchat-exit.log'), `[${new Date().toISOString()}] process.exit code=${code} (fallback)\n`)
    } catch {}
  }
  console.log(`[main] process.exit 事件, code=${code}`)
})

// SIGTERM / SIGINT
process.on('SIGTERM', () => {
  const fs = require('fs')
  const path = require('path')
  const logFile = path.join(app.getPath('userData'), 'logs', 'exit.log')
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] SIGTERM received\n`) } catch {}
})
process.on('SIGINT', () => {
  const fs = require('fs')
  const path = require('path')
  const logFile = path.join(app.getPath('userData'), 'logs', 'exit.log')
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] SIGINT received\n`) } catch {}
})

// 渲染进程崩溃时记录
app.on('render-process-gone', (_event, webContents, details) => {
  crashLog.fatal('renderer', 'Render process gone', {
    reason: details.reason,
    exitCode: details.exitCode,
    url: webContents?.getURL?.() ?? 'unknown'
  })
})

// 子进程崩溃
app.on('child-process-gone', (_event, details) => {
  crashLog.error('child-process', 'Child process gone', {
    type: details.type,
    reason: details.reason,
    serviceName: details.serviceName,
    name: details.name,
    exitCode: details.exitCode
  })
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// ── IPC：渲染进程唯一入口，全部收敛在组合根 ────────────────────────────

ipcMain.handle('get-cookies', async (_event, domain) => {
  return session.defaultSession.cookies.get({ domain })
})

ipcMain.handle('set-cookie', async (_event, cookie) => {
  await session.defaultSession.cookies.set(cookie)
})

ipcMain.handle('clear-cookies', async (_event, domain) => {
  const cookies = await session.defaultSession.cookies.get({ domain })
  for (const cookie of cookies) {
    await session.defaultSession.cookies.remove(domain, cookie.name)
  }
})

// 流网关：doppiocdn master 探测直播状态（doppiocdn 无 CF 拦截；缺数字 id 时
// 兜底拉模型页 HTML，走主进程 Chromium 网络栈过 CF 的 TLS 指纹校验）
ipcMain.handle('get-stream-id', async (_event, model: { id?: string | null; username: string }) => {
  return fetchStreamId(model)
})

// API 网关：渲染进程全部 stripchat API 经主进程转发（同上，绕 CF 指纹拦截）
ipcMain.handle('api-request', async (_event, req) => {
  return handleApiRequest(req)
})

// 自定义标题栏窗口控制（frame:false 后由网页按钮驱动）
ipcMain.handle('window-minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize()
})

ipcMain.handle('window-maximize-toggle', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})

ipcMain.handle('window-close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close()
})

// 双击卡片打开独立播放器窗口：无边框 + 自定义标题栏（复用网页 WindowControls），
// 播放器页通过 hash 路由（#/player?username=…）在渲染进程内按需加载
ipcMain.handle('open-player-window', (_e, model: { username: string; displayName: string; avatar?: string }) => {
  openPlayerWindow(model)
})

// 打开登录：弹出真实浏览器（独立 profile），用户在浏览器里登录，
// 主进程轮询 CDP 把登录 cookie 注入应用 session。
ipcMain.handle('open-login', () => {
  if (!mainWindow) return
  // 多级探测 Chrome/Edge（用户级安装/自定义路径/非默认盘符都能命中）
  const browser = findBrowserBinary()
  if (!browser) {
    dialog.showErrorBox(
      '无法打开登录浏览器',
      '未找到 Google Chrome 或 Microsoft Edge。\n\n请安装其中任意一个浏览器后重试。'
    )
    return
  }
  try {
    startLoginFlow(browser, {
      onLoggedIn: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('login-closed')
        }
      },
      onTimeout: () => {
        dialog.showErrorBox(
          '登录超时',
          '10 分钟内未完成登录，登录浏览器已关闭。\n\n如需继续，请再次点击登录按钮。'
        )
      }
    })
  } catch (e) {
    // mkdirSync 等同步异常会让 invoke 拒绝 → 渲染进程 JS 报错；转为日志
    console.error('[login] startLoginFlow 同步异常:', (e as Error).message)
  }
})
