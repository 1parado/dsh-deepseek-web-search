/**
 * 错误、脱敏与响应包络。
 *
 * 两个约束决定了这个文件的存在：
 * 1. **凭证绝不外泄。** userToken 等同于账号完整访问权，任何错误消息、日志、
 *    会话事件里都不能出现它，也不能出现 Cookie。所有对外文本都先过 redact()。
 * 2. **不 import @deepseek-ai/*。** DSH 的 profile 下 node_modules/@deepseek-ai
 *    可能是 npx 缓存留下的旧版本 junction（实测 dsh-web 是 0.1.5-rc.2，而运行时
 *    是 0.2.0-rc.2）。从插件目录 import 会解析到错版本，instanceof 直接失效。
 *    所以这里自带一个与 seam 错误形状兼容的类：只要有 `code` 字段，工具侧就能
 *    把失败当作结构化错误呈现。
 *
 * @module dsh-deepseek-web-search/envelope
 */

/** 与 ctx.web 的 WebError 形状兼容：name、code、cause 都在。 */
export class SearchError extends Error {
  /**
   * @param {string} message - 已脱敏的、可直接给模型看的信息。
   * @param {string} code - 机器可路由的错误码（DSH seam 的共享码）。
   * @param {{ cause?: unknown }} [options] - 原始错误。
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WebError'
    this.code = code
  }
}

/** seam 的共享错误码，本插件只用到这三个。 */
export const CODE = {
  credentialMissing: 'WEB_PROVIDER_CREDENTIAL_MISSING',
  aborted: 'WEB_ABORTED',
  providerError: 'WEB_PROVIDER_ERROR',
}

/**
 * 抹掉文本里可能出现的凭证。宁可过度抹除，也不能漏一个 userToken。
 * @param {unknown} value - 原始文本。
 * @returns {string} 脱敏后的文本。
 */
export function redact(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._+/=-]+/gi, 'Bearer [redacted]')
    // Cookie 头可能有多个 name=value，整行抹掉，不留下后半段。
    .replace(/(cookie\s*[:=]\s*)([^\r\n]+)/gi, '$1[redacted]')
    .replace(/(user_?token["'\s:=]+)([A-Za-z0-9._-]{8,})/gi, '$1[redacted]')
    // JWT 形状：两段以上长 base64url，用点分隔。
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{8,})?/g, '[redacted]')
    // 不透明长串：字符类刻意不含 `=`，这样 `digest=aaa…` / `token=AbC…` 的键名能留下，
    // 只抹掉值；也不含 `/` 之外的分隔符，路径里的单个目录名一般远不到 48 字符。
    .replace(/[A-Za-z0-9+/]{48,}={0,2}/g, '[redacted]')
}

/**
 * 把任意错误值收敛成一条脱敏、限长的消息。
 * @param {unknown} value - 原始错误或文本。
 * @param {string} [fallback] - 空值时的兜底文案。
 * @returns {string} 可展示消息。
 */
export function safeMessage(value, fallback = 'DeepSeek request failed') {
  const text = redact(value).trim()
  return text ? text.slice(0, 500) : fallback
}

/**
 * 解析 Retry-After，上限 10 分钟；识别不了返回 0。
 * @param {string|null} value - 响应头的原始值。
 * @param {number} [nowMs] - 当前时间，便于测试。
 * @returns {number} 冷却毫秒数。
 */
export function retryAfterMs(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10 * 60_000, seconds * 1000)
  const at = Date.parse(String(value))
  return Number.isFinite(at) ? Math.max(0, Math.min(10 * 60_000, at - nowMs)) : 0
}

/**
 * 给请求挂上一个协作式超时。
 * @param {AbortSignal|undefined} signal - 调用方取消信号。
 * @param {number} ms - 超时毫秒数。
 * @returns {AbortSignal} 合并后的信号。
 */
export function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** 调用方是否已取消。 */
export function abortedError(cause) {
  return new SearchError('DeepSeek web search aborted', CODE.aborted, { cause })
}

/**
 * 读一个 DeepSeek 响应包络：`{data:{biz_code,biz_data,biz_msg}}` 或裸对象。
 * 业务码非 0、HTTP 非 2xx、空体、非 JSON 都抛结构化错误。
 * @param {Response} response - fetch 响应。
 * @param {string} what - 用于拼错误信息的中文动作名。
 * @returns {Promise<any>} biz_data（缺省时退回 data / 整体）。
 */
export async function readEnvelope(response, what) {
  if (response.status === 401 || response.status === 403) {
    throw new SearchError(
      `DeepSeek ${what}：网页账号登录已失效（HTTP ${response.status}）。请重新从浏览器 localStorage 取 userToken 并更新凭证。`,
      CODE.providerError,
    )
  }
  const text = await response.text()
  if (!text.trim()) {
    throw new SearchError(`DeepSeek ${what}：空响应（HTTP ${response.status}）`, CODE.providerError)
  }
  let body
  try {
    body = JSON.parse(text)
  } catch (cause) {
    throw new SearchError(`DeepSeek ${what}：响应不是合法 JSON（HTTP ${response.status}）`, CODE.providerError, { cause })
  }
  if (!response.ok) {
    const error = new SearchError(`DeepSeek ${what}：HTTP ${response.status} ${safeMessage(body?.msg ?? '', '')}`.trim(), CODE.providerError)
    error.status = response.status
    error.retryAfterMs = retryAfterMs(response.headers.get('retry-after'))
    throw error
  }
  const data = body?.data
  const code = data?.biz_code ?? body?.code
  if (code !== undefined && code !== null && code !== 0 && code !== '0') {
    const detail = safeMessage(data?.biz_msg ?? body?.msg ?? '', '')
    // 实测：token 无效时上游返回 HTTP 200 + biz_code 40003（"Authorization Failed
    // (invalid token)"），不是 401/403。把它单独认出来，否则用户只会看到一句
    // 「被拒绝（40003）」，不知道该去重新取 token。
    if (String(code) === '40003' || /authorization failed|invalid token|unauthorized/i.test(detail)) {
      throw new SearchError(
        `DeepSeek 网页账号登录已失效（${code}${detail ? ` ${detail}` : ''}）。` +
          `userToken 无效或已过期：请重新登录 chat.deepseek.com，从 localStorage 取新的 userToken 并更新凭证。`,
        CODE.providerError,
      )
    }
    throw new SearchError(`DeepSeek ${what}：被拒绝（${code}）${detail}`.trim(), CODE.providerError)
  }
  return data?.biz_data ?? data ?? body
}