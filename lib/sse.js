/**
 * DeepSeek 网页版 completion 的 SSE 帧解析与搜索结果归集。
 *
 * 上游不是标准的事件流：正文是「补丁」对象，形如
 *   {"p":"response/fragments/-1/results","v":[...]}        绝对路径补丁
 *   {"p":"response","o":"BATCH","v":[{"p":"fragments/…"}]}  批量、子路径相对
 *   {"v":"油"}                                              仅正文增量
 * 联网搜索的结果固定落在 fragment 的 results 字段上（type 为 SEARCH），因此这里
 * 只归集两样东西：results 里的来源，以及用于判断"搜索已结束"的状态位。
 *
 * @module dsh-deepseek-web-search/sse
 */

/** 单帧字符上限：坏帧或恶意上游不能让宿主无限缓冲。 */
const MAX_FRAME_CHARACTERS = 1_048_576

/** 这些 fragment 类型是推理/检索过程，不属于答案正文。 */
const REASONING_TYPES = new Set(['THINK', 'THINKING', 'REASONING', 'SEARCH', 'TOOL_SEARCH', 'TOOL_OPEN', 'TOOL_FIND'])

/**
 * 解析一段 SSE 块为 {event, data}；没有 data 行时返回 null。
 * @param {string} block - 不含分隔符的单个事件块。
 * @returns {{event: string, data: string}|null} 解析结果。
 */
function parseFrame(block) {
  let event = 'message'
  const lines = []
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
  }
  return lines.length ? { event, data: lines.join('\n') } : null
}

/**
 * 把响应体切成 SSE 帧。LF / CRLF / CR 三种换行都认；帧超限即报错。
 * @param {ReadableStream<Uint8Array>|null} body - fetch 响应体。
 * @param {{ signal?: AbortSignal }} [options] - 取消信号。
 * @yields {{event: string, data: string}} 单个 SSE 帧。
 */
