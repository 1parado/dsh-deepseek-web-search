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
}