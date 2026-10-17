/**
 * chat.deepseek.com 网页内部协议的最小客户端。
 *
 * 只做四件事：拼请求头、开会话、取 PoW challenge、发 completion 并把 SSE 帧
 * 交给上层。不做重试与会话复用策略——那些属于 provider。
 *
 * 传输层约束：
 * - `redirect: 'error'`：绝不带着 userToken 跟随 302 去别的域。
 * - 端点必须是 https，除非指向本机（自建兼容网关做协议测试时用 http）。
 *
 * @module dsh-deepseek-web-search/client
 */

import { readEnvelope, retryAfterMs, SearchError, CODE, safeMessage, withTimeout } from './envelope.js'
import { sseFrames } from './sse.js'

/** 默认网页端版本号；上游改版后可能需要调整。 */
export const DEFAULT_CLIENT_VERSION = '2.4.0'
/** 默认 origin。 */
export const DEFAULT_ORIGIN = 'https://chat.deepseek.com'
/** completion 目标路径，同时是 PoW 的 target_path。 */
export const COMPLETION_PATH = '/api/v0/chat/completion'

/**
 * 校验端点：必须是 http(s)，且非 https 时只允许本机。
 * @param {string} origin - 配置里的端点。
 * @returns {string} 去掉尾斜杠的端点。
 */
export function normalizeOrigin(origin) {
  const raw = typeof origin === 'string' && origin.trim() ? origin.trim() : DEFAULT_ORIGIN
  let url
  try {
    url = new URL(raw)
  } catch (cause) {
    throw new SearchError(`DeepSeek 网页端点不是合法 URL：${safeMessage(raw)}`, CODE.providerError, { cause })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SearchError(`DeepSeek 网页端点必须是 http(s)：${raw}`, CODE.providerError)
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol === 'http:' && !local) {
    throw new SearchError(
      `拒绝用明文 http 发送网页凭证：${raw}。只允许 https，或指向本机的 http 端点。`,
      CODE.providerError,
    )
  }
  return url.origin
}

/**
 * 组装请求头。
 * @param {object} options - 参数。
 * @param {string} options.origin - 已归一化的端点。
 * @param {{userToken: string, cookie?: string}} options.credentials - 本次操作的凭证。
 * @param {string} [options.clientVersion] - x-client-version。
 * @param {Record<string,string>} [options.extra] - 追加头（如 PoW）。
 * @returns {Record<string,string>} 请求头。
 */
export function requestHeaders(options) {
  const { origin, credentials, clientVersion, extra } = options
  const headers = {
    accept: '*/*',
    'content-type': 'application/json',
    authorization: `Bearer ${credentials.userToken}`,
    origin,
    referer: `${origin}/a/chat/`,
    'x-client-platform': 'web',
    'x-client-version': clientVersion || DEFAULT_CLIENT_VERSION,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'zh_CN',
    ...extra,
  }
  if (credentials.cookie) headers.cookie = credentials.cookie
  return headers
}

/**
 * 开一个上游 chat session。
 * @param {object} options - 参数。
 * @param {string} options.origin - 端点。
 * @param {Record<string,string>} options.headers - 请求头。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @param {number} [options.timeoutMs] - 超时。
 * @returns {Promise<string>} chat session id。
 */
export async function createChatSession(options) {
  const response = await fetch(`${options.origin}/api/v0/chat_session/create`, {
    method: 'POST',
    redirect: 'error',
    headers: options.headers,
    body: '{}',
    signal: withTimeout(options.signal, options.timeoutMs ?? 20_000),
  })
  const data = await readEnvelope(response, 'chat session')
  const id = data?.chat_session?.id ?? data?.id
  if (!id) throw new SearchError('DeepSeek chat session 响应里没有 id', CODE.providerError)
  return id
}

/**
 * 取 PoW challenge。
 * @param {object} options - 参数。
 * @param {string} options.origin - 端点。
 * @param {Record<string,string>} options.headers - 请求头。
 * @param {string} options.targetPath - 目标路径。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @param {number} [options.timeoutMs] - 超时。
 * @returns {Promise<object>} challenge（已把 expire_at / target_path 归一成驼峰别名）。
 */
export async function fetchPowChallenge(options) {
  const response = await fetch(`${options.origin}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    redirect: 'error',
    headers: options.headers,
    body: JSON.stringify({ target_path: options.targetPath }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 20_000),
  })
  const data = await readEnvelope(response, 'proof-of-work challenge')
  const challenge = data?.challenge
  if (!challenge) throw new SearchError('DeepSeek PoW challenge 缺失', CODE.providerError)
  return { ...challenge, expireAt: challenge.expire_at, targetPath: challenge.target_path ?? options.targetPath }
}

/**
 * 发 completion 并逐帧产出已解析的补丁。
 *
 * SSE 是唯一真正支持联网搜索的形态；万一上游退化成一次性 JSON，就把 response
 * 对象包成一帧交出去，让归集器走同一条解析路径，而不是另写一套。
 *
 * @param {object} options - 参数。
 * @param {string} options.origin - 端点。
 * @param {Record<string,string>} options.headers - 请求头（含 PoW）。
 * @param {object} options.payload - 请求体。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @param {number} [options.timeoutMs] - 超时。
 * @yields {object} 已解析的补丁帧。
 */
export async function* streamCompletion(options) {
  const signal = withTimeout(options.signal, options.timeoutMs ?? 90_000)
  const response = await fetch(`${options.origin}${COMPLETION_PATH}`, {
    method: 'POST',
    redirect: 'error',
    headers: options.headers,
    body: JSON.stringify(options.payload),
    signal,
  })
  if (response.status === 401 || response.status === 403) {
    throw new SearchError(
      `DeepSeek 网页搜索：账号登录已失效（HTTP ${response.status}）。请重新登录 chat.deepseek.com 并更新 userToken。`,
      CODE.providerError,
    )
  }
  if (!response.ok) {
    const error = new SearchError(`DeepSeek 网页搜索：completion HTTP ${response.status}`, CODE.providerError)
    error.status = response.status
    error.retryAfterMs = retryAfterMs(response.headers.get('retry-after'))
    throw error
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const body = await readEnvelope(response, 'completion')
    const responseObject = body?.response ?? body
    if (responseObject && typeof responseObject === 'object') yield { v: { response: responseObject } }
    return
  }
  for await (const frame of sseFrames(response.body, { signal })) {
    if (frame.event === 'close' || frame.data === '[DONE]') return
    let parsed
    try {
      parsed = JSON.parse(frame.data)
    } catch (cause) {
      throw new SearchError('DeepSeek 网页搜索：SSE 帧不是合法 JSON（上游可能已改版）', CODE.providerError, { cause })
    }
    yield parsed
  }
}