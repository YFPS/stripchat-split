// 字段语义对齐 stripchat 真实接口（/api/front/v2/models 列表返回）：
// - displayName: stripchat 无此字段，统一回退为 username
// - avatar: 映射 previewUrlThumbSmall || avatarUrl
export interface Model {
  id: string
  username: string
  displayName: string
  avatar: string
  isOnline: boolean
  viewers: number
}

export interface FavoriteModel extends Model {
  addedAt: number
}

export interface AuthState {
  isAuthenticated: boolean
  user: User | null
  loading: boolean
  error: string | null
}

export interface User {
  id: string
  username: string
  email: string
  avatar: string
}

export interface LayoutConfig {
  cols: number
  rows: number
}
