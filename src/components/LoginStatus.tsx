import React from 'react'
import { useAuth } from '../hooks/useAuth'

export const LoginStatus: React.FC = () => {
  const { user, isAuthenticated, loading, openLogin, logout, checkAuth } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center gap-2">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-shockingly-green" />
        <span className="text-sm text-surface-50 font-mori">检查登录状态...</span>
      </div>
    )
  }

  if (isAuthenticated && user) {
    return (
      <div className="flex items-center gap-3">
        {user.avatar ? (
          <img
            src={user.avatar}
            alt={user.username}
            className="w-8 h-8 rounded-full"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-shockingly-green flex items-center justify-center text-just-black text-sm font-semibold font-mori">
            {(user.username || '?').slice(0, 1).toUpperCase()}
          </div>
        )}
        <span className="text-sm font-medium text-surface-cream font-mori">{user.username}</span>
        <button
          onClick={() => checkAuth(true)}
          className="text-xs text-surface-50 hover:text-surface-cream transition-colors duration-150 font-mori"
        >
          刷新
        </button>
        <button
          onClick={logout}
          className="text-xs text-surface-50 hover:text-surface-cream transition-colors duration-150 font-mori"
        >
          退出
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={openLogin}
        className="btn-ghost-sm font-mori"
      >
        登录 Stripchat
      </button>
      <button
        onClick={() => checkAuth(true)}
        className="text-xs text-surface-50 hover:text-surface-cream transition-colors duration-150 font-mori"
      >
        检测登录
      </button>
    </div>
  )
}
