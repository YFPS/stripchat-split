/**
 * 最小 CDP（Chrome DevTools Protocol）WebSocket 客户端。
 * 用途：直连外部 Chrome 的远程调试端口读取登录 cookie。
 * 纯 Node 实现（node:http/net/crypto），不依赖系统 Node 的 WebSocket、
 * 不依赖任何 npm 包 —— 主进程内置，换机器无需安装 Node。
 */

import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

export interface CdpCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
  expires: number
}

// ── WebSocket 帧编解码 ────────────────────────────────────────────────

const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** 客户端帧：必须带掩码（RFC 6455） */
function encodeClientFrame(payload: Buffer, opcode: number): Buffer {
  const maskKey = crypto.randomBytes(4)
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ maskKey[i % 4]

  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, maskKey, masked])
}

interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** 增量帧解析器：TCP 分块到达，缓冲到能解析出完整帧 */
class FrameParser {
  // 显式 Buffer（默认 ArrayBufferLike）：Buffer.concat/subarray 的返回泛型
  // 与 alloc 的 Buffer<ArrayBuffer> 不一致，推断会卡住赋值
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const frames: Frame[] = []
    for (;;) {
      const f = this.tryParse()
      if (!f) break
      frames.push(f)
    }
    return frames
  }

  private tryParse(): Frame | null {
    const b = this.buf
    if (b.length < 2) return null
    const fin = !!(b[0] & 0x80)
    const opcode = b[0] & 0x0f
    const masked = !!(b[1] & 0x80)
    let len = b[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < 4) return null
      len = b.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (b.length < 10) return null
      const big = b.readBigUInt64BE(2)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
      len = Number(big)
      off = 10
    }
    const maskLen = masked ? 4 : 0
    if (b.length < off + maskLen + len) return null
    let payload = b.subarray(off + maskLen, off + maskLen + len)
    if (masked) {
      const key = b.subarray(off, off + 4)
      const unmasked = Buffer.alloc(len)
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ key[i % 4]
      payload = unmasked
    }
    this.buf = b.subarray(off + maskLen + len)
    return { fin, opcode, payload }
  }
}

// ── CDP 调用 ──────────────────────────────────────────────────────────

function httpGetJson(url: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    // agent:false —— 一次性请求不进入连接池，用完即关，避免占用本地端口
    const req = http.get(url, { timeout: timeoutMs, agent: false }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(e instanceof Error ? e : new Error('bad json'))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timeout`)))
    req.on('error', reject)
  })
}

/** 建立 WS 连接、发一条 CDP 命令、等对应 id 的响应后关闭 */
function cdpCall(wsUrl: string, method: string, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(wsUrl)
    } catch {
      reject(new Error(`invalid ws url: ${wsUrl}`))
      return
    }
    const port = Number(u.port) || 80
    const sock = net.connect(port, u.hostname)
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error(`CDP ${method} timeout`)), timeoutMs)

    // HTTP Upgrade 握手
    const key = crypto.randomBytes(16).toString('base64')
    const handshake = [
      `GET ${u.pathname}${u.search} HTTP/1.1`,
      `Host: ${u.hostname}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      ''
    ].join('\r\n')

    let handshakeDone = false
    let pending = Buffer.alloc(0)
    const parser = new FrameParser()
    let message = '' // 当前累积的消息（处理分片）
    let messageOpened = false

    const handleFrames = (frames: Frame[]) => {
      for (const f of frames) {
        if (f.opcode === OP_TEXT || f.opcode === OP_BINARY) {
          messageOpened = true
          message = f.payload.toString('utf8')
          if (f.fin) finishMessage()
        } else if (f.opcode === 0x0 && messageOpened) {
          // continuation 帧：大消息分片的后续部分
          message += f.payload.toString('utf8')
          if (f.fin) finishMessage()
        } else if (f.opcode === OP_PING) {
          sock.write(encodeClientFrame(Buffer.from(''), OP_PONG))
        } else if (f.opcode === OP_CLOSE) {
          fail(new Error('CDP connection closed by peer'))
        }
        // OP_PONG 忽略
      }
    }

    const finishMessage = () => {
      try {
        const msg = JSON.parse(message)
        if (msg?.id === 1) {
          if (msg.error) fail(new Error(`CDP error: ${JSON.stringify(msg.error)}`))
          else {
            settled = true
            clearTimeout(timer)
            sock.destroy()
            resolve(msg.result)
          }
        }
      } catch {
        /* 消息不完整/非 JSON，忽略 */
      }
      message = ''
      messageOpened = false
    }

    sock.on('connect', () => sock.write(handshake))
    sock.on('data', (chunk) => {
      if (!handshakeDone) {
        pending = Buffer.concat([pending, chunk])
        const idx = pending.indexOf('\r\n\r\n')
        if (idx === -1) return
        const head = pending.subarray(0, idx).toString('latin1')
        if (!head.startsWith('HTTP/1.1 101')) {
          fail(new Error(`CDP upgrade failed: ${head.split('\r\n')[0] || 'unknown'}`))
          return
        }
        handshakeDone = true
        const rest = pending.subarray(idx + 4)
        pending = Buffer.alloc(0)
        // 握手完成后立即发送 CDP 命令
        sock.write(encodeClientFrame(Buffer.from(JSON.stringify({ id: 1, method })), OP_TEXT))
        if (rest.length > 0) handleFrames(parser.push(rest))
        return
      }
      handleFrames(parser.push(chunk))
    })
    sock.on('error', (e) => fail(e))
    sock.on('close', () => {
      if (!settled) fail(new Error('CDP socket closed'))
    })
  })
}

/**
 * 从远程调试端口读取全部 cookie（可过滤域名）。
 * 任何失败都返回空数组（调用方按"还没登录"处理），错误记日志。
 */
export async function fetchCookiesViaCdp(port: number, domainFilter?: string): Promise<CdpCookie[]> {
  try {
    const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`)
    const page = (targets || []).find((t: any) => t.type === 'page' && !!t.webSocketDebuggerUrl)
    if (!page) {
      console.log(`[cdp] no page target on port ${port}`)
      return []
    }
    const result = await cdpCall(page.webSocketDebuggerUrl, 'Network.getAllCookies')
    const cookies: CdpCookie[] = Array.isArray(result?.cookies) ? result.cookies : []
    return domainFilter ? cookies.filter((c) => c.domain.includes(domainFilter)) : cookies
  } catch (e) {
    console.log('[cdp] fetch cookies failed:', (e as Error).message)
    return []
  }
}
