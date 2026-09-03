import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { fetchCookiesViaCdp } from './cdp-client'

// ── mock CDP server：模拟外部 Chrome 的 /json/list + WebSocket 端点 ────

/** 服务端帧（不掩码） */
function serverFrame(payload: Buffer | string, opcode = 0x1): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  let header: Buffer
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  return Buffer.concat([header, data])
}

/** 解析客户端帧（只处理小帧 + 掩码，测试用） */
function parseClientFrame(buf: Buffer): { payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null
  const masked = !!(buf[1] & 0x80)
  const len = buf[1] & 0x7f
  if (len >= 126 || !masked) return null
  if (buf.length < 2 + 4 + len) return null
  const key = buf.subarray(2, 6)
  const payload = Buffer.alloc(len)
  for (let i = 0; i < len; i++) payload[i] = buf[6 + i] ^ key[i % 4]
  return { payload, rest: buf.subarray(6 + len) }
}

interface MockOpts {
  cookies?: any[]
  chunked?: boolean
  noPage?: boolean
}

async function startMockCdp(opts: MockOpts = {}): Promise<{ port: number; close(): Promise<void> }> {
  // upgrade 事件给的是 Duplex 而非 net.Socket，只约束用到的 destroy
  const sockets = new Set<{ destroy(): void }>()
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/json/list' && !opts.noPage) {
      const port = (server.address() as net.AddressInfo).port
      res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }]))
      return
    }
    res.end(JSON.stringify([]))
  })

  server.on('connection', (s) => sockets.add(s))
  server.on('upgrade', (_req, socket) => {
    sockets.add(socket)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dummy\r\n\r\n'
    )
    let buf: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = parseClientFrame(buf)
        if (!parsed) break
        buf = parsed.rest
        let msg: any = null
        try {
          msg = JSON.parse(parsed.payload.toString('utf8'))
        } catch {
          continue
        }
        if (msg?.method === 'Network.getAllCookies') {
          const response = JSON.stringify({ id: msg.id, result: { cookies: opts.cookies ?? [] } })
          if (opts.chunked) {
            // 分片：text 帧 FIN=0 + continuation 帧 FIN=1
            const half = Math.floor(response.length / 2)
            socket.write(
              Buffer.concat([
                Buffer.from([0x01, half]),
                Buffer.from(response.slice(0, half)),
                Buffer.from([0x80, response.length - half]),
                Buffer.from(response.slice(half))
              ])
            )
          } else {
            socket.write(serverFrame(response))
          }
        }
      }
    })
  })

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    close: () =>
      new Promise<void>((res) => {
        // 先销毁所有跟踪到的连接（upgrade socket 不在 server 的连接表里，
        // 只靠 server.close 会一直等待）
        for (const s of sockets) s.destroy()
        sockets.clear()
        server.close(() => res())
      })
  }
}

const COOKIES = [
  { name: 'auth', value: 'token123', domain: '.stripchat.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 1750000000 },
  { name: 'pref', value: 'dark', domain: 'stripchat.com', path: '/', secure: true, httpOnly: false, sameSite: 'None', expires: 0 },
  { name: 'other', value: 'x', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'Lax', expires: 0 }
]

const servers: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

describe('fetchCookiesViaCdp', () => {
  it('正常读取 cookie 并按域名过滤', async () => {
    const s = await startMockCdp({ cookies: COOKIES })
    servers.push(s)
    const result = await fetchCookiesViaCdp(s.port, 'stripchat.com')
    expect(result.length).toBe(2)
    expect(result.map((c) => c.name).sort()).toEqual(['auth', 'pref'])
    expect(result.find((c) => c.name === 'auth')?.value).toBe('token123')
  })

  it('不传过滤条件时返回全部 cookie', async () => {
    const s = await startMockCdp({ cookies: COOKIES })
    servers.push(s)
    const result = await fetchCookiesViaCdp(s.port)
    expect(result.length).toBe(3)
  })

  it('分片响应（FIN=0 + continuation）能正确拼接', async () => {
    const s = await startMockCdp({ cookies: COOKIES.slice(0, 1), chunked: true })
    servers.push(s)
    const result = await fetchCookiesViaCdp(s.port, 'stripchat')
    expect(result.length).toBe(1)
    expect(result[0].name).toBe('auth')
  })

  it('端口没有服务时返回空数组（不抛错）', async () => {
    const result = await fetchCookiesViaCdp(1, 'stripchat.com') // 端口 1 无服务
    expect(result).toEqual([])
  })

  it('/json/list 无 page target 时返回空数组', async () => {
    const s = await startMockCdp({ noPage: true })
    servers.push(s)
    const result = await fetchCookiesViaCdp(s.port, 'stripchat.com')
    expect(result).toEqual([])
  })
})
