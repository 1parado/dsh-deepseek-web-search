/**
 * 插件入口：把 DeepSeek 网页版搜索注册成 ctx.web 的一个搜索提供方。
 *
 * 形态是标准的 cordis 插件：导出 `name` / `inject` / `apply`。这里有意**不导出
 * Config schema**，也**不 import 任何 @deepseek-ai/* 包**：
 * - profile 下的 `node_modules/@deepseek-ai/*` 是指向 npx 缓存的 junction，
 *   实测其中 dsh-web 为 0.1.5-rc.2，而运行时是 0.2.0-rc.2。从插件目录 import
 *   会解析到错版本，跨版本 instanceof 直接失效。
 * - 不声明 schema 时 cordis 原样传 config 对象，因此配置仍然能通过
 *   `dsh.bundle.patch` 的 insert.config 传进来；字段是否被 DSH 包成「引用」
 *   （带 .get()）在 credentials.js 的 readField() 里两种都兼容。
 *
 * @module dsh-deepseek-web-search
 */

import { createSessionCache, DeepSeekWebSearchProvider } from './provider.js'
import { createCredentialResolver, readField } from './credentials.js'
import { DEFAULT_CLIENT_VERSION, DEFAULT_ORIGIN } from './client.js'
import { SearchError } from './envelope.js'
import { findBrowser, listBrowsers, resolveDefaultBrowser, loginDataDir, waitForToken } from './browser-login.js'
import { writeJsonAtomic, readCredentialFile } from './atomic-file.js'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'

/** cordis 诊断里显示的插件名。 */
export const name = 'web-search-deepseek-web'

/** 只依赖 web seam；它没挂载时本插件保持等待，而不是崩掉组合。 */
export const inject = ['web']

/** completion 使用的上游模型档位。 */
const MODELS = new Set(['default', 'expert'])

/** 认得的配置字段；其余键只告警，不阻断（避免与将来 DSH 的元字段冲突）。 */
const KNOWN_FIELDS = new Set([
  'userToken',
  'cookie',
  'userTokenEnv',
  'cookieEnv',
  'credentialsFile',
  'origin',
  'clientVersion',
  'model',
  'thinking',
  'includeAnswer',
  'stopAfterResults',
  'reuseSession',
  'sessionTimeoutMs',
  'requestTimeoutMs',
  'powTimeoutMs',
])

function pickBoolean(value, fallback) {
  const raw = readField(value, fallback)
  return typeof raw === 'boolean' ? raw : fallback
}

function pickNumber(value, fallback, minimum, field) {
  const raw = readField(value, fallback)
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < minimum) {
    throw new SearchError(`插件配置字段 ${field} 必须是 >= ${minimum} 的数字，收到：${JSON.stringify(readField(value, fallback))}`, 'WEB_PROVIDER_ERROR')
  }
  return raw
}

/**
 * 归一配置：把默认值、环境覆盖与形状校验集中在一处，apply() 里不再散落判断。
 * @param {object} ctx - cordis 上下文（用于告警）。
 * @param {object} config - cordis 传入的配置。
 * @returns {object} 归一的配置快照。
 */
export function normalizeConfig(ctx, config) {
  const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) ctx?.logger?.warn?.(`dsh-deepseek-web-search：未知配置字段 "${key}" 已忽略`)
  }
  const model = readField(raw.model, 'default')
  if (!MODELS.has(model)) {
    throw new SearchError(`插件配置字段 model 只能是 default 或 expert，收到：${JSON.stringify(model)}`, 'WEB_PROVIDER_ERROR')
  }
  const originEnv = process.env.DEEPSEEK_WEB_ORIGIN?.trim()
  const origin = readField(raw.origin, originEnv || DEFAULT_ORIGIN)
  return {
    raw,
    origin,
    clientVersion: readField(raw.clientVersion, DEFAULT_CLIENT_VERSION),
    model,
    thinking: pickBoolean(raw.thinking, false),
    includeAnswer: pickBoolean(raw.includeAnswer, false),
    stopAfterResults: pickBoolean(raw.stopAfterResults, true),
    reuseSession: pickBoolean(raw.reuseSession, false),
    sessionTimeoutMs: pickNumber(raw.sessionTimeoutMs, 20_000, 1_000, 'sessionTimeoutMs'),
    requestTimeoutMs: pickNumber(raw.requestTimeoutMs, 90_000, 1_000, 'requestTimeoutMs'),
    powTimeoutMs: pickNumber(raw.powTimeoutMs, 90_000, 1_000, 'powTimeoutMs'),
  }
}

