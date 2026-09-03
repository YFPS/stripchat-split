import { defineConfig } from 'vitest/config'

// 独立的 vitest 配置：只跑纯 TS 模块测试（node 环境）。
// 存在本文件时 vitest 不再读取 vite.config.ts，避开 electron/vite 插件干扰。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts']
  }
})
