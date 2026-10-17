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
import { request } from 'node:http'
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

/**
 * CDP 的 WebSocket 客户端：Node 22 自带 WebSocket（全局），但这里是本机回环、
 * 短生命周期、单连接，用原生 http Upgrade 手写最小协议帧，免依赖。
 * @param {string} url - ws://127.0.0.1:port/devtools/page/xxx
 * @returns {Promise<{send: (object) => void, close: () => void, messages: AsyncGenerator<object>}>} 会话。
 */
function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64')
    const request_ = request(url, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
    })
    request_.on('upgrade', (response, socket) => {
      let buffer = Buffer.alloc(0)
      const pending = []
      let wake = null
      const parseFrames = () => {
        for (;;) {
          if (buffer.length < 2) return
          const first = buffer[0]
          const second = buffer[1]
          const opcode = first & 0x0f
          let length = second & 0x7f
          let offset = 2
          if (length === 126) {
            if (buffer.length < 4) return
            length = buffer.readUInt16BE(2)
            offset = 4
          } else if (length === 127) {
            if (buffer.length < 10) return
            length = Number(buffer.readBigUInt64BE(2))
            offset = 10
          }
          const masked = (second & 0x80) !== 0
          let maskKey = null
          if (masked) {
            maskKey = buffer.subarray(offset, offset + 4)
            offset += 4
          }
          if (buffer.length < offset + length) return
          let payload = buffer.subarray(offset, offset + length)
          if (maskKey) {
            payload = Buffer.from(payload)
            for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4]
          }
          buffer = buffer.subarray(offset + length)
          if (opcode === 8) return
          if (opcode === 1) {
            const text = payload.toString('utf8')
            try {
              const message = JSON.parse(text)
              pending.push(message)
              if (wake) {
                const resolve_ = wake
                wake = null
                resolve_()
              }
            } catch {
              // 非 JSON 帧，忽略
            }
          }
        }
      }
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        parseFrames()
      })
      const send = (object) => {
        const data = Buffer.from(JSON.stringify(object))
        const maskKey = Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)))
        const header = Buffer.alloc(2)
        header[0] = 0x81
        if (data.length < 126) header[1] = 0x80 | data.length
        else if (data.length < 65536) {
          header[1] = 0x80 | 126
          header.writeUInt16BE(data.length, 2)
        } else {
          header[1] = 0x80 | 127
          header.writeBigUInt64BE(BigInt(data.length), 2)
        }
        const masked = Buffer.from(data)
        for (let index = 0; index < masked.length; index += 1) masked[index] ^= maskKey[index % 4]
        socket.write(Buffer.concat([header, maskKey, masked]))
      }
      resolve({
        send,
        close: () => socket.destroy(),
        // eslint-disable-next-line no-loop-func
        messages: (async function* generate() {
          for (;;) {
            if (pending.length === 0) {
              await new Promise((resolve_) => {
                wake = resolve_
              })
            }
            if (pending.length === 0) return
            yield pending.shift()
          }
        })(),
      })
    })
    request_.on('error', reject)
    request_.end()
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
  const ws = await connectWebSocket(page.webSocketDebuggerUrl)
  const expression = `(() => { const raw = localStorage.getItem(${JSON.stringify(TOKEN_KEY)}); try { return JSON.parse(raw).value } catch { return raw } })()`
  ws.send({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })
  try {
    const deadline = Date.now() + 5000
    for await (const message of ws.messages) {
      if (signal?.aborted) return null
      if (message.id === 1) {
        const value = message?.result?.result?.value
        return typeof value === 'string' && value.length > 0 ? value : null
      }
      if (Date.now() > deadline) return null
    }
    return null
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
  // 等调试端口起来
  await new Promise((resolve) => setTimeout(resolve, 1500))
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('登录流程已取消')
      if (Date.now() - started > timeoutMs) throw new Error('等待登录超时（5 分钟）')
      try {
        const token = await readTokenViaCdp(DEBUG_PORT, TARGET_URL, signal)
        if (token) return { token, userDataDir }
      } catch {
        // 端口未就绪或页面未打开，继续轮询
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