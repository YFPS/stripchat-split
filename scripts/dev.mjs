// 零依赖开发启动器：先起 Vite，等 5174 可用后启动 Electron 并注入 VITE_DEV_SERVER_URL
import { spawn } from 'node:child_process'
import http from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const PORT = 5174
const DEV_SERVER_URL = `http://localhost:${PORT}`

// require('electron') 在主进程里返回二进制可执行路径字符串
let electronBin
try {
  electronBin = require('electron')
} catch (err) {
  console.error('[dev] 找不到 electron，请先 pnpm install', err)
  process.exit(1)
}

/** 轮询 Vite dev server，超时则报错退出 */
function waitForDevServer(url, timeoutMs = 30000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        // 任意 HTTP 响应都说明服务已起来
        res.resume()
        if (res.statusCode) {
          resolve()
        } else {
          retry()
        }
      })
      req.on('error', retry)
      req.setTimeout(2000, () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`[dev] Vite dev server 在 ${timeoutMs}ms 内未就绪: ${url}`))
        return
      }
      setTimeout(tick, 500)
    }
    tick()
  })
}

function killAll(code) {
  // 让子进程随主进程一起退出
  Object.values(children).forEach((child) => {
    if (child && !child.killed) child.kill()
  })
  process.exit(code ?? 0)
}

const children = {}

async function main() {
  // 1) 启动 Vite（直接用 node 跑 vite 的 JS 入口，避免 Windows 下 spawn .cmd 报 EINVAL）
  const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  const vite = spawn(process.execPath, [viteBin], {
    cwd: projectRoot,
    stdio: 'inherit'
  })
  children.vite = vite
  vite.on('exit', (code) => {
    console.log(`[dev] vite 退出 (code=${code})`)
    killAll(code ?? 0)
  })

  // 2) 等待 Vite 可用
  try {
    await waitForDevServer(DEV_SERVER_URL)
    console.log(`[dev] Vite 已就绪: ${DEV_SERVER_URL}`)
  } catch (err) {
    console.error(err.message)
    killAll(1)
    return
  }

  // 3) 启动 Electron（委托给 scripts/electron-runner.cjs）。
  //    vite-plugin-electron 默认会自己启动 Electron，但它不会清理本机强制注入的
  //    ELECTRON_RUN_AS_NODE=1（会令 electron 退化为纯 Node，require('electron').app 为 undefined）。
  //    因此：在 vite.config.ts 里用空 onstart 禁掉插件的自动启动，由这里用清理过的 env 启动。
  delete process.env.ELECTRON_RUN_AS_NODE
  const electron = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'electron-runner.cjs')], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: DEV_SERVER_URL
    }
  })
  console.log('[dev] electron spawned, pid =', electron.pid)
  children.electron = electron
  electron.on('exit', (code) => {
    console.log(`[dev] electron 退出 (code=${code})`)
    // 不立即 killAll，等待用户手动重启或 Ctrl+C
    // killAll(code ?? 0)
  })
}

// Ctrl+C / 异常退出时确保子进程被回收
process.on('SIGINT', () => killAll(0))
process.on('SIGTERM', () => killAll(0))
process.on('uncaughtException', (err) => {
  console.error('[dev] 未捕获异常:', err)
  killAll(1)
})

main()
