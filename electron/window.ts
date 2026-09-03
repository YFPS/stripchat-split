import { BrowserWindow } from 'electron'
import path from 'path'
import { crashLog } from './crash-logger'

// main.ts 编译产物位于 dist-electron/main.js，运行时 __dirname 即 dist-electron/。
// preload.js 同目录；打包后的前端 dist/ 在 dist-electron 的上一级。
const DIST_ELECTRON = __dirname
const DIST = path.join(DIST_ELECTRON, '..', 'dist')

// 深色背景与应用主题一致：渲染进程还没画出来 / resize 期间窗口由系统合成器
// 显示 native 背景，默认白色会闪白屏，设成深色后过渡自然
const BACKGROUND_COLOR = '#101010'

interface WindowSpec {
  width: number
  height: number
  minWidth?: number
  minHeight?: number
  title: string
}

/** 两个窗口（主窗口 / 独立播放器窗口）共享的构造参数，避免各自复制漂移 */
function windowOptions(spec: WindowSpec): Electron.BrowserWindowConstructorOptions {
  return {
    width: spec.width,
    height: spec.height,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    frame: false, // 无系统标题栏，由网页自定义标题栏提供窗口控制
    title: spec.title,
    backgroundColor: BACKGROUND_COLOR,
    // 渲染完成前不显示窗口，避免打开时白屏闪烁
    show: false,
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // 本机（Win11 26200）会直接杀死 Electron 28 / Chromium 120 的沙箱子进程
      // （GPU 与 renderer 均 reason=killed、exitCode=1，实测 2026-09-03，与仓库
      // 代码无关；沙箱开关 A/B 对照已确认）。sandbox:false 是本机可运行的必要
      // 条件；安全兜底靠 contextIsolation + nodeIntegration:false + 禁 webview +
      // CSP + setWindowOpenHandler。升级 Electron 后可恢复 sandbox:true。
      sandbox: false,
      webviewTag: false // 全仓无 <webview> 元素，关闭不必要的攻击面
    }
  }
}

/** 安全加固：拒绝任何 window.open / target=_blank 弹出新窗口（应用无外部跳转需求） */
function denyNewWindows(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/** 加载应用：开发态走 Vite dev server，生产态走打包产物；hash 用于播放器路由 */
export function loadAppInto(win: BrowserWindow, hash?: string): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(hash ? `${devUrl}/#${hash}` : devUrl)
  } else {
    win.loadFile(path.join(DIST, 'index.html'), hash ? { hash } : undefined)
  }
}

/** 把渲染进程 console / 崩溃日志转发到主进程 stdout，便于定位白屏 */
export function attachRendererLogging(win: BrowserWindow, prefix: string): void {
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // 只记录 warn 和 error 级别，减少噪音
    if (level >= 2) {
      crashLog.warn(prefix, message, { line, sourceId, level })
    }
    console.log(`[${prefix}:${level}] ${message} (${sourceId}:${line})`)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    crashLog.fatal(prefix, 'Render process gone', {
      reason: details.reason,
      exitCode: details.exitCode
    })
    console.error(`[${prefix}] render-process-gone:`, details)
  })

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    crashLog.error(prefix, 'Failed to load', {
      errorCode,
      errorDescription,
      url: validatedURL
    })
    console.error(`[${prefix}] did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`)
  })

  // 页面崩溃（如 GPU 加速相关）
  win.webContents.on('crashed', (_e, killed) => {
    crashLog.fatal(prefix, 'WebContents crashed', { killed })
  })

  // 无响应（hang）
  win.webContents.on('unresponsive', () => {
    crashLog.error(prefix, 'Window became unresponsive')
  })

  // 恢复响应
  win.webContents.on('responsive', () => {
    crashLog.info(prefix, 'Window became responsive again')
  })
}

/** 主窗口（无边框 + 自定义标题栏） */
export function createMainWindow(): BrowserWindow {
  console.log('[window] 创建主窗口')
  crashLog.info('window', 'Creating main window')
  
  const win = new BrowserWindow(
    windowOptions({ width: 1200, height: 800, minWidth: 800, minHeight: 600, title: 'Stripchat Split' })
  )
  
  // 窗口关闭事件
  win.on('close', () => {
    console.log('[window] 主窗口 close 事件触发')
    crashLog.info('window', 'Main window close event')
  })
  
  win.on('closed', () => {
    console.log('[window] 主窗口 closed 事件触发')
    crashLog.info('window', 'Main window closed')
  })
  
  // 渲染进程崩溃
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] 渲染进程崩溃:', details)
    crashLog.fatal('window', 'Render process gone', details as any)
  })
  
  // 窗口无响应
  win.on('unresponsive', () => {
    console.error('[window] 主窗口无响应')
    crashLog.error('window', 'Main window unresponsive')
  })
  
  // 窗口恢复响应
  win.on('responsive', () => {
    console.log('[window] 主窗口恢复响应')
    crashLog.info('window', 'Main window responsive again')
  })
  
  // 首帧渲染完成后再显示窗口（防止打开时白屏）
  win.once('ready-to-show', () => {
    console.log('[window] 主窗口 ready-to-show')
    win.show()
  })
  attachRendererLogging(win, 'renderer')
  loadAppInto(win)
  return win
}

/** 双击卡片打开的独立播放器窗口：复用网页 WindowControls，#/player 路由 */
export function openPlayerWindow(model: { id?: string; username: string; displayName: string; avatar?: string }): BrowserWindow {
  const win = new BrowserWindow(
    windowOptions({ width: 960, height: 640, minWidth: 480, minHeight: 320, title: model.displayName || model.username })
  )
  denyNewWindows(win)
  win.once('ready-to-show', () => win.show())
  attachRendererLogging(win, 'player')

  const qs = new URLSearchParams({
    username: model.username,
    displayName: model.displayName,
    ...(model.id ? { id: model.id } : {}),
    ...(model.avatar ? { avatar: model.avatar } : {})
  }).toString()
  loadAppInto(win, `/player?${qs}`)
  return win
}
