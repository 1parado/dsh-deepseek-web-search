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

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 目标页面。 */
export const TARGET_URL = 'https://chat.deepseek.com/'
/** localStorage 键名。 */
export const TOKEN_KEY = 'userToken'
/** 调试端口（127.0.0.1）。可用 $DSH_CDP_PORT 覆盖。 */
export const DEBUG_PORT = Number(process.env.DSH_CDP_PORT) || 9223

/** 常见浏览器在 Windows 上的安装位置（按优先级）。这只是兜底，主路径是注册表。 */
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
 * Windows 注册表里会登记浏览器真实安装位置的键。
 *
 * 只查这两类：`App Paths`（应用注册的绝对路径）与 `Uninstall`（安装器写入的
 * DisplayIcon）。这样无论用户把浏览器装在 C 盘、D 盘还是便携目录，都能找到 ——
 * 固定路径列表只能覆盖"默认安装"这一种情况。
 */
const WINDOWS_REGISTRY_KEYS = [
  // Chrome
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  // Edge
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
  // Chromium（社区构建常用这个名字）
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chromium.exe',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chromium.exe',
  // Brave / Vivaldi 走 Uninstall 的 DisplayIcon
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BraveSoftware Brave-Browser',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BraveSoftware Brave-Browser',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{Vivaldi}',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{Vivaldi}',
]

/**
 * 解析要用的浏览器可执行文件。
 *
 * 用户明确指定了路径时**严格使用**，不存在就报错 —— 静默换成另一个浏览器
 * 是最糟的行为（用户选了 Chrome 却弹出 Edge，还会带着错误的预期去登录）。
 * 只有没有指定时才按发现顺序自动挑。
 * @param {string} [override] - 用户指定的浏览器路径。
 * @returns {string|null} 路径；找不到为 null。
 * @throws {Error} 指定的路径不存在时。
 */
export function findBrowser(override) {
  if (typeof override === 'string' && override.trim()) {
    const requested = override.trim()
    if (existsSync(requested)) return requested
    throw new Error(`指定的浏览器不存在：${requested}。请检查路径，或清空让它自动选择。`)
  }
  return listBrowsers()[0]?.path ?? null
}

/**
 * 解析 Windows 的系统默认浏览器（HTTPS 关联）。
 *
 * 链路：UserChoice 的 ProgId → HKCR\<ProgId>\shell\open\command → 剥出 exe。
 * 用户机器上的默认可能是装在 AppData 等非标准位置的 Chromium 系浏览器，
 * 固定路径列表永远找不到 —— 这条链路才能覆盖"系统默认"这种真实状态。
 * @returns {{path: string, label: string}|null} 默认浏览器；解析失败为 null。
 */
