/**
 * 播放器挂载限速（错峰）：同一时刻最多 CONCURRENT_MOUNTS 路播放器处于
 * 「启动期」（动态 import hls.js → 建 Worker → 拉 master/level playlist → 首帧软解）。
 *
 * 为什么需要它：解码并发数已由 StreamPool 配额约束，但配额是一次性发放的 ——
 * 关闭分屏（splitViewActive 翻回 false）或首屏加载时，十几张卡片会在同一个
 * tick 里同时拿到配额、同时挂载 StripchatPlayer：一瞬间 N 个 hls Worker、
 * N 组 master+level 请求、N 路软解码器同时冷启动，形成启动风暴（惊群），
 * 表现为界面整体卡一下。这里把「真正挂载播放器」错峰：同一时刻最多放行
 * 4 路进入启动期，每路启动窗口 HOLD_MS 后自动释放名额给下一批。
 *
 * 对滚动场景零影响：稳态下队列空闲，pump 同步放行（不引入任何延迟）；
 * 只有成批翻转（分屏关闭/首屏/全选后开分屏）时才会排队消化。
 */

/** 同时处于启动期的播放器数上限 */
export const CONCURRENT_MOUNTS = 4

/** 每路启动期占用名额的窗口（覆盖 import + manifest + level + 首帧） */
export const HOLD_MS = 1200

let active = 0
const queue: Array<() => void> = []

function pump(): void {
  while (active < CONCURRENT_MOUNTS && queue.length > 0) {
    const start = queue.shift()!
    active++
    // 占住一个启动期名额，HOLD_MS 后释放给下一批。即便播放器中途被卸载
    // （滚出视口/重新开分屏），多压一个窗口也只是轻微保守限速，不值得
    // 为精确释放引入播放器 → 队列的反向通知。
    setTimeout(() => {
      active = Math.max(0, active - 1)
      pump()
    }, HOLD_MS)
    start()
  }
}

/**
 * 排队挂载。队列空闲且名额未满时同步放行（start 在本次调用内执行，零延迟）；
 * 名额满时入队，等前面的启动期窗口到期后陆续放行。
 * 返回撤销函数：卡片在排队期间（尚未放行）被卸载时调用，把它从队列撤出；
 * 已经放行后再调用是无害的空操作。
 */
export function enqueueMount(start: () => void): () => void {
  let started = false
  const entry = () => {
    started = true
    start()
  }
  queue.push(entry)
  pump()
  return () => {
    if (started) return
    const i = queue.indexOf(entry)
    if (i >= 0) queue.splice(i, 1)
  }
}

/** 测试专用：重置内部状态（正常代码不要调用） */
export function __resetForTest(): void {
  active = 0
  queue.length = 0
}
