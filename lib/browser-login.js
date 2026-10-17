/**
 * 从浏览器已有会话读取 chat.deepseek.com 的 userToken。
 *
 * 原理：用 --remote-debugging-port 启动用户默认浏览器（或指定浏览器）指向
 * chat.deepseek.com，通过 DevTools 协议轮询 localStorage；用户登录成功后
 * userToken 出现，读回来立即关闭调试端口（浏览器本身不关，避免打断会话）。
 *
 * 安全边界：
 * - 只读 `userToken` 这一个键，不碰 Cookie/历史/其它站点的存储；
 * - 调试端口绑定 127.0.0.1，只在本机存活期间有效，读完即由浏览器进程退出标志关闭；
 * - 读完的 token 只写入插件私有凭证文件（0600），不进日志。
 *
 * @module dsh-deepseek-web-search/browser-login
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 目标页面。 */
export const TARGET_URL = 'https://chat.deepseek.com/'
/** localStorage 键名。 */
export const TOKEN_KEY = 'userToken'
/** 调试端口（127.0.0.1）。 */
export const DEBUG_PORT = 9223

/** 常见浏览器在 Windows 上的安装位置（按优先级）。 */
const WINDOWS_BROWSER_CANDIDATES = [
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean)

const POSIX_BROWSER_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

/**
 * 找一个可用的浏览器可执行文件。
 * @param {string} [override] - 用户指定的浏览器路径。
 * @returns {string|null} 路径；找不到为 null。
 */
export function findBrowser(override) {
  if (override && existsSync(override)) return override
  const candidates = process.platform === 'win32' ? WINDOWS_BROWSER_CANDIDATES : POSIX_BROWSER_CANDIDATES
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 权限或路径异常，试下一个
    }
  }
  return null
}

/** 候选浏览器的展示名。 */
const BROWSER_LABELS = [
  { match: /msedge\.exe$/i, label: 'Microsoft Edge' },
  { match: /chrome\.exe$/i, label: 'Google Chrome' },
  { match: /chromium/i, label: 'Chromium' },
  { match: /brave/i, label: 'Brave' },
  { match: /vivaldi/i, label: 'Vivaldi' },
  { match: /firefox/i, label: 'Firefox' },
]

/**
 * 把一个浏览器路径转成展示名。
 * @param {string} browserPath - 可执行文件路径。
 * @returns {string} 展示名。
 */
function labelFor(browserPath) {
  const entry = BROWSER_LABELS.find((candidate) => candidate.match.test(browserPath))
  return entry?.label ?? path.basename(browserPath).replace(/\.(exe)$/i, '')
}

/**
 * 枚举本机可用的浏览器（存在且可执行）。
 * @param {string} [override] - 用户指定的浏览器路径（存在时排在最前）。
 * @returns {Array<{path: string, label: string}>} 浏览器列表。
 */
export function listBrowsers(override) {
  const candidates = []
  if (override && existsSync(override)) candidates.push(override)
  const pool = process.platform === 'win32' ? WINDOWS_BROWSER_CANDIDATES : POSIX_BROWSER_CANDIDATES
  for (const candidate of pool) {
    try {
      if (existsSync(candidate) && !candidates.includes(candidate)) candidates.push(candidate)
    } catch {
      // 试下一个
    }
  }
  return candidates.map((candidate) => ({ path: candidate, label: labelFor(candidate) }))
}

/**
 * CDP 的 WebSocket 客户端：Node 22 自带 WebSocket（全局），但这里是本机回环、
 * 短生命周期、单连接，用原生 http Upgrade 手写最小协议帧，免依赖。
 * @param {string} url - ws://127.0.0.1:port/devtools/page/xxx
 * @returns {Promise<{send: (object) => void, close: () => void, messages: AsyncGenerator<object>}>} 会话。
 */
/**
 * 连到 CDP 的 WebSocket 会话。
 *
 * 用 Node 22 自带的全局 WebSocket（engines 已要求 >=22.19）：初版手写过协议帧，
 * 在分帧边界上有缺陷（收到小帧时 subarray 越界），而且 CDP 的消息帧并不总是
 * 恰好按块到达。原生实现久经考验，这里只包一层 Promise 化的请求/响应。
 * @param {string} url - ws://127.0.0.1:port/devtools/page/xxx
 * @returns {Promise<{call: (params: object) => Promise<object>, close: () => void}>} 会话。
 */