export async function* sseFrames(body, options = {}) {
  const { signal } = options
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let exhausted = false
  const abort = () => {
    try {
      Promise.resolve(reader.cancel(signal.reason)).catch(() => {})
    } catch {
      /* 取消失败不影响调用方 */
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    for (;;) {
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) {
        exhausted = true
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let separator
      while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        signal?.throwIfAborted()
        if (separator.index > MAX_FRAME_CHARACTERS) throw new Error('DeepSeek stream frame exceeds size limit')
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const frame = parseFrame(block)
        if (frame) yield frame
      }
      if (buffer.length > MAX_FRAME_CHARACTERS) throw new Error('DeepSeek stream frame exceeds size limit')
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer)
      if (frame) yield frame
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    try {
      if (!exhausted) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

/**
 * 把 published_at 归一成 `YYYY-MM-DD`；无法识别就省略（不编造时间）。
 * @param {unknown} value - unix 秒、毫秒或 ISO 字符串。
 * @returns {string|undefined} 日期串。
 */
export function toPublishedDate(value) {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value.trim())
    if (!Number.isFinite(parsed)) return undefined
    return new Date(parsed).toISOString().slice(0, 10)
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const ms = value > 1e12 ? value : value * 1000
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined
}

/**
 * 把上游的一条 web 结果归一成 ctx.web 的 source 形状。
 * @param {unknown} item - results 数组里的元素。
 * @returns {{url: string, title?: string, snippet?: string, publishedAt?: string}|null} 归一结果。
 */
function normalizeSource(item) {
  if (!item || typeof item !== 'object') return null
  const url = typeof item.url === 'string' ? item.url.trim() : ''
  if (!url) return null
  const source = { url }
  if (typeof item.title === 'string' && item.title.trim()) source.title = item.title.trim()
  if (typeof item.snippet === 'string' && item.snippet.trim()) source.snippet = item.snippet.trim()
  const publishedAt = toPublishedDate(item.published_at)
  if (publishedAt) source.publishedAt = publishedAt
  return source
}

/**
 * 增量归集一帧帧补丁，产出搜索来源与结束状态位。
 *
 * 只认结构化字段，绝不从正文里抓 URL：正文可能被改写、翻译或截断，抓出来的
 * "来源"不可信。
 */
export class SearchCollector {
  constructor() {
    /** @type {Map<string, {source: object, citeIndex: number, order: number}>} */
    this.sources = new Map()
    /** @type {Map<number, string>} */
    this.fragmentTypes = new Map()
    this.lastFragmentIndex = null
    /** 已通过列表追加的 fragment 数；APPEND 的起始下标由它决定。 */
    this.fragmentCount = 0
    this.citeOrdinal = 0
    this.queries = []
    this.mode = null
    this.searchEnabled = null
    this.searchFinished = false
    this.answerStarted = false
    this.answerText = ''
    this.status = null
  }

  /** 归一后的来源，按 cite_index 升序（缺失时按到达顺序）。 */
  list() {
    return [...this.sources.values()]
      .sort((left, right) => left.citeIndex - right.citeIndex || left.order - right.order)
      .map((entry) => ({ ...entry.source }))
  }

  /** 是否已经可以停读上游：有来源，且答案已经开始或上游已给出终态。 */
  settled() {
    return this.sources.size > 0 && (this.answerStarted || this.status !== null)
  }

  /** `-1` 表示"最后一个 fragment"，与上游约定一致。 */
  resolveIndex(raw) {
    const index = Number(raw)
    if (index === -1) return this.lastFragmentIndex ?? 0
    return index
  }

  /** 吸收 results 数组：按 URL 去重，保留首次出现的排名。 */
  absorb(results) {
    if (!Array.isArray(results)) return
    for (const item of results) {
      const source = normalizeSource(item)
      if (!source || this.sources.has(source.url)) continue
      const citeIndex = Number.isFinite(item?.cite_index) ? Number(item.cite_index) : Number.MAX_SAFE_INTEGER
      this.sources.set(source.url, { source, citeIndex, order: this.citeOrdinal++ })
    }
  }

  /** 读一个完整 fragment 对象。 */
  readFragment(fragment, index) {
    if (!fragment || typeof fragment !== 'object') return
    const type = String(fragment.type ?? 'RESPONSE').toUpperCase()
    if (Number.isSafeInteger(index)) {
      this.fragmentTypes.set(index, type)
      this.lastFragmentIndex = index
    }
    if (type === 'SEARCH') {
      if (Array.isArray(fragment.queries)) {
        for (const entry of fragment.queries) {
          if (entry && typeof entry.query === 'string' && entry.query) this.queries.push(entry.query)
        }
      }
      if (fragment.status === 'FINISHED') this.searchFinished = true
    } else if (type === 'RESPONSE') {
      this.answerStarted = true
      // 快照里的正文是后续增量补丁的基线，先垫进去，避免 includeAnswer 时漏掉开头。
      if (typeof fragment.content === 'string' && fragment.content && !this.answerText) {
        this.answerText = fragment.content
      }
    }
    this.absorb(fragment.results)
  }

  /**
   * 应用一帧已解析的补丁。
   * @param {unknown} frame - JSON.parse 后的 data。
   */
  apply(frame) {
    if (!frame || typeof frame !== 'object') return

    if (typeof frame.p === 'string') {
      const path = frame.p
      if (frame.o === 'BATCH' && Array.isArray(frame.v)) {
        for (const item of frame.v) {
          if (!item || typeof item !== 'object') continue
          const child = typeof item.p === 'string' && item.p.startsWith('response')
            ? item.p
            : [path, item.p].filter(Boolean).join('/')
          this.apply({ ...item, p: child })
        }
        return
      }

      if (path === 'response' && frame.v && typeof frame.v === 'object') {
        this.applyResponse(frame.v)
        return
      }

      const fragment = /^response\/fragments\/(-?\d+)$/.exec(path)
      if (fragment && frame.v && typeof frame.v === 'object') {
        this.readFragment(frame.v, this.resolveIndex(fragment[1]))
        return
      }

      const results = /^response\/fragments\/(-?\d+)\/results$/.exec(path)
      if (results) {
        this.lastFragmentIndex = this.resolveIndex(results[1])
        this.absorb(frame.v)
        return
      }

      const type = /^response\/fragments\/(-?\d+)\/type$/.exec(path)
      if (type && typeof frame.v === 'string') {
        const index = this.resolveIndex(type[1])
        this.lastFragmentIndex = index
        this.fragmentTypes.set(index, frame.v.toUpperCase())
        if (frame.v.toUpperCase() === 'RESPONSE') this.answerStarted = true
        return
      }

      const status = /^response\/fragments\/(-?\d+)\/status$/.exec(path)
      if (status && typeof frame.v === 'string') {
        const index = this.resolveIndex(status[1])
        this.lastFragmentIndex = index
        if (this.fragmentTypes.get(index) === 'SEARCH' && frame.v === 'FINISHED') this.searchFinished = true
        return
      }

      if (path === 'response/fragments' && Array.isArray(frame.v)) {
        // APPEND 续在已知 fragment 之后；SET/首次出现则从 0 开始。
        const start = frame.o === 'APPEND' ? this.fragmentCount : 0
        frame.v.forEach((entry, offset) => this.readFragment(entry, start + offset))
        this.fragmentCount = Math.max(this.fragmentCount, start + frame.v.length)
        return
      }

      const content = /^response\/fragments\/(-?\d+)\/content$/.exec(path)
      if (content && typeof frame.v === 'string') {
        const index = this.resolveIndex(content[1])
        this.lastFragmentIndex = index
        this.writeAnswer(index, frame.v, frame.o === 'SET')
        return
      }

      if (path === 'response/conversation_mode' && typeof frame.v === 'string') {
        this.mode = frame.v
        return
      }
      if (path === 'response/status' && typeof frame.v === 'string') {
        this.status = frame.v
        return
      }
      return
    }

    const response = frame.v?.response ?? frame.response
    if (response && typeof response === 'object') {
      this.applyResponse(response)
      return
    }

    // 只有 v 的裸字符串帧 = 当前 fragment 的正文增量。
    if (typeof frame.v === 'string') {
      this.writeAnswer(this.lastFragmentIndex ?? 0, frame.v, false)
    }
  }

  /** 应用一个完整的 response 对象。 */
  applyResponse(response) {
    if (!response || typeof response !== 'object') return
    if (Array.isArray(response.fragments)) {
      response.fragments.forEach((entry, offset) => this.readFragment(entry, offset))
      this.fragmentCount = Math.max(this.fragmentCount, response.fragments.length)
    }
    if (typeof response.search_enabled === 'boolean') this.searchEnabled = response.search_enabled
    if (typeof response.conversation_mode === 'string') this.mode = response.conversation_mode
    if (typeof response.status === 'string') this.status = response.status
  }

  /** 把正文写进答案缓冲；推理与检索类 fragment 不计入。 */
  writeAnswer(index, value, snapshot) {
    const type = this.fragmentTypes.get(index) ?? 'RESPONSE'
    if (REASONING_TYPES.has(type)) return
    this.fragmentTypes.set(index, type)
    this.answerStarted = true
    if (snapshot) {
      this.answerText = value
      return
    }
    if (this.answerText.length + value.length > this.constructor.MAX_ANSWER_CHARACTERS) {
      throw new Error('DeepSeek answer exceeds size limit')
    }
    this.answerText += value
  }
}

/** 答案缓冲上限：搜索只借它做可选的 content，不需要无限增长。 */
SearchCollector.MAX_ANSWER_CHARACTERS = 200_000