/**
 * 把请求写进会话事件，便于在会话日志里复盘（不含任何凭证）。
 * @param {object} ctx - cordis 上下文。
 * @param {object} request - 已解析的端点、模型与请求体。
 */
function recordRequest(ctx, request) {
  try {
    ctx.get('agents')?.currentInitiator()?.session?.append('web/deepseek-web-search-request', request)
  } catch (error) {
    ctx?.logger?.warn?.(`dsh-deepseek-web-search：写入搜索请求事件失败：${String(error)}`)
  }
}

/**
 * 挂载 provider。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 插件配置。
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(ctx, config)
  const credentials = createCredentialResolver({ config: settings.raw })
  const session = createSessionCache(settings.reuseSession)

  const provider = new DeepSeekWebSearchProvider(() => ({
    origin: settings.origin,
    clientVersion: settings.clientVersion,
    model: settings.model,
    thinking: settings.thinking,
    includeAnswer: settings.includeAnswer,
    stopAfterResults: settings.stopAfterResults,
    sessionTimeoutMs: settings.sessionTimeoutMs,
    requestTimeoutMs: settings.requestTimeoutMs,
    powTimeoutMs: settings.powTimeoutMs,
    session,
    isAvailable: credentials.probe,
    resolveCredentials: credentials.resolve,
    recordRequest: (request) => recordRequest(ctx, request),
  }))

  ctx.web.registerSearchProvider(provider)
  const described = credentials.describe()
  ctx.logger?.info?.(
    `dsh-deepseek-web-search：已注册搜索提供方 "${provider.id}"（model=${settings.model}，` +
      `端点=${settings.origin}，可用性=${provider.available() ? '就绪' : '缺少凭证'}，` +
      `token 来源候选=config/${described.userTokenEnv}/${described.credentialsFile}）`,
  )

  // webServer 存在时挂设置页 API；不存在则静默降级（headless 组合没有设置页）。
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    const api = createSettingsApi({
      ctx,
      credentials,
      providerId: provider.id,
      // 凭证文件路径必须与凭证解析器用同一个：写进去的 token 要立刻能被搜索读到。
      credentialsFile: credentials.describe().credentialsFile,
      // 连接检测要 settings.origin，搜索测试要 provider.search —— 缺了会在用户
      // 点击「连接检测/搜索测试」时报 "Cannot read properties of undefined"。
      provider,
      settings,
    })
    server.register({ kind: 'prefix', path: '/api/deepseek-web-search', handler: api })
    ctx.logger?.info?.('dsh-deepseek-web-search：设置页 API 已挂载到 /api/deepseek-web-search')
  })
}

/**
 * 连接状态机（F-06）。状态只能由真实业务结果驱动，禁止模拟延迟或硬编码成功。
 * @param {object} deps - 依赖。
 * @returns {object} 状态机实例。
 */
function createLoginStateMachine() {
  return {
    /** @type {null|{state: string, startedAt: string, detail?: string}} */
    current: null,
    set(state, detail) {
      this.current = { state, startedAt: this.current?.startedAt ?? new Date().toISOString(), detail }
    },
    running() {
      return this.current !== null
    },
    reset() {
      this.current = null
    },
  }
}

/** 登录中的状态 → 设置页展示文案（F-07 主按钮文案与之一致）。 */
const LOGIN_STATE_LABELS = {
  launching: '正在启动浏览器',
  'waiting-login': '等待用户登录',
  'token-captured': '正在保存凭证',
}

/**
 * 连接检测（F-09 第 2 层）：用现有认证机制做一次真实校验。
 *
 * DeepSeek 网页协议没有独立的"验 token"端点，最接近的是
 * `chat_session/create` —— 一次无害的会话创建，凭证失效会返回
 * `biz_code 40003`。这比"文件存在 + 长度合理"诚实得多。
 * @param {object} credentials - 凭证解析器。
 * @param {object} settings - 插件配置快照。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<{ok: boolean, error?: string, code?: string}>} 检测结果。
 */
