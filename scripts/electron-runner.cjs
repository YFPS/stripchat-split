// 专用 Electron 启动器：在 require/启动 electron 之前先彻底清除 ELECTRON_RUN_AS_NODE。
// 该进程被 dev.mjs 用"干净 env"启动（env 里不含 ELECTRON_RUN_AS_NODE），
// 这里再做一次双保险：1) delete process.env；2) 手动过滤构造 env 对象（Windows 上仅靠 delete 不可靠）。
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const path = require('node:path')

delete process.env.ELECTRON_RUN_AS_NODE

const projectRoot = path.resolve(__dirname, '..')
const require_ = createRequire(__filename)
const electronBin = require_('electron')

// 手动过滤掉 ELECTRON_RUN_AS_NODE（大小写都滤），确保 spawn 的 env 对象里绝对没有这个 key
const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) {
  if (k.toUpperCase() !== 'ELECTRON_RUN_AS_NODE') cleanEnv[k] = v
}

// 目标工作目录（项目根，含 package.json main 指向 dist-electron/main.js）
const target = cleanEnv.ELECTRON_TARGET_DIR || projectRoot

const child = spawn(electronBin, [target], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: cleanEnv
})

child.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => child.kill())
process.on('SIGTERM', () => child.kill())
