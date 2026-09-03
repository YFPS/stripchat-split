import { extractPkey, pkeyToPdkey, rewriteMediaPlaylist } from './mouflon'

/**
 * 流源构建：把"主播数字 id"变成 hls.js 可加载的 master 地址 + Mouflon 感知的
 * loader 配置。原先这些知识散在 StripchatPlayer 组件里（URL 模板 + loader 原型
 * 补丁），协议关注与 UI 关注纠缠；收敛后播放器只消费本模块。
 */

/** doppiocdn master playlist 地址模板（实测） */
export function masterUrlFor(streamId: string): string {
  return `https://edge-hls.doppiocdn.com/hls/${streamId}/master/${streamId}_auto.m3u8`
}

/**
 * 从 hls.js 的 levels 里挑出**最低档**的下标。
 *
 * 不要写成 `levels.length - 1`：hls.js 的 levels 是升序（index 0 = 最低档），
 * 排序由 filterAndSortMediaOptions 的比较器 `e.height - t.height` 决定，
 * 且 getMinLevel 也是从 index 0 往上扫 —— 所以 `length - 1` 拿到的是最高档。
 * 这里显式按码率（退化到高度）求最小值，不依赖任何排列顺序假设。
 *
 * 只比较 bitrate：EXT-X-STREAM-INF 的 BANDWIDTH 是必填属性，而 RESOLUTION
 * 是可选的，所以 bitrate 永远可靠、height 可能缺失。
 */
export function pickLowestLevelIndex(
  levels: Array<{ bitrate?: number; height?: number } | undefined | null>
): number {
  if (!levels.length) return 0
  let lowest = 0
  levels.forEach((l, i) => {
    if (!l) return
    const best = levels[lowest]
    const bestBitrate = best?.bitrate ?? Number.POSITIVE_INFINITY
    const bitrate = l.bitrate ?? Number.POSITIVE_INFINITY
    if (bitrate < bestBitrate) {
      lowest = i
    } else if (bitrate === bestBitrate && (l.height ?? 0) < (best?.height ?? 0)) {
      lowest = i
    }
  })
  return lowest
}

/**
 * 构建 Mouflon 感知的 hls.js loader：
 * 1) 变体 playlist 自动追加 ?psch=v2&pkey={pkey}（否则拿到假的空 playlist）
 * 2) master playlist 里提取 pkey/pdkey
 * 3) media playlist 的 #EXT-X-MOUFLON:URI 段解密后替换假 media.mp4
 */
export function createMouflonLoader(baseLoader: any): any {
  const shared: { pkey: string | null; pdkey: string | null } = { pkey: null, pdkey: null }

  const Base = baseLoader
  function ScPLoader(this: any, cfg: unknown) {
    this.base = new Base(cfg)
  }
  ScPLoader.prototype.load = function (this: any, context: any, config: unknown, callbacks: any) {
    if (context.type === 'level' && shared.pkey && context.url.indexOf('psch=') < 0) {
      context.url += (context.url.indexOf('?') >= 0 ? '&' : '?') + 'psch=v2&pkey=' + encodeURIComponent(shared.pkey)
    }
    const onSuccess = callbacks.onSuccess
    callbacks.onSuccess = function (response: any, stats: unknown, ctx: unknown, net: unknown) {
      const d = response.data
      if (typeof d === 'string') {
        if (d.indexOf('#EXT-X-STREAM-INF') >= 0) {
          // master playlist：提取 pkey（优先 keys 里存在的）
          const pkey = extractPkey(d)
          if (pkey) {
            shared.pkey = pkey
            shared.pdkey = pkeyToPdkey(pkey)
          }
        }
        if (d.indexOf('#EXT-X-MOUFLON:URI:') >= 0 && shared.pdkey) {
          // media playlist：解密段 URL 后替换假的 media.mp4
          rewriteMediaPlaylist(d, shared.pdkey).then((fixed) => {
            response.data = fixed
            onSuccess(response, stats, ctx, net)
          })
          return
        }
      }
      onSuccess(response, stats, ctx, net)
    }
    this.base.load(context, config, callbacks)
  }
  ScPLoader.prototype.abort = function (this: any) {
    this.base.abort()
  }
  ScPLoader.prototype.destroy = function (this: any) {
    this.base.destroy()
  }
  Object.defineProperty(ScPLoader.prototype, 'stats', {
    get(this: any) {
      return this.base.stats
    }
  })
  Object.defineProperty(ScPLoader.prototype, 'context', {
    get(this: any) {
      return this.base.context
    }
  })
  return ScPLoader
}
