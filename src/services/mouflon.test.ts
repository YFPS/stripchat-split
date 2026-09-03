import { describe, it, expect } from 'vitest'
import { extractPkey, pkeyToPdkey, rewriteMediaPlaylist } from './mouflon'

// 金标向量：pdkey=Quean4cai9boJa5a（pkey=Zokee2OhPh9kugh4 对应）。
// 加密规则：base64(明文 XOR SHA256(pdkey)) 去掉填充后整体反转，作为段 URL 的
// 倒数第二段（_ 分隔）。向量由独立脚本按算法生成并固化，防止重构破坏解密链路。
const PDKEY = 'Quean4cai9boJa5a'
const ENC_1 = 'wUitrf0bTviP8rBT2WmT2CdSuk' // → stream/seg_12345.ts
const ENC_2 = 'wUit7e53DulP8rBT2WmT2CdSuk' // → stream/seg_67890.ts

describe('extractPkey', () => {
  it('提取 master playlist 中存在于 key 表的 pkey', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
      '#EXT-X-MOUFLON:PSCH:v2:Zokee2OhPh9kugh4',
      'chunklist.m3u8'
    ].join('\n')
    expect(extractPkey(master)).toBe('Zokee2OhPh9kugh4')
  })

  it('全部不在 key 表时回退返回第一个 PSCH key（交给上层判空）', () => {
    const master = '#EXT-X-MOUFLON:PSCH:v2:UnknownKey123\n#EXT-X-MOUFLON:PSCH:v2:AnotherKey'
    expect(extractPkey(master)).toBe('UnknownKey123')
  })

  it('无 PSCH 时返回 null', () => {
    expect(extractPkey('#EXTM3U\n#EXT-X-ENDLIST')).toBeNull()
  })
})

describe('pkeyToPdkey', () => {
  it('已知 pkey 返回 pdkey', () => {
    expect(pkeyToPdkey('Zokee2OhPh9kugh4')).toBe('Quean4cai9boJa5a')
  })

  it('未知 pkey 返回 null', () => {
    expect(pkeyToPdkey('nope')).toBeNull()
  })
})

describe('rewriteMediaPlaylist', () => {
  it('解密 #EXT-X-MOUFLON:URI 并把随后的假 media.mp4 行替换为真实段 URL', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      `#EXT-X-MOUFLON:URI:https://edge-hls.doppiocdn.com/hls/123/video_${ENC_1}_media.ts`,
      'https://fake.cdn/fake1.mp4',
      `#EXT-X-MOUFLON:URI:https://edge-hls.doppiocdn.com/hls/123/video_${ENC_2}_media.ts`,
      'https://fake.cdn/fake2.mp4',
      '#EXT-X-ENDLIST'
    ].join('\n')

    const out = await rewriteMediaPlaylist(playlist, PDKEY)
    const lines = out.split('\n')
    expect(lines[4]).toBe('https://edge-hls.doppiocdn.com/hls/123/video_stream/seg_12345.ts_media.ts')
    expect(lines[5]).toBe('https://edge-hls.doppiocdn.com/hls/123/video_stream/seg_67890.ts_media.ts')
    // URI 标记行本身必须被移除
    expect(out).not.toContain('#EXT-X-MOUFLON:URI:')
    // 其余行原样保留
    expect(lines[0]).toBe('#EXTM3U')
    expect(lines[1]).toBe('#EXT-X-VERSION:7')
    expect(lines[6]).toBe('#EXT-X-ENDLIST')
  })

  it('无 pdkey 时原样返回', async () => {
    const text = '#EXTM3U\n#EXT-X-ENDLIST'
    await expect(rewriteMediaPlaylist(text, '')).resolves.toBe(text)
  })

  it('URI 后没有跟随的 http 行时丢弃该标记（不产生悬空替换）', async () => {
    const playlist = `#EXTM3U\n#EXT-X-MOUFLON:URI:https://edge-hls.doppiocdn.com/hls/123/video_${ENC_1}_media.ts\n#EXT-X-ENDLIST`
    const out = await rewriteMediaPlaylist(playlist, PDKEY)
    expect(out.split('\n')).toEqual(['#EXTM3U', '#EXT-X-ENDLIST'])
  })

  it('URI 不含下划线（无法定位加密段）时原样透传', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MOUFLON:URI:https://cdn.example.com/plain.mp4',
      'https://fake.cdn/fake.mp4',
      '#EXT-X-ENDLIST'
    ].join('\n')
    const out = await rewriteMediaPlaylist(playlist, PDKEY)
    expect(out.split('\n')[1]).toBe('https://cdn.example.com/plain.mp4')
  })

  it('加密段非法 base64 时安全回退原 URI，不中断整个 playlist', async () => {
    const uri = 'https://cdn.example.com/hls/@@@bad@@@_media.ts'
    const playlist = ['#EXTM3U', `#EXT-X-MOUFLON:URI:${uri}`, 'https://fake.cdn/fake.mp4', '#EXT-X-ENDLIST'].join('\n')
    const out = await rewriteMediaPlaylist(playlist, PDKEY)
    expect(out.split('\n')).toEqual(['#EXTM3U', uri, '#EXT-X-ENDLIST'])
  })
})
