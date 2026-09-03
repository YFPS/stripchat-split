import { useEffect, useRef, useState } from 'react'

type InViewCallback = (isIntersecting: boolean) => void

// 模块级共享 IntersectionObserver：所有 ModelCard 共用一个 observer，
// 避免几百张收藏卡各自创建实例造成开销。
const observerCallbacks = new Map<Element, Set<InViewCallback>>()
let sharedObserver: IntersectionObserver | null = null

function getSharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const callbacks = observerCallbacks.get(entry.target)
        if (!callbacks) continue
        for (const cb of callbacks) cb(entry.isIntersecting)
      }
      // 阈值 0.25：卡片至少 1/4 进入视口才算"可见"。预览预算按可见卡数量
      // 分配解码容量（Agora 视频墙经验：只解码用户看得到的像素），
      // 若阈值过低，屏幕边缘只露 1px 的一整行卡都会被计入解码预算。
    }, { threshold: 0.25 })
  }
  return sharedObserver
}

/**
 * 共享视口可见性 Hook：返回可绑定到卡片的 ref 与 inView 状态。
 * 与每个组件各自 new IntersectionObserver 的旧实现行为一致，
 * 但底层只保留一个全局 observer。
 */
export function useSharedInView<T extends Element = HTMLDivElement>() {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(true)

  useEffect(() => {
    const el = ref.current
    const observer = getSharedObserver()
    if (!el || !observer) return

    let callbacks = observerCallbacks.get(el)
    if (!callbacks) {
      callbacks = new Set()
      observerCallbacks.set(el, callbacks)
      observer.observe(el)
    }

    const cb: InViewCallback = (v) => setInView(v)
    callbacks.add(cb)

    return () => {
      callbacks.delete(cb)
      if (callbacks.size === 0) {
        observerCallbacks.delete(el)
        observer.unobserve(el)
      }
    }
  }, [])

  return { ref, inView }
}
