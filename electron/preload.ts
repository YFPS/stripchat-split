import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronBridge, StreamModelInput } from '../src/bridge'

// ElectronBridge 契约的真实适配器：通过 contextBridge 暴露给渲染进程。
// 浏览器调试 mock（src/main.tsx）必须保持与本实现一致 —— 两侧都由
// ElectronBridge 接口约束，编译期即可发现漂移。
const api: ElectronBridge = {
  getCookies: (domain: string) => ipcRenderer.invoke('get-cookies', domain),
  setCookie: (cookie: any) => ipcRenderer.invoke('set-cookie', cookie),
  clearCookies: (domain: string) => ipcRenderer.invoke('clear-cookies', domain),
  openLogin: () => ipcRenderer.invoke('open-login'),
  getStreamId: (model: StreamModelInput) => ipcRenderer.invoke('get-stream-id', model),
  apiRequest: (req) => ipcRenderer.invoke('api-request', req),
  openPlayerWindow: (params) => ipcRenderer.invoke('open-player-window', params),
  onLoginClosed: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('login-closed', listener)
    return () => ipcRenderer.removeListener('login-closed', listener)
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
    close: () => ipcRenderer.invoke('window-close'),
    onMaximizedChange: (callback: (isMaximized: boolean) => void) => {
      const listener = (_e: unknown, v: boolean) => callback(v)
      ipcRenderer.on('window-maximized-changed', listener)
      return () => ipcRenderer.removeListener('window-maximized-changed', listener)
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