export function resolveDefaultBrowser() {
  if (process.platform !== 'win32') return null
  try {
    // 注册表键名里的反斜杠在 JS 字符串里有转义歧义（'\S' 会被吃成 'S'，
    // '\\\\' 经 here-string 写入又变成 4 个字符），用 String.raw 一锤定音。
    const choice = execFileSync('reg', [
      'query',
      String.raw`HKCU\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`,
      '/v', 'ProgId',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const progId = /\bProgId\s+REG_SZ\s+(\S+)/.exec(choice)?.[1]
    if (!progId) return null
    const command = execFileSync('reg', [
      'query', ['HKCR', progId, 'shell', 'open', 'command'].join('\\'), '/ve',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const raw = /\bREG_SZ\s+(.+)\r?\n?/.exec(command)?.[1]?.trim()
    if (!raw) return null
    // 命令形如 "C:\...\app.exe" --single-argument %1，或 C:\...\app.exe %1
    let executable = null
    const quoted = /^"([^"]+)"/.exec(raw)
    if (quoted) executable = quoted[1]
    else executable = raw.split(/\s+/)[0]
    if (!executable || !/\.exe$/i.test(executable)) return null
    return { path: executable, label: `${labelFor(executable)}（系统默认）` }
  } catch {
    return null
  }
}

/**
 * DSH 专用登录环境的持久目录。
 *
 * 用固定目录而不是每次的临时目录，登录态可以跨次复用 —— 第二次连接时
 * 大概率不用重新登录。用户可在设置页主动清除。
 * @returns {string} 目录路径。
 */
export function loginDataDir() {
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
  return path.join(home, 'deepseek-web-search', 'login-profile')
}

/**
 * 枚举本机可用的浏览器。
 *
 * 发现顺序：用户指定 → 注册表（App Paths / Uninstall，覆盖任意安装盘符）
 * → PATH 上的可执行名 → 固定安装位置兜底。同一真实路径只出现一次。
 * @param {string} [override] - 用户指定的浏览器路径（存在时排在最前）。
 * @returns {Array<{path: string, label: string}>} 浏览器列表。
 */
export function listBrowsers(override) {
  const ordered = []
  const push = (candidate) => {
    try {
      if (typeof candidate !== 'string' || !candidate) return
      const resolved = candidate.trim()
      if (!resolved || !existsSync(resolved)) return
      if (ordered.some((entry) => entry.path.toLowerCase() === resolved.toLowerCase())) return
      ordered.push({ path: resolved, label: labelFor(resolved) })
    } catch {
      // 单个候选失败不影响其余
    }
  }

  if (typeof override === 'string' && override.trim() && existsSync(override.trim())) {
    push(override.trim())
  }
  if (process.platform === 'win32') {
    for (const candidate of readBrowsersFromRegistry()) push(candidate)
    for (const name of ['chrome.exe', 'msedge.exe', 'chromium.exe', 'brave.exe', 'vivaldi.exe']) {
      push(resolveFromPath(name))
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'vivaldi']) {
      push(resolveFromPath(name))
    }
  }
  for (const candidate of process.platform === 'win32' ? WINDOWS_BROWSER_CANDIDATES : POSIX_BROWSER_CANDIDATES) {
    push(candidate)
  }
  return ordered
}

/**
 * 从 Windows 注册表读浏览器真实安装路径。
 * @returns {string[]} 去重后的路径列表。
 */
function readBrowsersFromRegistry() {
  if (process.platform !== 'win32') return []
  const found = []
  for (const key of WINDOWS_REGISTRY_KEYS) {
    try {
      // `reg query <key> /ve` 取默认值；App Paths 的默认值就是 exe 绝对路径，
      // Uninstall 键则读 DisplayIcon（形如 "C:\...\chrome.exe,0"，要剥掉图标序号）。
      const output = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const match = /REG_SZ\s+(\S[^\r\n]*)/i.exec(output)
      if (!match) continue
      let value = match[1].trim()
      if (/,/.test(value)) value = value.split(',')[0].trim()
      value = value.replace(/^"|"$/g, '')
      if (/\.exe$/i.test(value)) found.push(value)
    } catch {
      // 键不存在很正常（没装那个浏览器）
    }
  }
  return found
}

/**
 * 在 PATH 上找一个可执行名（Windows 含 PATHEXT 解析；POSIX 直接拼）。
 * @param {string} name - 可执行名，如 chrome.exe / google-chrome。
 * @returns {string|null} 绝对路径；找不到为 null。
 */
function resolveFromPath(name) {
  const directories = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  if (process.platform === 'win32') {
    const extensions = (process.env.PATHEXT ?? '.exe').split(';').filter(Boolean)
    for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = path.join(directory, name + extension)
        try {
          if (existsSync(candidate)) return candidate
        } catch {
          // 试下一个
        }
      }
    }
    return null
  }
  for (const directory of directories) {
    const candidate = path.join(directory, name)
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 试下一个
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
export function labelFor(browserPath) {
  const entry = BROWSER_LABELS.find((candidate) => candidate.match.test(browserPath))
  return entry?.label ?? path.basename(browserPath).replace(/\.(exe)$/i, '')
}


/**
 * CDP 的 WebSocket 会话。
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
 * 探测调试端口是否已被占用。
 * @param {number} port - 调试端口。
 * @param {number} [timeoutMs] - 探测超时。
 * @returns {Promise<{occupied: boolean, pid?: number}>} 占用状态（能拿到 PID 就带上）。
 */
async function probeDebugPort(port, timeoutMs = 2000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal })
    await response.text()
    // netstat 反查 PID 拿不到也不影响主流程，只是错误提示里少个编号
    let pid
    if (process.platform === 'win32') {
      try {
        const output = execFileSync('powershell', [
          '-NoProfile', '-Command',
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess`,
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
        const parsed = Number.parseInt(output.trim(), 10)
        if (Number.isInteger(parsed) && parsed > 0) pid = parsed
      } catch {
        // 拿不到 PID 不阻塞
      }
    }
    return { occupied: true, pid }
  } catch {
    return { occupied: false }
  } finally {
    clearTimeout(timer)
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
  // 默认用 DSH 专用持久目录（登录态跨次复用）；调用方传 userDataDir 才用临时的。
  const userDataDir = options.userDataDir ?? loginDataDir()
  const child = spawn(browserPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    TARGET_URL,
  ], { stdio: 'ignore', detached: false })
  // spawn 失败（路径无效/权限问题）时不能静默吞掉 —— 否则用户只能干等超时，
  // 还以为是"浏览器没启动"。进程早退同样要暴露出来，让轮询循环感知到。
  child.on('error', () => {
    child.spawnFailed = true
  })
  child.once('exit', (code) => {
    if (child.spawnFailed || typeof code === 'number') child.earlyExit = true
  })
  return { child, userDataDir }
}

/**
 * 完整登录流程：启动 → 轮询 CDP 直到拿到 token 或超时。
 *
 * 浏览器是我们用 DSH 专用登录目录拉起的实例，无论成功、超时还是取消，结束时都会关闭进程 —— 登录态保留在专用目录里，第二次连接通常无需重新登录。
 * @param {object} options - 参数。
 * @param {string} options.browserPath - 浏览器路径。
 * @param {number} [options.timeoutMs] - 等待登录的总时长（默认 5 分钟）。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<{token: string, userDataDir: string, browserPath: string}>} 结果。
 */
export async function waitForToken(options) {
  const { browserPath, timeoutMs = 5 * 60_000, signal } = options
  const port = options.port ?? DEBUG_PORT
  const onState = typeof options.onState === 'function' ? options.onState : () => {}

  // 端口预检：残留实例占着调试端口时，新实例的 --remote-debugging-port 会被
  // 静默忽略，用户看到的就是"浏览器没启动"、流程干等 20 秒才超时。所以先探测：
  // - 端口通且已能读到 token（残留实例已登录）→ 直接复用，不重复拉浏览器；
  // - 端口通但读不到 token → 立刻报错并给出 PID，而不是拉起后干等；
  // - 端口不通（正常情况）→ 继续启动。
  const portProbe = await probeDebugPort(port)
  if (portProbe.occupied) {
    onState('launching')
    try {
      const existing = await readTokenViaCdp(port, TARGET_URL, signal)
      if (existing) {
        onState('token-captured')
        return { token: existing, userDataDir: loginDataDir(), browserPath }
      }
    } catch {
      // 读不到就当没复用成功，走报错分支
    }
    throw new Error(
      `调试端口 ${port} 已被另一个浏览器实例占用（PID ${portProbe.pid ?? '未知'}），` +
        '新实例的调试参数会被忽略。请关闭该实例（或重启浏览器）后重试。',
    )
  }

  const { child, userDataDir } = launchBrowser({ browserPath, port })
  const started = Date.now()
  // 最近一次轮询失败的原因；连续失败时用于给出可操作的提示，而不是无限转圈。
  let lastError = null
  let consecutiveFailures = 0
  onState('launching')
  // 等调试端口起来
  await new Promise((resolve) => setTimeout(resolve, 1500))
  // 浏览器进程启动即退（路径无效、参数被拒等）时立刻报错，不进入无意义的轮询。
  if (child.earlyExit) {
    throw new Error(`浏览器进程启动后立即退出（${browserPath}）。请确认该路径是有效的 Chromium 系浏览器。`)
  }
  onState('waiting-login')
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('登录流程已取消')
      if (Date.now() - started > timeoutMs) {
        const hint = lastError ? `；最近一次错误：${lastError}` : ''
        throw new Error(`等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）${hint}`)
      }
      try {
        const token = await readTokenViaCdp(port, TARGET_URL, signal)
        consecutiveFailures = 0
        lastError = null
        if (token) {
          onState('token-captured')
          return { token, userDataDir, browserPath }
        }
        // 轮询中发现浏览器进程已退出：直接失败，别让用户对着关掉的窗口等满 5 分钟。
        if (child.earlyExit) {
          throw new Error('浏览器进程在登录流程中退出了。请重新发起登录。')
        }
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
    // 这是我们拉起的专用实例，流程结束（成功/超时/取消）都关掉浏览器进程 ——
    // 留着一个登录着的窗口没有任何用处。但持久登录目录不清：里面的登录态
    // 是"第二次连接不用重新登录"的来源；只有显式传入临时目录才清理。
    killTree(child)
    if (options.userDataDir !== undefined) {
      setTimeout(() => cleanupUserDataDir(userDataDir), 2000)
    }
  }
}

/** 结束我们拉起的浏览器进程树（Windows 上直接 kill main 进程收不掉渲染子进程）。 */
function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', detached: true }).unref()
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    // 进程可能已经退出
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
