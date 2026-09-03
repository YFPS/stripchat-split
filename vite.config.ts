import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import path from 'path'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'

// ── Clash HTTP 代理 CONNECT agent（零依赖）───────────────────────────────
// 本机存在 Clash（verge-mihomo，127.0.0.1:7897）时，Node 直连 stripchat 会因
// DNS 污染（系统解析到不可达 IP）失败，而 Chrome 走代理能访问。
// 让 Vite proxy 也走 Clash：目标域名解析交给代理侧，绕过本地 DNS 污染。
// 代理未运行（如 Clash 退出）时自动回退直连。

const PROXY_HOST = '127.0.0.1'
const PROXY_PORT = 7897

/** 探测本地代理端口是否存活 */
function proxyAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: PROXY_HOST, port: PROXY_PORT })
    sock.on('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => resolve(false))
  })
}

/** https.Agent：先对代理发 CONNECT 建立隧道，再在隧道上做 TLS */
class ConnectProxyAgent extends https.Agent {
  constructor() {
    super({ keepAlive: false })
  }

  createConnection(options: any, callback: (err: Error | null, socket?: any) => void) {
    const req = http.request({
      host: PROXY_HOST,
      port: PROXY_PORT,
      method: 'CONNECT',
      path: `${options.host}:${options.port}`,
      headers: { Host: `${options.host}:${options.port}` }
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        callback(new Error(`CONNECT ${options.host}:${options.port} failed: ${res.statusCode}`))
        return
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.host,
        rejectUnauthorized: true
      })
      tlsSocket.on('secureConnect', () => callback(null, tlsSocket))
      tlsSocket.on('error', (err) => callback(err))
    })
    req.on('error', (err) => callback(err))
    req.end()
  }
}

export default defineConfig(async () => {
  // vite.config 支持 async：启动时探测一次代理是否可用
  const useProxy = await proxyAvailable()
  if (useProxy) {
    console.log(`[vite] 检测到本地代理 ${PROXY_HOST}:${PROXY_PORT}，/api 转发将经由代理`)
  }

  return {
    plugins: [
      react(),
      electron([
        {
          entry: 'electron/main.ts',
          // 不让插件自己启动 Electron（它会带着本机注入的 ELECTRON_RUN_AS_NODE 启动导致崩溃）。
          // 改由 scripts/dev.mjs 用清理过的 env 启动。这里给个空 onstart 阻止自动启动。
          onstart() {
            /* Electron 由外部 dev.mjs 启动 */
          },
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: {
                external: ['electron']
              }
            }
          }
        },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron'
          }
        }
      }
      ])
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    },
    server: {
      // 专用端口：5173 常被本机其他项目（resin-params）的 dev server 占用，
      // 两个 vite 会按 IPv4/IPv6 分裂同一端口，导致 Electron 窗口随机加载错误应用
      port: 5174,
      strictPort: true,
      // 把 /api 转发到 stripchat（浏览器与 Electron 渲染进程都走相对路径，绕开 CORS）。
      // 走代理时：目标域名由 Clash 解析转发；不走代理时：直连（依赖本机 DNS 正常）。
      proxy: {
        '/api': {
          target: 'https://stripchat.com',
          changeOrigin: true,
          secure: true,
          agent: useProxy ? new ConnectProxyAgent() : undefined
        }
      }
    }
  }
})
