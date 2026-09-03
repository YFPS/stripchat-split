/**
 * 浏览器可执行文件探测：按平台多级查找 CloakBrowser，找不到回退 Chrome/Edge/Chromium。
 * 换机器/用户级安装/自定义盘符都能命中；全都没有时返回 null 由上层报错。
 * 纯 Node 实现（fs/os/path），不依赖 electron API，便于测试。
 * 
 * 优先级：
 * 1. 环境变量 STRIPCHAT_BROWSER_PATH（用户显式指定）
 * 2. CloakBrowser（隐身浏览器，适合绕过 Cloudflare 检测）
 * 3. Google Chrome
 * 4. Microsoft Edge
 * 5. Chromium
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface BrowserBinary {
  /** 可执行文件绝对路径 */
  path: string
  /** 展示名（日志/错误提示用） */
  name: string
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** Windows：CloakBrowser → Chrome → Edge 的常见安装位置（环境变量展开，反斜杠路径） */
function windowsCandidates(): BrowserBinary[] {
  const pf = process.env['ProgramFiles']
  const pf86 = process.env['ProgramFiles(x86)']
  const local = process.env['LOCALAPPDATA']
  const appdata = process.env['APPDATA']

  const locations: Array<[string | undefined, string, string]> = [
    // CloakBrowser（隐身浏览器，优先检测）
    [local, 'CloakBrowser\\cloakbrowser.exe', 'CloakBrowser'],
    [appdata, 'CloakBrowser\\cloakbrowser.exe', 'CloakBrowser'],
    [pf, 'CloakBrowser\\cloakbrowser.exe', 'CloakBrowser'],
    // Google Chrome
    [pf, 'Google\\Chrome\\Application\\chrome.exe', 'Google Chrome'],
    [pf86, 'Google\\Chrome\\Application\\chrome.exe', 'Google Chrome'],
    [local, 'Google\\Chrome\\Application\\chrome.exe', 'Google Chrome'],
    // Microsoft Edge
    [pf, 'Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Edge'],
    [pf86, 'Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Edge'],
    [local, 'Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Edge']
  ]
  return locations
    .filter(([base]) => !!base)
    .map(([base, rel, name]) => ({ path: path.join(base as string, rel), name }))
}

/** macOS：CloakBrowser / Chrome / Edge / Chromium 的系统与用户级应用目录 */
function macCandidates(): BrowserBinary[] {
  const home = os.homedir()
  const apps = [
    // CloakBrowser（隐身浏览器，优先检测）
    ['/Applications/CloakBrowser.app/Contents/MacOS/CloakBrowser', 'CloakBrowser'],
    [path.join(home, 'Applications/CloakBrowser.app/Contents/MacOS/CloakBrowser'), 'CloakBrowser'],
    // Google Chrome
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome'],
    ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Microsoft Edge'],
    ['/Applications/Chromium.app/Contents/MacOS/Chromium', 'Chromium'],
    [path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'Google Chrome'],
    [path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), 'Microsoft Edge']
  ]
  return apps.map(([p, name]) => ({ path: p, name }))
}

/** Linux：常见二进制名 + 常见安装前缀（snap 版 Chromium 也在 /snap/bin） */
function linuxCandidates(): BrowserBinary[] {
  const names = [
    // CloakBrowser（隐身浏览器，优先检测）
    'cloakbrowser',
    'cloak-browser',
    // Google Chrome
    'google-chrome',
    'google-chrome-stable',
    // Chromium
    'chromium',
    'chromium-browser',
    // Microsoft Edge
    'microsoft-edge',
    'microsoft-edge-stable'
  ]
  const prefixes = ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome', '/opt/cloakbrowser']
  const out: BrowserBinary[] = []
  for (const name of names) {
    for (const prefix of prefixes) {
      out.push({ path: path.join(prefix, name), name })
    }
  }
  return out
}

/**
 * 探测本机可用的 Chromium 内核浏览器（CDP 兼容：CloakBrowser/Chrome/Edge/Chromium 均可）。
 * 找不到返回 null。
 * 
 * 优先级：
 * 1. 环境变量 STRIPCHAT_BROWSER_PATH（用户显式指定）
 * 2. CloakBrowser（隐身浏览器，适合绕过 Cloudflare 检测）
 * 3. Google Chrome
 * 4. Microsoft Edge
 * 5. Chromium
 */
export function findBrowserBinary(): BrowserBinary | null {
  // 允许用户显式指定（便携版/自定义路径）
  const override = process.env.STRIPCHAT_BROWSER_PATH
  if (override && exists(override)) {
    return { path: override, name: path.basename(override) }
  }

  const candidates =
    process.platform === 'darwin'
      ? macCandidates()
      : process.platform === 'win32'
        ? windowsCandidates()
        : linuxCandidates()

  for (const c of candidates) {
    if (exists(c.path)) return c
  }
  return null
}