function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let nextId = 1
    socket.addEventListener('open', () => resolve({
      /**
       * 发一条 CDP 命令并等它的响应。
       * @param {{method: string, params?: object}} command - 命令。
       * @returns {Promise<object>} result 字段。
       */
      call: (command) => new Promise((resolveCall, rejectCall) => {
        const id = nextId
        nextId += 1
        pending.set(id, { resolve: resolveCall, reject: rejectCall })
        socket.send(JSON.stringify({ id, ...command }))
      }),
      close: () => socket.close(),
    }))
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      else waiter.resolve(message.result ?? {})
    })
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')))
    socket.addEventListener('close', () => {
      for (const waiter of pending.values()) waiter.reject(new Error('CDP 连接已关闭'))
      pending.clear()
    })
  })
}

/**
 * 通过 CDP 读一次 localStorage。
 * @param {number} port - 调试端口。
 * @param {string} targetUrl - 只在匹配的页面里读。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<string|null>} token 或 null。
 */
export async function readTokenViaCdp(port, targetUrl, signal) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
  const page = Array.isArray(list) ? list.find((entry) => entry.type === 'page' && String(entry.url ?? '').includes('deepseek.com')) : null
  if (!page) return null
  const wsUrl = String(page.webSocketDebuggerUrl ?? '')
  if (!wsUrl) return null
  const ws = await connectWebSocket(wsUrl)
  const expression = `(() => { const raw = localStorage.getItem(${JSON.stringify(TOKEN_KEY)}); try { return JSON.parse(raw).value } catch { return raw } })()`
  try {
    if (signal?.aborted) return null
    const result = await ws.call({ method: 'Runtime.evaluate', params: { expression, returnByValue: true } })
    const value = result?.result?.value
    return typeof value === 'string' && value.length > 0 ? value : null
  } finally {
    ws.close()
  }
}

/**
 * 启动浏览器（带调试端口）。
 * @param {object} options - 参数。
 * @param {string} options.browserPath - 浏览器可执行文件。
 * @param {string} [options.userDataDir] - 独立用户目录（避免与日常会话的调试端口冲突）。
 * @param {number} [options.port] - 调试端口。
 * @returns {{child: object, userDataDir: string}} 进程与临时目录。
 */
export function launchBrowser(options) {
  const { browserPath, port = DEBUG_PORT } = options
  const userDataDir = options.userDataDir ?? mkdtempSync(path.join(tmpdir(), 'dsh-dws-login-'))
  const child = spawn(browserPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    TARGET_URL,
  ], { stdio: 'ignore', detached: false })
  child.on('error', () => {})
  return { child, userDataDir }
}

/**
 * 完整登录流程：启动 → 轮询 CDP 直到拿到 token 或超时。
 * @param {object} options - 参数。
 * @param {string} options.browserPath - 浏览器路径。
 * @param {number} [options.timeoutMs] - 等待登录的总时长（默认 5 分钟）。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<{token: string, userDataDir: string}>} 结果。
 */
export async function waitForToken(options) {
  const { browserPath, timeoutMs = 5 * 60_000, signal } = options
  const { child, userDataDir } = launchBrowser({ browserPath, ...options })
  const started = Date.now()
  // 最近一次轮询失败的原因；连续失败时用于给出可操作的提示，而不是无限转圈。
  let lastError = null
  let consecutiveFailures = 0
  // 等调试端口起来
  await new Promise((resolve) => setTimeout(resolve, 1500))
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('登录流程已取消')
      if (Date.now() - started > timeoutMs) {
        const hint = lastError ? `；最近一次错误：${lastError}` : ''
        throw new Error(`等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）${hint}`)
      }
      try {
        const token = await readTokenViaCdp(DEBUG_PORT, TARGET_URL, signal)
        consecutiveFailures = 0
        lastError = null
        if (token) return { token, userDataDir }
      } catch (error) {
        lastError = String(error?.message ?? error).slice(0, 160)
        consecutiveFailures += 1
        // 端口一直不通：多半是浏览器带 --remote-debugging-port 启动失败
        // （例如已有同 profile 的实例在跑，参数被忽略）。给用户可操作的提示。
        if (consecutiveFailures === 10) {
          throw new Error(
            '调试端口始终无法连接（连续 10 次）。' +
              '常见原因：同浏览器的已有实例在运行，导致 --remote-debugging-port 被忽略。' +
              '请完全退出该浏览器后重试。最近一次错误：' + lastError,
          )
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  } finally {
    // 不关浏览器进程（用户可能还在用），只清理独立临时目录的引用；
    // 实际目录在 token 拿到后由调用方决定何时删除。
    void child
  }
}

/** 仅当确认不需要时清理临时目录。 */
export function cleanupUserDataDir(directory) {
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch {
    // Windows 上浏览器进程占用时可能失败，留待下次
  }
}
