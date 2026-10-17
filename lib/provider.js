/**
 * ctx.web 的搜索提供方：DeepSeek 网页版（chat.deepseek.com）。
 *
 * 契约（见 @deepseek-ai/dsh-web）：
 *   { id, available(): boolean, search({query, maxResults?}, signal): Promise<{sources, truncated, content?}> }
 * `maxResults` 的裁剪由 seam 负责，这里不重复实现；`content` 默认不返回——
 * 网页版会生成一整轮完整回答，把它当"答案"塞进会话既费 token 又不可信，
 * DSH 官方 provider 同样选择省略。
 *
 * @module dsh-deepseek-web-search/provider
 */

import {
  COMPLETION_PATH,
  createChatSession,
  fetchPowChallenge,
  normalizeOrigin,
  requestHeaders,
  streamCompletion,
} from './client.js'
import { assertHeaderSafe } from './credentials.js'
import { abortedError, CODE, safeMessage, SearchError } from './envelope.js'
import { powHeader, solvePowAsync } from './pow.js'
import { SearchCollector } from './sse.js'

/** 注册进 ctx.web 的稳定 id，bundle patch 里的 searchProvider 必须与它一致。 */
export const PROVIDER_ID = 'deepseek-web'

/** seam 已经定义的错误码；别的实现（例如部署自带的凭据解析器）抛出来时要原样保留。 */
const SEAM_CODES = new Set([
  'WEB_PROVIDER_CREDENTIAL_MISSING',
  'WEB_PROVIDER_UNAVAILABLE',
  'WEB_PROVIDER_AMBIGUOUS',
  'WEB_PROVIDER_CONFIGURED_MISSING',
  'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
  'WEB_ABORTED',
  'WEB_PROVIDER_ERROR',
])

/** 把任意异常收敛成 seam 认得的错误：取消归 WEB_ABORTED，其余归 WEB_PROVIDER_ERROR。 */
function toSearchError(error, signal) {
  if (error instanceof SearchError) return error
  if (signal?.aborted === true || error?.name === 'AbortError') return abortedError(error)
  // 外来的结构化错误：保留它的 code，但消息一律重新脱敏后再往外给。
  if (typeof error?.code === 'string' && SEAM_CODES.has(error.code)) {
    return new SearchError(safeMessage(error), error.code, { cause: error })
  }
  if (error?.name === 'TimeoutError') {
    return new SearchError('DeepSeek 网页搜索超时（上游未在预算内返回搜索结果）', CODE.providerError, { cause: error })
  }
  return new SearchError(`DeepSeek 网页搜索失败：${safeMessage(error)}`, CODE.providerError, { cause: error })
}

/** 请求体：字段与网页端一致，多一个少一个都可能被拒。 */
function completionPayload(options, sessionId) {
  return {
    action: null,
    chat_session_id: sessionId,
    parent_message_id: null,
    model_type: options.model,
    prompt: options.query,
    ref_file_ids: [],
    thinking_enabled: options.thinking,
    search_enabled: true,
    preempt: false,
  }
}

export class DeepSeekWebSearchProvider {
  /**
   * @param {() => object} resolveOptions - 每次搜索取一次配置快照：一次搜索只用一份配置，
   *   且改动配置/轮换凭证无需重新注册 provider（避免 seam 的选择出现闪烁）。
   */
  constructor(resolveOptions) {
    this.id = PROVIDER_ID
    this.resolveOptions = resolveOptions
  }

  /** 同步可用性：只看端点合法 + 存在凭证解析路径，值能不能用留给 search() 报错。 */
  available() {
    const options = this.resolveOptions()
    try {
      normalizeOrigin(options.origin)
    } catch {
      return false
    }
    return options.isAvailable() === true
  }

  /**
   * 跑一次搜索：凭证 -> 开会话 -> PoW -> completion -> 只收结构化 results。
   * @param {{query: string}} request - seam 的搜索请求。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<{sources: Array<object>, truncated: boolean, content?: string}>} 搜索结果。
   */
  async search(request, signal) {
    const options = this.resolveOptions()
    try {
      const query = typeof request?.query === 'string' ? request.query.trim() : ''
      if (!query) throw new SearchError('DeepSeek 网页搜索：查询为空', CODE.providerError)
      if (signal?.aborted) throw abortedError(signal.reason)

      const origin = normalizeOrigin(options.origin)
      const credentials = await options.resolveCredentials()
      assertHeaderSafe(credentials.userToken)

      const baseHeaders = requestHeaders({
        origin,
        credentials,
        clientVersion: options.clientVersion,
      })

      const sessionId = options.session.resolve(() => createChatSession({
        origin,
        headers: baseHeaders,
        signal,
        timeoutMs: options.sessionTimeoutMs,
      }))
      const chatSessionId = typeof sessionId === 'string' ? sessionId : await sessionId
      if (signal?.aborted) throw abortedError(signal.reason)

      const challenge = await fetchPowChallenge({
        origin,
        headers: baseHeaders,
        targetPath: COMPLETION_PATH,
        signal,
        timeoutMs: options.sessionTimeoutMs,
      })
      const answer = await solvePowAsync(challenge, { signal, timeoutMs: options.powTimeoutMs })
      const payload = completionPayload({ ...options, query }, chatSessionId)

      options.recordRequest?.({ endpoint: `${origin}${COMPLETION_PATH}`, modelType: options.model, body: payload })

      const headers = requestHeaders({
        origin,
        credentials,
        clientVersion: options.clientVersion,
        extra: { 'x-ds-pow-response': powHeader(challenge, answer, { targetPath: COMPLETION_PATH }) },
      })

      const collector = new SearchCollector()
      for await (const frame of streamCompletion({
        origin,
        headers,
        payload,
        signal,
        timeoutMs: options.requestTimeoutMs,
      })) {
        collector.apply(frame)
        // 结果一到就停读上游：正文那部分我们不消费，读完纯属浪费带宽与额度。
        if (options.stopAfterResults && collector.settled()) break
      }

      const sources = collector.list()
      if (sources.length === 0) {
        throw new SearchError(
          `DeepSeek 网页搜索没有返回结构化结果（search_enabled=${collector.searchEnabled ?? 'unknown'}，` +
            `conversation_mode=${collector.mode ?? 'unknown'}）。可能是上游改了协议，或该账号/该查询未触发联网搜索。`,
          CODE.providerError,
        )
      }

      const result = { sources, truncated: false }
      if (options.includeAnswer && collector.answerText.trim()) result.content = collector.answerText.trim()
      return result
    } catch (error) {
      throw toSearchError(error, signal)
    }
  }
}

/**
 * 会话缓存：默认每次搜索开新会话（隔离、不污染历史）。开启 reuseSession 时复用
 * 同一个 chat session，省掉一次上游请求。
 *
 * 注意 `web_search` 会把多个查询并发扇出，因此这里缓存的是 **进行中的 promise**
 * 而不只是结果——否则并发第一次搜索会同时开出好几个会话，恰好把复用的意义抵消掉。
 * @param {boolean} reuse - 是否复用。
 * @returns {{ resolve: (create: () => Promise<string>) => Promise<string>, reset: () => void }} 缓存。
 */
export function createSessionCache(reuse) {
  let cached
  return {
    async resolve(create) {
      if (!reuse) return create()
      if (typeof cached === 'string') return cached
      if (cached === undefined) {
        cached = create().then(
          (id) => {
            cached = id
            return id
          },
          (error) => {
            cached = undefined
            throw error
          },
        )
      }
      return cached
    },
    reset() {
      cached = undefined
    },
  }
}