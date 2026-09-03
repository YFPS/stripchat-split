// hls.js (ESM vendor) 类型声明 —— 直接下载的单文件，不走包管理器
declare module '*/hls.min.mjs' {
  export interface HlsConfig {
    loader?: any
    [key: string]: unknown
  }
  export interface LoaderContext {
    type: string
    url: string
    [key: string]: unknown
  }
  export default class Hls {
    constructor(config?: HlsConfig)
    static isSupported(): boolean
    static DefaultConfig: { loader: any }
    static Events: {
      MANIFEST_PARSED: string
      ERROR: string
      LEVEL_SWITCHED: string
      [key: string]: string
    }
    static ErrorTypes: { [key: string]: string }
    static ErrorDetails: { [key: string]: string }
    levels: Array<{ height?: number; [key: string]: unknown }>
    currentLevel: number
    autoLevelCapping: number
    attachMedia(video: HTMLMediaElement): void
    loadSource(url: string): void
    on(event: string, callback: (event: unknown, data: unknown) => void): void
    destroy(): void
  }
  export class Hls {}
}
