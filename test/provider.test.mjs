import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { normalizeOrigin } from '../lib/client.js'
import { createSessionCache, DeepSeekWebSearchProvider } from '../lib/provider.js'
import { normalizeConfig } from '../lib/index.js'
import { deepSeekHashV1 } from '../lib/pow.js'

const TOKEN = 'test-user-token-value'
const SALT = 'sandbox-salt'
const EXPIRE_AT = 1_800_000_000
/** 难度刚好覆盖到 nonce 2，求解瞬间完成。 */
const NONCE = 2
const CHALLENGE = {
  algorithm: 'DeepSeekHashV1',
  challenge: deepSeekHashV1(`${SALT}_${EXPIRE_AT}_${NONCE}`),
  salt: SALT,
  expire_at: EXPIRE_AT,
  difficulty: NONCE + 1,
  signature: 'sandbox-signature',
}

const envelope = (bizData) => JSON.stringify({ data: { biz_code: 0, biz_data: bizData } })

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const RESULTS_FRAME = frame({
  v: {
    response: {
      status: 'WIP',
      search_enabled: true,
      fragments: [{ id: 2, type: 'SEARCH', status: 'WIP', queries: [{ query: 'q1' }], results: [] }],
    },
  },
})
const RESULTS = frame({
  p: 'response/fragments/-1/results',
  v: [
    { url: 'https://example.com/a', title: 'A', snippet: 'sa', cite_index: 1, published_at: 1_763_308_800 },
    { url: 'https://example.com/b', title: 'B', cite_index: 2 },
  ],
})
const SEARCH_DONE = frame({ p: 'response/fragments/-1/status', v: 'FINISHED' })
const MODE = frame({ p: 'response/conversation_mode', v: 'SEARCH' })
const ANSWER_START = frame({
  p: 'response',
  o: 'BATCH',
  v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 3, type: 'RESPONSE', content: '答' }] }],
})
const ANSWER_DELTA = frame({ v: '案' })
const CLOSE = 'event: close\ndata: {}\n\n'

/**
 * 起一个模拟上游。`mode` 决定 completion 的行为。
 * @param {'early-abort'|'full'|'no-results'|'unauthorized'} mode - 场景。
 * @returns {Promise<{origin: string, close: () => Promise<void>, state: object}>} 服务句柄。
 */
