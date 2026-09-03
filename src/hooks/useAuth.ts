import { useCallback, useEffect } from 'react'
import { useAuthStore } from '../stores/authStore'
import { stripchatAPI, ApiError } from '../services/stripchat-api'

export function useAuth() {
  const { user, isAuthenticated, loading, error, setUser, setLoading, setError, logout: clearLocalAuth } = useAuthStore()

  const checkAuth = useCallback(async (force = false) => {
    setLoading(true)
    try {
      const { authenticated, user: userData } = await stripchatAPI.getAuthInfo(force)
      setUser(authenticated ? userData : null)
    } catch (err) {
      const e = err instanceof ApiError ? err : null
      setError(e?.kind === 'network' ? '网络错误，无法检查登录状态' : '认证检查失败')
    }
  }, [setLoading, setUser, setError])

  useEffect(() => {
    checkAuth()
    // 登录窗口关闭后强制重新鉴权（initial-dynamic 缓存可能还是旧的登录态）。
    // onLoginClosed 返回取消订阅函数，卸载时清理。
    const off = window.electronAPI.onLoginClosed(() => {
      checkAuth(true)
    })
    return off
  }, [checkAuth])

  /** 真实退出：先清 stripchat.com cookie（主进程 session），再清本地状态。
   *  否则 cookie 仍注入在 session 里，刷新后 checkAuth 又会重新登录 —— "退出"形同虚设。 */
  const logout = useCallback(async () => {
    try {
      await window.electronAPI.clearCookies('stripchat.com')
    } catch (e) {
      console.error('[auth] 清除 cookie 失败:', (e as Error).message)
    }
    clearLocalAuth()
  }, [clearLocalAuth])

  const openLogin = () => {
    window.electronAPI.openLogin().catch((e) => {
      console.error('[auth] 打开登录窗口失败:', (e as Error).message)
    })
  }

  return {
    user,
    isAuthenticated,
    loading,
    error,
    checkAuth,
    openLogin,
    logout
  }
}
