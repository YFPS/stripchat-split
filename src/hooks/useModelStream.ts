import { useEffect, useState } from 'react'
import { stripchatAPI } from '../services/stripchat-api'
import { StreamStatus } from '../services/streamChecker'
import { StreamModelInput } from '../bridge'

/**
 * 单主播直播状态（doppiocdn master 实时确认）：独立播放器窗口、分屏格子共用。
 * 原先 SplitPlayer.SplitCell 与 PlayerWindow 各自手写一套
 * "cancelled 标志 + 三态渲染"的 effect，逻辑完全重复；收敛到这里。
 *
 * 查询失败（网络/CF/超时）做有界重试，耗尽才按离线处理 —— 原先一次性探测，
 * 开分屏瞬间多路并发、主进程请求排队，一次 10s 超时就直接把直播中的主播
 * 显示成"未开播"（假离线）。CDN master 有 6s 缓存，刚开播的窗口期 psch
 * 复验也会 403，重试正好跨过这个窗口。
 * 注意：ok 且 id 为 null 是"明确未开播"，不重试；只有 !ok（查询本身失败）才重试。
 * refreshKey 变化会重新发起一轮探测（分屏格子的 offline 自愈用）。
 * enabled=false 时不探测（store 已确认 live 的格子不重复发请求）。
 */
const RETRY_DELAYS_MS = [1500, 4000]

export function useModelStream(model: StreamModelInput, refreshKey = 0, enabled = true): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>({ phase: 'checking' })
  const { id, username } = model

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    setStatus({ phase: 'checking' })

    const attempt = (n: number) => {
      stripchatAPI.getStreamId({ id, username }).then((result) => {
        if (cancelled) return
        if (result.ok) {
          setStatus(result.id ? { phase: 'live', id: result.id } : { phase: 'offline' })
          return
        }
        // 查询失败：有界重试，耗尽才按离线处理
        if (n < RETRY_DELAYS_MS.length) {
          timer = setTimeout(() => {
            if (!cancelled) attempt(n + 1)
          }, RETRY_DELAYS_MS[n])
          return
        }
        setStatus({ phase: 'offline' })
      }, () => {
        // bridge promise 理论上不 reject（结果走 StreamResult），防御兜底
        if (!cancelled) setStatus({ phase: 'offline' })
      })
    }
    attempt(0)

    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [id, username, refreshKey, enabled])

  return status
}