async function startUpstream(mode) {
  const state = { calls: [], powAnswer: null, earlyClose: false, completed: false }
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      state.calls.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
      if (request.url === '/api/v0/chat_session/create') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(envelope({ chat_session: { id: 'sess-1' } }))
        return
      }
      if (request.url === '/api/v0/chat/create_pow_challenge') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(envelope({ challenge: CHALLENGE }))
        return
      }
      if (request.url === '/api/v0/chat/completion') {
        const pow = request.headers['x-ds-pow-response']
        state.powAnswer = pow ? JSON.parse(Buffer.from(pow, 'base64').toString('utf8')).answer : null
        if (mode === 'unauthorized') {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end('{}')
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        if (mode === 'no-results') {
          response.write(ANSWER_START)
          response.end(CLOSE)
          return
        }
        response.write(RESULTS_FRAME + RESULTS + SEARCH_DONE + MODE + ANSWER_START)
        if (mode === 'full') {
          response.write(ANSWER_DELTA.repeat(3) + CLOSE)
          state.completed = true
          response.end()
          return
        }
        // early-abort：客户端应当拿到结果后就断开，而不是等我们慢慢吐正文。
        const timer = setInterval(() => response.write(ANSWER_DELTA), 20)
        response.on('close', () => {
          clearInterval(timer)
          if (!state.completed) state.earlyClose = true
        })
        return
      }
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    state,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

/** 造一个 provider：配置快照直接注入，绕开 cordis。 */
function makeProvider(origin, overrides = {}) {
  const session = createSessionCache(overrides.reuseSession ?? false)
  return new DeepSeekWebSearchProvider(() => ({
    origin,
    clientVersion: '2.4.0',
    model: 'default',
    thinking: false,
    includeAnswer: overrides.includeAnswer ?? false,
    stopAfterResults: overrides.stopAfterResults ?? true,
    sessionTimeoutMs: 5_000,
    requestTimeoutMs: 8_000,
    powTimeoutMs: 8_000,
    session,
    isAvailable: overrides.isAvailable ?? (() => true),
    resolveCredentials: overrides.resolveCredentials ?? (async () => ({ userToken: TOKEN, source: 'test' })),
    recordRequest: overrides.recordRequest,
  }))
}

test('全链路：开会话 -> PoW -> completion -> 结构化来源', async () => {
  const upstream = await startUpstream('early-abort')
  try {
    const seen = []
    const provider = makeProvider(upstream.origin, { recordRequest: (request) => seen.push(request) })
    const result = await provider.search({ query: '示例查询' }, new AbortController().signal)

    assert.deepEqual(result.sources.map((source) => source.url), ['https://example.com/a', 'https://example.com/b'])
    assert.equal(result.sources[0].publishedAt, '2025-11-16')
    assert.equal(result.truncated, false)
    assert.equal(result.content, undefined, '默认不把上游生成的整轮回答当答案')

    assert.equal(upstream.state.powAnswer, NONCE, 'PoW 答案必须随 x-ds-pow-response 发出去')
    const completion = upstream.state.calls.find((call) => call.url === '/api/v0/chat/completion')
    const payload = JSON.parse(completion.body)
    assert.equal(payload.search_enabled, true)
    assert.equal(payload.thinking_enabled, false)
    assert.equal(payload.model_type, 'default')
    assert.equal(payload.chat_session_id, 'sess-1')
    assert.equal(payload.prompt, '示例查询')
    assert.equal(payload.parent_message_id, null)
    assert.equal(completion.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(completion.headers['x-client-platform'], 'web')

    assert.equal(seen.length, 1)
    assert.equal(seen[0].body.search_enabled, true)
    assert.equal(seen[0].endpoint, `${upstream.origin}/api/v0/chat/completion`)
  } finally {
    await upstream.close()
  }
})

test('拿到结果就断开上游，不等它把正文吐完', async () => {
  const upstream = await startUpstream('early-abort')
  try {
    const provider = makeProvider(upstream.origin)
    const started = Date.now()
    await provider.search({ query: 'q' }, new AbortController().signal)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 800, `不该等正文：耗时 ${elapsed}ms`)
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(upstream.state.earlyClose, true, '上游连接应被提前关闭')
  } finally {
    await upstream.close()
  }
})

test('stopAfterResults=false 且 includeAnswer=true 时读完整轮回答并作为 content 返回', async () => {
  const upstream = await startUpstream('full')
  try {
    const provider = makeProvider(upstream.origin, { stopAfterResults: false, includeAnswer: true })
    const result = await provider.search({ query: 'q' }, new AbortController().signal)
    assert.equal(result.content, '答案案案')
    assert.equal(result.sources.length, 2)
  } finally {
    await upstream.close()
  }
})

test('没有结构化结果时明确报 WEB_PROVIDER_ERROR，不降级成"没有结果"', async () => {
  const upstream = await startUpstream('no-results')
  try {
    const provider = makeProvider(upstream.origin)
    await assert.rejects(() => provider.search({ query: 'q' }, new AbortController().signal), (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      assert.match(error.message, /没有返回结构化结果/)
      return true
    })
  } finally {
    await upstream.close()
  }
})

test('上游 401 映射成"登录已失效"，并提示更新 userToken', async () => {
  const upstream = await startUpstream('unauthorized')
  try {
    const provider = makeProvider(upstream.origin)
    await assert.rejects(() => provider.search({ query: 'q' }, new AbortController().signal), /登录已失效/)
  } finally {
    await upstream.close()
  }
})

test('缺凭证时抛 WEB_PROVIDER_CREDENTIAL_MISSING，且根本不碰上游', async () => {
  const upstream = await startUpstream('full')
  try {
    const provider = makeProvider(upstream.origin, {
      resolveCredentials: async () => {
        const error = new Error('没有凭证')
        error.name = 'WebError'
        error.code = 'WEB_PROVIDER_CREDENTIAL_MISSING'
        throw error
      },
    })
    await assert.rejects(() => provider.search({ query: 'q' }, new AbortController().signal), (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
      return true
    })
    assert.equal(upstream.state.calls.length, 0)
  } finally {
    await upstream.close()
  }
})

test('空白 token 与空查询在发请求前就被拒绝', async () => {
  const upstream = await startUpstream('full')
  try {
    const badToken = makeProvider(upstream.origin, { resolveCredentials: async () => ({ userToken: 'has space' }) })
    await assert.rejects(() => badToken.search({ query: 'q' }, new AbortController().signal), /形状不合法/)
    const provider = makeProvider(upstream.origin)
    await assert.rejects(() => provider.search({ query: '   ' }, new AbortController().signal), /查询为空/)
    assert.equal(upstream.state.calls.length, 0)
  } finally {
    await upstream.close()
  }
})

test('已取消的搜索直接以 WEB_ABORTED 失败', async () => {
  const upstream = await startUpstream('full')
  try {
    const controller = new AbortController()
    controller.abort()
    const provider = makeProvider(upstream.origin)
    await assert.rejects(() => provider.search({ query: 'q' }, controller.signal), (error) => {
      assert.equal(error.code, 'WEB_ABORTED')
      return true
    })
  } finally {
    await upstream.close()
  }
})

test('reuseSession 下并发搜索只开一个上游会话', async () => {
  const upstream = await startUpstream('full')
  try {
    const provider = makeProvider(upstream.origin, { reuseSession: true, stopAfterResults: false })
    const results = await Promise.all([
      provider.search({ query: 'q1' }, new AbortController().signal),
      provider.search({ query: 'q2' }, new AbortController().signal),
      provider.search({ query: 'q3' }, new AbortController().signal),
    ])
    assert.equal(results.length, 3)
    const sessionCalls = upstream.state.calls.filter((call) => call.url === '/api/v0/chat_session/create')
    assert.equal(sessionCalls.length, 1, '并发扇出时不该重复开会话')
  } finally {
    await upstream.close()
  }
})

test('reuseSession 关闭时每次搜索各开一个会话（隔离）', async () => {
  const upstream = await startUpstream('full')
  try {
    const provider = makeProvider(upstream.origin, { stopAfterResults: false })
    await provider.search({ query: 'q1' }, new AbortController().signal)
    await provider.search({ query: 'q2' }, new AbortController().signal)
    const sessionCalls = upstream.state.calls.filter((call) => call.url === '/api/v0/chat_session/create')
    assert.equal(sessionCalls.length, 2)
  } finally {
    await upstream.close()
  }
})

test('会话创建失败不会被缓存住，下一次搜索会重试', async () => {
  const session = createSessionCache(true)
  let attempts = 0
  const create = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('上游抖动')
    return 'sess-retry'
  }
  await assert.rejects(() => session.resolve(create), /上游抖动/)
  assert.equal(await session.resolve(create), 'sess-retry')
  assert.equal(attempts, 2)
})

