import { useEffect, useRef, useState } from 'react'
import { StreamPool, previewStreamPool } from '../services/streamPool'

/**
 * 视口驱动的视频槽位：wanted（直播中 + 未切封面 + 卡片在视口内）时申请全局
 * 解码配额，拿到才真正挂载 hls 播放器；不想播/滚出视口立即释放，
 * 让其他可见卡片竞争空位。
 */
export function useStreamSlot(key: string, wanted: boolean, pool: StreamPool = previewStreamPool): boolean {
  const [granted, setGranted] = useState(false)
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted

  // wanted 变化（进入/离开视口、开关视频预览）时重新申请/释放槽位；
  // 如果漏掉 wanted，卡片只会在首次挂载时申请，滚出视口不释放，
  // 后面滚入视口的卡片也永远竞争不到空位。
  useEffect(() => {
    const update = () => setGranted(pool.request(key, wantedRef.current))
    update()
    const off = pool.subscribe(update, key)
    return () => {
      off()
      pool.release(key)
    }
  }, [key, wanted, pool])

  return granted
}
