import { net } from 'electron'
import { CHROME_UA } from './login'

// 直播流探测（2026-09 实测）：旧 /cam 端点已被 Cloudflare 全面封禁（对所有客户端
// 一律 418，真实 Chrome 也不例外），站点直播已迁移到 doppiocdn 直连 HLS。新机制：
//   1) 数字 id 存在时，GET edge-hls master playlist 判定直播状态：
//      200 + #EXTM3U（且非 /cpa/v2/ 广告占位）= 可能是直播，variant 带 psch 复验：
//      200 = 直播中（id 即流 id）；403/404 = 未开播。doppiocdn 无 CF 拦截。
//   2) 收藏项缺数字 id（历史数据）时兜底拉模型页 HTML（需 Chromium 网络栈过 CF），
//      从 SSR initial state 提取数字 id 后再走 1)。
// 返回结果区分"明确知道直播状态"与"查询失败"，失败交给渲染侧重试计划。

export type StreamResult =
  | { ok: true; id: string | null }
  | { ok: false; message: string }

export interface StreamModelInput {
  /** 主播数字 id（收藏列表自带）；缺省时走模型页兜底解析 */
  id?: string | null
  username: string
  /** true = 绕过 CDN 边缘缓存探测（master 有 max-age=6 缓存，复查确认必须拿新鲜数据） */
  fresh?: boolean
}

function masterUrl(streamId: string): string {
  return `https://edge-hls.doppiocdn.com/hls/${streamId}/master/${streamId}_auto.m3u8`
}

type ProbeResult = 'live' | 'offline' | { error: string }

async function probeStream(streamId: string, fresh = false): Promise<ProbeResult> {
  // fresh=true 给 URL 加缓存破坏参数：master 有 max-age=6 的 CDN 缓存，
  // 复查确认若读到同一份缓存，"二次确认"会被同一个瞬时状态骗两次。
  const bust = fresh ? `?_t=${Date.now()}` : ''
  // 判离线时记录原因 —— 排查"直播中却被判未开播"需要知道 CDN 到底返回了什么
  const offline = (reason: string): ProbeResult => {
    console.log(`[stream] 探测判离线 ${streamId}: ${reason}`)
    return 'offline'
  }
  try {
    const res = await net.fetch(masterUrl(streamId) + bust, {
      headers: { 'User-Agent': CHROME_UA, Referer: 'https://stripchat.com/' },
      signal: AbortSignal.timeout(10000)
    })
    if (res.status === 404) return offline('master 404')
    if (!res.ok) return { error: `edge-hls HTTP ${res.status}` }
    const text = await res.text()
    if (!text.includes('#EXTM3U')) return offline('master 非 m3u8')
    if (text.includes('/cpa/v2/')) return offline('master 为广告占位')

    // 二级验证：master 有 CDN 缓存（max-age=6），实测存在"master 200 但真实流
    // 不服务"的状态（刚下播/私密秀等，表现为所有 variant 带 psch 请求失败）。
    // 取第一个 variant 带 psch 复验，避免把这种状态误报成直播。
    // 判别（2026-09-03 实测，edge-hls master 的 variant 指向 media-hls.doppiocdn.com）：
    //   psch 请求 200 + #EXTM3U（非 /cpa/v2/）= 直播中，返回真实媒体播放列表
    //   psch 请求 403 = 未开播/广告态（旧版此场景返回 404，CDN 行为已变更）
    //   psch 请求 404 = 已终止/不存在
    // PSCH 是跨主播的静态集群 key（同批 master 的 11 个 key 完全相同），
    // 取第一个即可解锁直播流，不存在"key 与档位错配"问题。
    const pkey = text.match(/PSCH:v2:([A-Za-z0-9]+)/)?.[1]
    const variant = text.split('\n').find((l) => l.includes('.m3u8') && !l.startsWith('#'))
    if (!pkey || !variant) return offline('master 缺 PSCH/variant')
    // 广告占位模板的 variant 自带 ?playlistType=standard（同批 master 全部 403），
    // 直接判离线，省一次注定失败的 psch 请求
    if (variant.includes('playlistType=standard')) return offline('variant 为广告占位模板')
    const sep = variant.includes('?') ? '&' : '?'
    const vres = await net.fetch(`${variant}${sep}psch=v2&pkey=${pkey}${fresh ? `&_t=${Date.now()}` : ''}`, {
      headers: { 'User-Agent': CHROME_UA, Referer: 'https://stripchat.com/' },
      signal: AbortSignal.timeout(10000)
    })
    if (vres.status === 404 || vres.status === 403) return offline(`variant HTTP ${vres.status}`)
    if (!vres.ok) return { error: `edge-hls variant HTTP ${vres.status}` }
    const vtext = await vres.text()
    if (vtext.includes('#EXTM3U') && !vtext.includes('/cpa/v2/')) return 'live'
    return offline('variant 非直播内容')
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** 兜底：从模型页 HTML 的 SSR state 提取数字 id（null=用户不存在；{error}=查询失败） */
async function resolveIdFromPage(username: string): Promise<string | null | { error: string }> {
  try {
    const res = await net.fetch(`https://stripchat.com/${encodeURIComponent(username)}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/html,*/*', Referer: 'https://stripchat.com/' },
      signal: AbortSignal.timeout(15000)
    })
    if (res.status === 404) return null
    if (!res.ok) return { error: `model page HTTP ${res.status}` }
    const html = await res.text()
    // 必须锚定 username 取 id：页面里除了当前主播的 SSR state，还嵌了相关推荐等
    // 其他模型的 JSON，直接抓第一个 "model":{"id" 可能拿到别人的 id —— 表现为
    // 格子上写着 A 的名字、播的却是 B 的流。在 username 出现位置附近找 id。
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const uIdx = html.search(new RegExp(`"username"\\s*:\\s*"${escaped}"`, 'i'))
    if (uIdx === -1) return null
    const nearby = html.slice(Math.max(0, uIdx - 500), uIdx + 500)
    return nearby.match(/"id"\s*:\s*(\d{5,})/)?.[1] ?? null
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function fetchStreamId(model: StreamModelInput): Promise<StreamResult> {
  const numericId = model.id && /^\d+$/.test(model.id) ? model.id : null

  if (!numericId) {
    const resolved = await resolveIdFromPage(model.username)
    if (resolved && typeof resolved === 'object') return { ok: false, message: resolved.error }
    if (resolved === null) return { ok: true, id: null }
    console.log(`[stream] 模型页解析 ${model.username} -> id=${resolved}`)
    const probe = await probeStream(resolved, model.fresh)
    if (probe === 'live') return { ok: true, id: resolved }
    if (probe === 'offline') return { ok: true, id: null }
    return { ok: false, message: probe.error }
  }

  const probe = await probeStream(numericId, model.fresh)
  if (probe === 'live') return { ok: true, id: numericId }
  if (probe === 'offline') return { ok: true, id: null }
  console.log(`[stream] edge-hls 探测失败 ${model.username}(${numericId}): ${probe.error}`)
  return { ok: false, message: probe.error }
}
