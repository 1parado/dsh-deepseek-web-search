import test from 'node:test'
import assert from 'node:assert/strict'

import { CODE, readEnvelope, redact, retryAfterMs, safeMessage, SearchError, withTimeout } from '../lib/envelope.js'

const JWT_LIKE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const OPAQUE = 'rQ8vH2mKpLxN4tYbWdEfZcSaGuJiOnBqRlTmXyVzA1pCsDeFgHjKlMnOpQrStUvWxYz0123'

test('redact 抹掉 Bearer / cookie / userToken 标签后的值', () => {
  assert.equal(redact(`Authorization: Bearer ${OPAQUE}`), 'Authorization: Bearer [redacted]')
  assert.equal(redact('cookie: session=abc123; other=1'), 'cookie: [redacted]')
  assert.equal(redact(`userToken: ${OPAQUE}`).includes('rQ8vH2'), false)
  assert.equal(redact(`user_token="${OPAQUE}"`).includes('rQ8vH2'), false)
})

test('redact 抹掉裸的 JWT 与不透明长串（上游回显时也兜得住）', () => {
  assert.equal(redact(`upstream echoed ${JWT_LIKE}`), 'upstream echoed [redacted]')
  assert.equal(redact(`upstream echoed ${OPAQUE}`), 'upstream echoed [redacted]')
  assert.equal(redact(`digest=${'a'.repeat(64)}`), 'digest=[redacted]')
  assert.equal(redact(`token=${OPAQUE}`), 'token=[redacted]')
})

test('redact 不破坏错误消息里的文件路径与端点', () => {
  const message = '写入 C:\\Users\\me\\.dsh\\deepseek-web-search\\credentials.json 失败，端点 https://chat.deepseek.com'
  assert.equal(redact(message), message)
})

test('safeMessage 兜底并限长', () => {
  assert.equal(safeMessage(''), 'DeepSeek request failed')
  assert.equal(safeMessage('   '), 'DeepSeek request failed')
  assert.equal(safeMessage('boom', 'fallback'), 'boom')
  assert.equal(safeMessage('ab '.repeat(300), 'fallback').length, 500)
})

test('retryAfterMs 认秒数与 HTTP 日期，并封顶 10 分钟', () => {
  assert.equal(retryAfterMs('30'), 30_000)
  assert.equal(retryAfterMs('99999'), 600_000)
  assert.equal(retryAfterMs(null), 0)
  assert.equal(retryAfterMs('不是数'), 0)
  const now = Date.parse('2026-01-01T00:00:00Z')
  assert.equal(retryAfterMs('Wed, 01 Jan 2026 00:00:20 GMT', now), 20_000)
  assert.equal(retryAfterMs('Wed, 01 Jan 2020 00:00:00 GMT', now), 0)
})

test('withTimeout 到点会 abort，也能被调用方信号提前打断', async () => {
  const timedOut = withTimeout(undefined, 10)
  assert.equal(timedOut.aborted, false)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(timedOut.aborted, true)
  assert.equal(timedOut.reason.name, 'TimeoutError')

  const controller = new AbortController()
  const merged = withTimeout(controller.signal, 60_000)
  assert.equal(merged.aborted, false)
  controller.abort(new Error('用户取消'))
  assert.equal(merged.aborted, true)
  assert.equal(merged.reason.message, '用户取消')
})

test('readEnvelope 把 401/403 映射成"登录已失效"', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(() => readEnvelope(new Response('{}', { status }), 'completion'), (error) => {
      assert.equal(error.code, CODE.providerError)
      assert.match(error.message, /登录已失效/)
      return true
    })
  }
})

test('readEnvelope 处理空体、坏 JSON、业务码与 HTTP 错误', async () => {
  await assert.rejects(() => readEnvelope(new Response('', { status: 200 }), 'chat session'), /空响应/)
  await assert.rejects(() => readEnvelope(new Response('not json', { status: 200 }), 'chat session'), /合法 JSON/)
  await assert.rejects(
    () => readEnvelope(new Response(JSON.stringify({ data: { biz_code: 42, biz_msg: '账号受限' } }), { status: 200 }), 'completion'),
    /被拒绝（42）账号受限/,
  )
  await assert.rejects(
    () => readEnvelope(new Response(JSON.stringify({ msg: 'boom' }), { status: 500, headers: { 'retry-after': '5' } }), 'completion'),
    (error) => {
      assert.match(error.message, /HTTP 500/)
      assert.equal(error.retryAfterMs, 5_000)
      assert.equal(error.status, 500)
      return true
    },
  )
})

test('readEnvelope 解出 biz_data，没有则退回 data 与整体', async () => {
  const wrapped = new Response(JSON.stringify({ data: { biz_code: 0, biz_data: { chat_session: { id: 's-1' } } } }), { status: 200 })
  assert.deepEqual(await readEnvelope(wrapped, 'chat session'), { chat_session: { id: 's-1' } })

  const plain = new Response(JSON.stringify({ data: { id: 's-2' } }), { status: 200 })
  assert.deepEqual(await readEnvelope(plain, 'chat session'), { id: 's-2' })

  const bare = new Response(JSON.stringify({ hello: 'world' }), { status: 200 })
  assert.deepEqual(await readEnvelope(bare, 'chat session'), { hello: 'world' })
})

test('SearchError 形状与 seam 的 WebError 兼容', () => {
  const cause = new Error('底层原因')
  const error = new SearchError('对外消息', CODE.aborted, { cause })
  assert.equal(error.name, 'WebError')
  assert.equal(error.code, 'WEB_ABORTED')
  assert.equal(error.cause, cause)
  assert.ok(error instanceof Error)
})