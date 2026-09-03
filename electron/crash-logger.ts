/**
 * 主进程崩溃日志记录器
 * 所有日志写入用户数据目录下的 crash.log，便于事后排查
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'crash.log')

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

function timestamp(): string {
  return new Date().toISOString()
}

// 标记：是否正在写日志（防止 EPIPE 死循环）
let _writing = false
// 标记：stdout/stderr 管道是否已断开
let _pipeBroken = false

// 监听 stdout/stderr 的 EPIPE 错误
process.stdout.on('error', (err) => {
  if ((err as any).code === 'EPIPE') _pipeBroken = true
})
process.stderr.on('error', (err) => {
  if ((err as any).code === 'EPIPE') _pipeBroken = true
})

function writeLog(level: string, category: string, message: string, details?: Record<string, unknown>): void {
  const line = `[${timestamp()}] [${level}] [${category}] ${message}${details ? ' | ' + JSON.stringify(details) : ''}\n`
  
  // 始终写入文件（这是主要日志通道）
  try {
    // 检查日志文件大小，超过 5MB 则截断保留最后 1MB
    try {
      const stat = fs.statSync(LOG_FILE)
      if (stat.size > 5 * 1024 * 1024) {
        const content = fs.readFileSync(LOG_FILE, 'utf-8')
        const lines = content.split('\n')
        // 保留最后 10000 行
        const trimmed = lines.slice(-10000).join('\n')
        fs.writeFileSync(LOG_FILE, trimmed, 'utf-8')
      }
    } catch { /* 文件不存在或读取失败，忽略 */ }
    
    fs.appendFileSync(LOG_FILE, line, 'utf-8')
  } catch {
    // 文件写入失败也不能抛出
  }
  
  // 控制台输出：仅在管道正常且非重入时输出
  if (!_pipeBroken && !_writing) {
    _writing = true
    try {
      if (level === 'ERROR' || level === 'FATAL') {
        process.stderr.write(line)
      } else {
        process.stdout.write(line)
      }
    } catch {
      // EPIPE 等错误，标记管道断开
      _pipeBroken = true
    } finally {
      _writing = false
    }
  }
}

export const crashLog = {
  info(category: string, message: string, details?: Record<string, unknown>) {
    writeLog('INFO', category, message, details)
  },
  warn(category: string, message: string, details?: Record<string, unknown>) {
    writeLog('WARN', category, message, details)
  },
  error(category: string, message: string, details?: Record<string, unknown>) {
    writeLog('ERROR', category, message, details)
  },
  fatal(category: string, message: string, details?: Record<string, unknown>) {
    writeLog('FATAL', category, message, details)
  },
  /** 获取日志文件路径（渲染进程可通过 IPC 获取） */
  getLogPath: () => LOG_FILE
}
