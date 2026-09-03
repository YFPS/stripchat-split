import { describe, it, expect } from 'vitest'
import { pickLowestLevelIndex, masterUrlFor } from './streamSource'

/**
 * 这些用例锁死一个曾真实发生过的线上 bug：预览墙「锁最低清晰度」的代码
 * 写成了 `hls.levels.length - 1`，而 hls.js 的 levels 是升序排列（index 0
 * 最低档），于是实际锁的是最高档 —— 16 路预览全部按 720p/1080p 软解，
 * 解码像素是 240p 方案的 9～20 倍，客户端越播越卡。
 */
describe('pickLowestLevelIndex', () => {
  it('升序排列时取最低档（stripchat 220236716 的真实变体）', () => {
    const levels = [
      { bitrate: 674713, height: 240 },
      { bitrate: 1435033, height: 480 },
      { bitrate: 2684211, height: 720 }
    ]
    expect(pickLowestLevelIndex(levels)).toBe(0)
  })

  it('降序排列时同样取最低档（不依赖 hls.js 的排列顺序）', () => {
    const levels = [
      { bitrate: 2684211, height: 720 },
      { bitrate: 1435033, height: 480 },
      { bitrate: 674713, height: 240 }
    ]
    expect(pickLowestLevelIndex(levels)).toBe(2)
  })

  it('乱序时取最低档', () => {
    const levels = [
      { bitrate: 1435033, height: 480 },
      { bitrate: 674713, height: 240 },
      { bitrate: 2684211, height: 720 }
    ]
    expect(pickLowestLevelIndex(levels)).toBe(1)
  })

  it('含 1080p 的四档流仍取最低档', () => {
    const levels = [
      { bitrate: 674713, height: 240 },
      { bitrate: 1435033, height: 480 },
      { bitrate: 2684211, height: 720 },
      { bitrate: 5242880, height: 1080 }
    ]
    expect(pickLowestLevelIndex(levels)).toBe(0)
  })

  it('RESOLUTION 缺失（height 不存在）时按 bitrate 取最小', () => {
    const levels = [{ bitrate: 2684211 }, { bitrate: 674713 }, { bitrate: 1435033 }]
    expect(pickLowestLevelIndex(levels)).toBe(1)
  })

  it('码率相同则退化为取高度更小的', () => {
    const levels = [
      { bitrate: 1000000, height: 720 },
      { bitrate: 1000000, height: 480 }
    ]
    expect(pickLowestLevelIndex(levels)).toBe(1)
  })

  it('空数组与单元素不报错', () => {
    expect(pickLowestLevelIndex([])).toBe(0)
    expect(pickLowestLevelIndex([{ bitrate: 674713, height: 240 }])).toBe(0)
  })

  it('首项为 null 时跳过它而不是把它当最低档', () => {
    const levels = [null, { bitrate: 2684211, height: 720 }, { bitrate: 674713, height: 240 }]
    expect(pickLowestLevelIndex(levels)).toBe(2)
  })
})

describe('masterUrlFor', () => {
  it('按约定拼出 doppiocdn 的 master 地址', () => {
    expect(masterUrlFor('220236716')).toBe(
      'https://edge-hls.doppiocdn.com/hls/220236716/master/220236716_auto.m3u8'
    )
  })
})
