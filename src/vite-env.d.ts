/// <reference types="vite/client" />

import type { ElectronBridge } from './bridge'

declare global {
  interface Window {
    /** 始终存在：Electron 下由 preload 注入，浏览器调试由 main.tsx 注入 mock */
    electronAPI: ElectronBridge
  }
}

export {}
