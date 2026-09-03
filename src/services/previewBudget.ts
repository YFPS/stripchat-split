import { previewStreamPool } from './streamPool'

/**
 * 预览墙解码预算：容量 = 视口内需要视频的直播卡片数。
 *
 * 为什么可以/需要这样做（依据来自网络文献与多路解码实测，2026-09 调研）：
 * - Chromium 媒体负责人 Dale Curtis《VideoNG》：视频渲染与主渲染管线解耦，
 *   软解跑在低特权进程，真正的成本瓶颈是「解码 → 渲染」之间的内存带宽，
 *   因此工程上应遵循 Agora《Large WebRTC Video Grids》的原则——
 *   "别解码超过所需的像素"（不超过视口实际需要的解码像素预算）。
 * - 多路 H.264 前端实测（1080P 监控大屏调研，i5-12400）：WASM/软解 1080P 每路
 *   占单核 20–30%；240p（预览墙锁的档位）像素约为 1080p 的 1/9，单路软解约
 *   2–4% 核，8 核 CPU 理论上限 16–24 路 → 视口内十几张卡全解码是可行的。
 * - stashapp 场景墙实践：对「多个小尺寸预览」，GPU 硬解有并发解码队列上限
 *   （约 8 路），小文件排队比解码还慢；软解多核 fan-out 反而更顺滑 ——
 *   与本应用禁用 GPU（disableHardwareAcceleration）的处境一致，方向被印证。
 *
 * 硬上限 MAX_PREVIEW_STREAMS 是软件解码的安全阀：超过后多余的直播卡回到
 * 封面 + LIVE 角标（等待空位），避免把整机 CPU 打满导致所有流一起卡。
 */

/** 同一时刻软件解码的预览流硬上限（240p 档位，8 核估算 16–24 路的保守下沿） */
export const MAX_PREVIEW_STREAMS = 16

let visibleLive = 0
let scheduled = false

/** 卡片声明「我需要在视口内解码」（直播 + 开启视频预览 + 在视口 + 未开分屏） */
export function addVisibleLive(): void {
  visibleLive += 1
  scheduleSync()
}

/** 卡片撤销上述声明（滚出视口 / 关预览 / 卸载） */
export function removeVisibleLive(): void {
  visibleLive = Math.max(0, visibleLive - 1)
  scheduleSync()
}

/**
 * 视口内卡片在滚动瞬间会成批进出（一次滚轮触发几十张卡片的 IO 回调），
 * 若每张卡都立即 setCapacity 会引发容量震荡与无意义的 notify 风暴。
 * 用 rAF 合并到同一帧只同步一次。
 */
function scheduleSync(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    previewStreamPool.setCapacity(Math.min(Math.max(visibleLive, 1), MAX_PREVIEW_STREAMS))
  })
}