test('available() 同时看端点合法性与凭证解析路径', () => {
  assert.equal(makeProvider('https://chat.deepseek.com').available(), true)
  assert.equal(makeProvider('https://chat.deepseek.com', { isAvailable: () => false }).available(), false)
  assert.equal(makeProvider('ftp://nope').available(), false)
})

test('normalizeOrigin 只允许 https，或指向本机的 http', () => {
  assert.equal(normalizeOrigin('https://chat.deepseek.com/'), 'https://chat.deepseek.com')
  assert.equal(normalizeOrigin('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080')
  assert.throws(() => normalizeOrigin('http://evil.example.com'), /拒绝用明文 http/)
  assert.throws(() => normalizeOrigin('ftp://x'), /必须是 http\(s\)/)
  assert.throws(() => normalizeOrigin('不是 URL'), /不是合法 URL/)
  assert.equal(normalizeOrigin(''), 'https://chat.deepseek.com')
})

test('normalizeConfig 填默认值、校验枚举与数字，并让 DEEPSEEK_WEB_ORIGIN 生效', () => {
  const settings = normalizeConfig(null, {})
  assert.equal(settings.origin, 'https://chat.deepseek.com')
  assert.equal(settings.model, 'default')
  assert.equal(settings.includeAnswer, false)
  assert.equal(settings.stopAfterResults, true)
  assert.equal(settings.requestTimeoutMs, 90_000)

  assert.throws(() => normalizeConfig(null, { model: 'oops' }), /model 只能是/)
  assert.throws(() => normalizeConfig(null, { requestTimeoutMs: 10 }), /requestTimeoutMs/)

  const saved = process.env.DEEPSEEK_WEB_ORIGIN
  try {
    process.env.DEEPSEEK_WEB_ORIGIN = 'https://gateway.internal'
    assert.equal(normalizeConfig(null, {}).origin, 'https://gateway.internal')
    assert.equal(normalizeConfig(null, { origin: 'https://explicit' }).origin, 'https://explicit')
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_WEB_ORIGIN
    else process.env.DEEPSEEK_WEB_ORIGIN = saved
  }
})