import { create } from 'zustand'
import { AuthState, User } from '../types'

interface AuthStore extends AuthState {
  setUser: (user: User | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  logout: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  isAuthenticated: false,
  user: null,
  loading: true,
  error: null,
  setUser: (user) => set({ user, isAuthenticated: !!user, loading: false }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  logout: () => set({ user: null, isAuthenticated: false, loading: false })
}))
