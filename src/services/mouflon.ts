// Stripchat Mouflon 流解密。
// 算法来源：bymakk/webcam_preview（GitHub）实测验证：
//   1) master playlist 含 #EXT-X-MOUFLON:PSCH:v2:{pkey}
//   2) 变体 playlist 需加 ?psch=v2&pkey={pkey} 才返回真实直播段
//   3) 段 URL 倒数第二段（_ 分隔）是加密的：反转 → base64 → XOR SHA256(pdkey) → utf8
//   4) pdkey 来自 stripchat_mouflon_keys.json（pkey -> pdkey 映射）
import mouflonKeysRaw from '../data/mouflon-keys.json'

// JSON 字面量类型没有索引签名，转成 Record 便于按 pkey 查询
const mouflonKeys: Record<string, string> = mouflonKeysRaw as Record<string, string>

export type MouflonKeyMap = Record<string, string>

/** SHA-256(pdkey 的 UTF-8 字节)，带 promise 缓存：同一 pdkey 只算一次 */
const sha256Cache = new Map<string, Promise<Uint8Array>>()

async function sha256Bytes(key: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return new Uint8Array(buf)
}

function sha256BytesCached(key: string): Promise<Uint8Array> {
  let cached = sha256Cache.get(key)
  if (!cached) {
    cached = sha256Bytes(key)
    sha256Cache.set(key, cached)
  }
  return cached
}

/** base64 → XOR SHA256(pdkey) → utf8 */
async function mouflonDecrypt(b64: string, pdkey: string, precomputedHash?: Uint8Array): Promise<string> {
  const hash = precomputedHash ?? await sha256BytesCached(pdkey)
  let s = String(b64).replace(/=+$/, '')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i) ^ hash[i % hash.length]
  }
  return new TextDecoder().decode(out)
}

/** 解密段 URL：倒数第二段反转 + mouflonDecrypt，替换回 URL */
async function decodeMouflonUri(uri: string, pdkey: string, precomputedHash?: Uint8Array): Promise<string> {
  if (!pdkey) return uri
  const parts = uri.split('_')
  if (parts.length < 2) return uri
  const enc = parts[parts.length - 2]
  try {
    const dec = await mouflonDecrypt(enc.split('').reverse().join(''), pdkey, precomputedHash)
    return dec ? uri.replace(enc, dec) : uri
  } catch {
    return uri
  }
}

/** 重写 media playlist：#EXT-X-MOUFLON:URI 后的假 media.mp4 换成真实段 URL */
export async function rewriteMediaPlaylist(text: string, pdkey: string): Promise<string> {
  const lines = text.split('\n')
  const idx: { i: number; uri: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXT-X-MOUFLON:URI:(.*)$/)
    if (m) idx.push({ i, uri: m[1].trim() })
  }

  // 同一 playlist 内只算一次 SHA-256，再并行解密所有 segment
  const hash = pdkey ? await sha256BytesCached(pdkey) : undefined
  const real: Record<number, string> = {}
  await Promise.all(idx.map(async (it) => {
    real[it.i] = await decodeMouflonUri(it.uri, pdkey, hash)
  }))

  const out: string[] = []
  let pending: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^#EXT-X-MOUFLON:URI:/.test(line)) {
      pending = real[i] || null
      continue
    }
    if (pending && /^https?:\/\//.test(line.trim())) {
      out.push(pending)
      pending = null
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** 从 master playlist 提取 pkey（必须是 keys 里存在的） */
export function extractPkey(text: string): string | null {
  const found = (text.match(/PSCH:v2:([A-Za-z0-9]+)/g) || []).map((s) => s.split(':').pop()!)
  return found.find((k) => mouflonKeys[k]) || found[0] || null
}

/** 根据 pkey 取 pdkey */
export function pkeyToPdkey(pkey: string): string | null {
  return mouflonKeys[pkey] || null
}

export { mouflonKeys }