async function checkConnection(credentials, settings, signal) {
  try {
    const resolved = await credentials.resolve()
    // 复用 provider 的会话创建链路做一次真实校验（而不是另写一份协议）。
    const { createChatSession, normalizeOrigin, requestHeaders } = await import('./client.js')
    const origin = normalizeOrigin(settings.origin)
    await createChatSession({
      origin,
      headers: requestHeaders({ origin, credentials: resolved, clientVersion: settings.clientVersion }),
      signal,
      timeoutMs: 15_000,
    })
    return { ok: true }
  } catch (error) {
    const message = String(error?.message ?? error)
    const code = /40003|登录已失效/i.test(message) ? 'auth-invalid'
      : /429/.test(message) ? 'rate-limited'
      : /超时|Timeout/i.test(message) ? 'timeout'
      : 'unknown'
    return { ok: false, error: message.slice(0, 300), code }
  }
}

/**
 * 搜索测试（F-09 第 3 层）：用户主动点击时执行一次真实搜索。
 * @param {object} provider - 已注册的搜索提供方。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<{ok: boolean, sources?: number, error?: string, code?: string}>} 结果。
 */
async function runSearchTest(provider, signal) {
  try {
    const result = await provider.search({ query: 'DeepSeek 最新版本' }, signal)
    return { ok: true, sources: result.sources.length }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300), code: error?.code }
  }
}

/**
 * 设置页的同源 API。
 *
 * 安全边界：任何响应都不包含 token 本身，只有来源/长度；
 * 写入走 POST 且为原子操作；凭证失效时旧文件保留，不破坏可用状态。
 * @param {object} deps - 依赖。
 * @param {object} deps.credentials - 凭证解析器（describe/resolve）。
 * @param {string} deps.credentialsFile - 写入目标（与解析器同一个文件）。
 * @param {string} deps.providerId - 注册的 provider id。
 * @param {object} deps.provider - 搜索提供方（搜索测试用）。
 * @param {object} deps.settings - 插件配置快照。
 * @returns {(req: object, res: object) => Promise<void>} Node http 处理器。
 */
