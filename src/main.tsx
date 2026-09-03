import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import type { ElectronBridge } from './bridge'

// 浏览器（Chrome MCP 调试）兜底：preload 未注入 window.electronAPI 时，
// 注入完整的 ElectronBridge mock（与 electron/preload.ts 的真实实现同一契约）。
// - cam 查询回退走 Vite proxy（可能被 CF 拒，仅调试用）
// - 登录/窗口控制只能提示不可用
// 仅开发环境注入：生产包里 window.electronAPI 由 preload 提供，
// 带上这段 mock 只会白增体积并提供一个"看起来能用"的错误分支。
if (import.meta.env.DEV && typeof window !== 'undefined' && !(window as any).electronAPI) {
  const mock: ElectronBridge = {
    getCookies: async () => [],
    setCookie: async () => {},
    clearCookies: async () => {},
    openLogin: async () => {
      console.warn('[browser-mode] 登录窗口仅在桌面端（Electron）可用')
      alert('登录功能仅在桌面端（Electron）可用，请在 pnpm dev 或打包后使用。')
    },
    // 浏览器调试：直接探测 doppiocdn master + variant 二级验证（无 CF 拦截、允许跨域）。
    // 缺数字 id 时无法拉模型页（CF 拦渲染进程），按查询失败处理。
    getStreamId: async (model) => {
      if (!model.id || !/^\d+$/.test(model.id)) {
        return { ok: false, message: 'browser mode: missing numeric id' }
      }
      try {
        const url = `https://edge-hls.doppiocdn.com/hls/${model.id}/master/${model.id}_auto.m3u8`
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
        if (res.status === 404) return { ok: true, id: null }
        if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
        const text = await res.text()
        if (!text.includes('#EXTM3U') || text.includes('/cpa/v2/')) return { ok: true, id: null }
        const pkey = text.match(/PSCH:v2:([A-Za-z0-9]+)/)?.[1]
        const variant = text.split('\n').find((l) => l.includes('.m3u8') && !l.startsWith('#'))
        if (!pkey || !variant) return { ok: true, id: null }
        const sep = variant.includes('?') ? '&' : '?'
        const vres = await fetch(`${variant}${sep}psch=v2&pkey=${pkey}`, { signal: AbortSignal.timeout(10000) })
        if (!vres.ok) return vres.status === 404 ? { ok: true, id: null } : { ok: false, message: `HTTP ${vres.status}` }
        const vtext = await vres.text()
        if (vtext.includes('#EXTM3U') && !vtext.includes('/cpa/v2/')) return { ok: true, id: model.id }
        return { ok: true, id: null }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      }
    },
    // 浏览器调试回退：走 Vite proxy（Node TLS 指纹可能被 CF 拒，仅调试用）
    apiRequest: async (req) => {
      try {
        const res = await fetch(req.path, {
          method: req.method || 'GET',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...(req.headers || {}) }
        })
        let data: any = null
        try {
          data = await res.json()
        } catch {
          /* 非 JSON */
        }
        return { ok: res.ok, status: res.status, data }
      } catch (e) {
        return { ok: false, status: 0, data: null, error: (e as Error).message }
      }
    },
    openPlayerWindow: async (params) => {
      const qs = new URLSearchParams({
        username: params.username,
        displayName: params.displayName,
        ...(params.avatar ? { avatar: params.avatar } : {})
      }).toString()
      window.open(`/#/player?${qs}`, '_blank')
    },
    onLoginClosed: () => () => {
      /* 浏览器无登录窗口事件 */
    },
    windowControls: {
      minimize: async () => {},
      maximizeToggle: async () => {},
      close: async () => {},
      onMaximizedChange: () => () => {}
    }
  }
  ;(window as any).electronAPI = mock
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// ── 渲染进程崩溃日志 ──────────────────────────────────────────
// 全局未捕获异常
window.addEventListener('error', (event) => {
  const record = {
    timestamp: new Date().toISOString(),
    type: 'window.error',
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error?.stack ?? ''
  }
  console.error('[crash-log]', record)
  try {
    const existing = localStorage.getItem('crash-logs')
    const logs = existing ? JSON.parse(existing) : []
    logs.push(record)
    if (logs.length > 20) logs.splice(0, logs.length - 20)
    localStorage.setItem('crash-logs', JSON.stringify(logs))
  } catch { /* ignore */ }
})

// 全局未处理的 Promise rejection
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const record = {
    timestamp: new Date().toISOString(),
    type: 'unhandledrejection',
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : ''
  }
  console.error('[crash-log]', record)
  try {
    const existing = localStorage.getItem('crash-logs')
    const logs = existing ? JSON.parse(existing) : []
    logs.push(record)
    if (logs.length > 20) logs.splice(0, logs.length - 20)
    localStorage.setItem('crash-logs', JSON.stringify(logs))
  } catch { /* ignore */ }
})
