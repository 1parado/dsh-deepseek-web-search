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
import { cleanupUserDataDir, findBrowser, waitForToken } from './browser-login.js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
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
    })
    server.register({ kind: 'prefix', path: '/api/deepseek-web-search', handler: api })
    ctx.logger?.info?.('dsh-deepseek-web-search：设置页 API 已挂载到 /api/deepseek-web-search')
  })
}

/**
 * 设置页的同源 API：状态、浏览器一键登录、手动写入。
 *
 * 安全边界：任何响应都不包含 token 本身，只有来源/长度/指纹；
 * 写入走 POST，落到插件私有凭证文件（0600）。
 * @param {object} deps - 依赖。
 * @param {object} deps.credentials - 凭证解析器（describe/resolve）。
 * @param {string} deps.credentialsFile - 写入目标（与解析器同一个文件）。
 * @param {string} deps.providerId - 注册的 provider id。
 * @returns {(req: object, res: object) => Promise<void>} Node http 处理器。
 */
export function createSettingsApi(deps) {
  /** 正在进行的浏览器登录：同一时刻只允许一个，重复请求返回 409。 */
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
      if (method === 'GET' && routePath === '/status') {
        const described = deps.credentials.describe()
        // available() 只看"有没有解析路径"，真实状态以一次解析为准。
        let resolved = null
        try {
          const result = await deps.credentials.resolve()
          resolved = { source: result.source, length: result.userToken.length, hasCookie: Boolean(result.cookie) }
        } catch (error) {
          resolved = { error: String(error?.message ?? error).slice(0, 200) }
        }
        return send(200, {
          providerId: deps.providerId,
          hasCredentialsFile: described.credentialsFilePresent,
          credentialsFile: described.credentialsFile,
          userTokenEnv: described.userTokenEnv,
          resolved,
        })
      }

      if (method === 'POST' && routePath === '/credential') {
        const body = await readBody()
        const userToken = typeof body.userToken === 'string' ? body.userToken.trim() : ''
        const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : ''
        if (!userToken || /\s/.test(userToken)) {
          return send(400, { error: 'userToken 为空或含空白/换行' })
        }
        const file = deps.credentialsFile
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, `${JSON.stringify(cookie ? { userToken, cookie } : { userToken }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        deps.ctx?.logger?.info?.(`dsh-deepseek-web-search：已通过设置页写入凭证（长度=${userToken.length}）`)
        return send(200, { ok: true, file, length: userToken.length })
      }

      if (method === 'POST' && routePath === '/browser-login/start') {
        const body = await readBody().catch(() => ({}))
        if (login && login.promise) return send(409, { error: '已有一个登录流程在进行', startedAt: login.startedAt })
        const browserPath = findBrowser(typeof body.browserPath === 'string' ? body.browserPath : undefined)
        if (!browserPath) {
          return send(400, { error: '没有找到可用的浏览器（Edge/Chrome）。可在请求体里指定 browserPath。' })
        }
        const controller = new AbortController()
        const file = deps.credentialsFile
        const promise = waitForToken({ browserPath, timeoutMs: 5 * 60_000, signal: controller.signal })
          .then(async (result) => {
            await mkdir(dirname(file), { recursive: true })
            await writeFile(file, `${JSON.stringify({ userToken: result.token }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
            deps.ctx?.logger?.info?.(`dsh-deepseek-web-search：浏览器登录成功（长度=${result.token.length}）`)
            cleanupUserDataDir(result.userDataDir)
            return { ok: true, file, length: result.token.length }
          })
          .catch((error) => {
            const message = String(error?.message ?? error)
            deps.ctx?.logger?.warn?.(`dsh-deepseek-web-search：浏览器登录失败：${message}`)
            return { ok: false, error: message.slice(0, 300) }
          })
          .finally(() => {
            login = null
          })
        login = { promise, startedAt: new Date().toISOString(), cancel: () => controller.abort() }
        return send(200, { ok: true, browserPath, message: '已拉起浏览器，请在打开的页面里登录 DeepSeek；登录成功后 token 会自动写入。' })
      }

      if (method === 'POST' && routePath === '/browser-login/poll') {
        if (!login) return send(200, { running: false })
        const outcome = await login.promise
        return send(200, { running: login !== null, outcome })
      }

      if (method === 'POST' && routePath === '/browser-login/cancel') {
        login?.cancel?.()
        return send(200, { ok: true })
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