export function createSettingsApi(deps) {
  /** 同一时刻只允许一个登录任务（F-07 防重复点击）。 */
  let login = null

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/deepseek-web-search/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    const readBody = () => new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch (cause) {
          reject(new SearchError('请求体不是合法 JSON', 'WEB_PROVIDER_ERROR', { cause }))
        }
      })
      req.on('error', reject)
    })

    try {
      // ---- 状态与检测 -------------------------------------------------
      if (method === 'GET' && routePath === '/status') {
        const described = deps.credentials.describe()
        const file = await readCredentialFile(deps.credentialsFile)
        // 三层检测的当前结果（不主动发请求，只报告已知事实）
        let resolved = null
        try {
          const result = await deps.credentials.resolve()
          resolved = { source: result.source, length: result.userToken.length, hasCookie: Boolean(result.cookie) }
        } catch (error) {
          resolved = { error: String(error?.message ?? error).slice(0, 200) }
        }
        return send(200, {
          providerId: deps.providerId,
          credentialsFile: described.credentialsFile,
          userTokenEnv: described.userTokenEnv,
          // F-09 第 1 层：本地凭证检查
          local: {
            fileExists: described.credentialsFilePresent,
            valid: file !== null && file.corrupt !== true,
            corrupt: file?.corrupt === true,
          },
          resolved,
          // 登录进行中的状态（F-06）
          login: login === null ? null : {
            state: login.stateMachine.current?.state ?? null,
            label: login.stateMachine.current ? LOGIN_STATE_LABELS[login.stateMachine.current.state] ?? login.stateMachine.current.state : null,
            startedAt: login.startedAt,
            browserPath: login.browserPath,
          },
        })
      }

      // F-09 第 2 层：连接检测（真实协议校验，不发搜索）
      if (method === 'POST' && routePath === '/check-connection') {
        const result = await checkConnection(deps.credentials, deps.settings)
        return send(200, result)
      }

      // F-09 第 3 层：搜索测试（用户主动点击才执行）
      if (method === 'POST' && routePath === '/test-search') {
        const result = await runSearchTest(deps.provider)
        return send(200, result)
      }

      // ---- 凭证 -------------------------------------------------------
      if (method === 'POST' && routePath === '/credential') {
        const body = await readBody()
        const userToken = typeof body.userToken === 'string' ? body.userToken.trim() : ''
        const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : ''
        if (!userToken || /\s/.test(userToken)) {
          return send(400, { error: 'userToken 为空或含空白/换行' })
        }
        // F-05：原子写入，失败时旧文件保持原样
        await writeJsonAtomic(deps.credentialsFile, cookie ? { userToken, cookie } : { userToken })
        deps.ctx?.logger?.info?.(`dsh-deepseek-web-search：已通过设置页写入凭证（长度=${userToken.length}）`)
        return send(200, { ok: true, file: deps.credentialsFile, length: userToken.length })
      }

      // ---- 浏览器 -----------------------------------------------------
      if (method === 'GET' && routePath === '/browsers') {
        const browsers = listBrowsers()
        const defaultBrowser = resolveDefaultBrowser()
        if (defaultBrowser) browsers.unshift(defaultBrowser)
        return send(200, { browsers, defaultBrowser: defaultBrowser?.path ?? null })
      }

      if (method === 'POST' && routePath === '/browser-login/start') {
        const body = await readBody().catch(() => ({}))
        if (login) return send(409, { error: '已有一个登录流程在进行', state: login.stateMachine.current?.state })
        // 浏览器三模式：'default'（系统默认）| 具体路径 | 未指定（自动挑）
        const requested = typeof body.browserPath === 'string' && body.browserPath.trim() ? body.browserPath.trim() : undefined
        let browserPath
        try {
          if (requested === 'default') {
            const resolved = resolveDefaultBrowser()
            if (!resolved) return send(400, { error: '无法解析系统默认浏览器（HTTPS 关联缺失或非本地可执行文件）。请改用指定浏览器。' })
            browserPath = resolved.path
          } else {
            browserPath = findBrowser(requested)
          }
        } catch (error) {
          return send(400, { error: String(error?.message ?? error) })
        }
        if (!browserPath) {
          return send(400, { error: '没有找到可用的浏览器。可 GET /browsers 查看本机候选，或在请求体里指定 browserPath。' })
        }
        const controller = new AbortController()
        const stateMachine = createLoginStateMachine()
        stateMachine.set('launching')
        const file = deps.credentialsFile
        const promise = waitForToken({
          browserPath,
          timeoutMs: 5 * 60_000,
          signal: controller.signal,
          onState: (state) => stateMachine.set(state),
        })
          .then(async (result) => {
            stateMachine.set('saving')
            // F-05：原子写入；旧凭证在新写入失败时保持原样
            await writeJsonAtomic(file, { userToken: result.token })
            deps.ctx?.logger?.info?.(`dsh-deepseek-web-search：浏览器登录成功（长度=${result.token.length}）`)
            return { ok: true, file, length: result.token.length, browserPath: result.browserPath }
          })
          .catch((error) => {
            const message = String(error?.message ?? error)
            deps.ctx?.logger?.warn?.(`dsh-deepseek-web-search：浏览器登录失败：${message}`)
            return { ok: false, error: message.slice(0, 300) }
          })
          .finally(() => {
            login = null
          })
        login = { promise, startedAt: new Date().toISOString(), cancel: () => controller.abort(), stateMachine, browserPath }
        return send(200, { ok: true, browserPath, message: '已拉起浏览器，请在打开的页面里登录 DeepSeek；登录成功后 token 会自动写入。' })
      }

      if (method === 'POST' && routePath === '/browser-login/poll') {
        if (!login) return send(200, { running: false })
        // F-06：把当前状态带回给 UI；结束时带回最终结果
        const outcome = await login.promise
        return send(200, { running: login !== null, state: login?.stateMachine?.current?.state ?? null, label: login?.stateMachine?.current ? LOGIN_STATE_LABELS[login.stateMachine.current.state] : null, outcome })
      }

      if (method === 'POST' && routePath === '/browser-login/cancel') {
        login?.cancel?.()
        return send(200, { ok: true })
      }

      // F-04：清除 DSH 专用登录数据（只删专用目录，不碰用户日常浏览器数据）
      if (method === 'POST' && routePath === '/clear-login-data') {
        const directory = loginDataDir()
        await rm(directory, { recursive: true, force: true })
        deps.ctx?.logger?.info?.(`dsh-deepseek-web-search：已清除 DSH 专用登录数据（${directory}）`)
        return send(200, { ok: true, cleared: directory })
      }

      if (method === 'POST' && routePath === '/open-credentials-folder') {
        const file = deps.credentialsFile
        if (process.platform === 'win32') {
          spawn('explorer.exe', ['/select,', file], { detached: true, stdio: 'ignore' }).unref()
        }
        return send(200, { ok: true, file })
      }

      return send(404, { error: `未知路由 ${method} ${routePath}` })
    } catch (error) {
      return send(500, { error: String(error?.message ?? error).slice(0, 300) })
    }
  }
}
