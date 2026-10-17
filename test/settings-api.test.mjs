import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSettingsApi } from '../lib/index.js'

/** 起一个临时 HTTP 服务，把 handler 挂到 /api/deepseek-web-search 前缀下。 */
async function withServer(handler, run) {
  const server = http.createServer((req, res) => void handler(req, res).catch(() => {
    res.writeHead(500)
    res.end('{}')
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    return await run(origin)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

/** 收集请求体并回 JSON。 */
async function requestJson(origin, method, route, body) {
  const response = await fetch(`${origin}/api/deepseek-web-search${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, payload: await response.json() }
}

/** 造一个带临时凭证文件的解析器。 */
function fakeCredentials(file) {
  return {
    describe: () => ({
      userTokenEnv: 'DSH_TEST_TOKEN',
      cookieEnv: 'DSH_TEST_COOKIE',
      credentialsFile: file,
      hasLiteralToken: false,
      credentialsFilePresent: existsSync(file),
    }),
    probe: () => existsSync(file),
    resolve: async () => {
      if (!existsSync(file)) {
        const error = new Error('没有凭证')
        throw error
      }
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return { userToken: parsed.userToken, cookie: parsed.cookie, source: file }
    },
  }
}

test('API：未配置时 status 如实报告，且绝不回显 token', async () => {
  await withServer(createSettingsApi({ ctx: undefined, credentials: fakeCredentials(path.join(tmpdir(), 'nope.json')), providerId: 'deepseek-web' }), async (origin) => {
    const { status, payload } = await requestJson(origin, 'GET', '/status')
    assert.equal(status, 200)
    assert.equal(payload.providerId, 'deepseek-web')
    assert.equal(payload.local.fileExists, false)
    assert.match(payload.resolved.error, /凭证|token|ENOENT/i)
    assert.equal(JSON.stringify(payload).match(/userToken"\s*:\s*"[^"]{8,}/), null, '响应不能包含 token 值')
  })
})

test('API：POST /credential 写入私有文件，空 token 拒绝', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-dws-api-'))
  const file = path.join(directory, 'credentials.json')
  const handler = createSettingsApi({ ctx: undefined, credentials: fakeCredentials(file), credentialsFile: file, providerId: 'deepseek-web' })
  try {
    await withServer(handler, async (origin) => {
      const bad = await requestJson(origin, 'POST', '/credential', { userToken: '  ' })
      assert.equal(bad.status, 400)
      assert.equal(existsSync(file), false)

      const good = await requestJson(origin, 'POST', '/credential', { userToken: 'test-token-1234567890' })
      assert.equal(good.status, 200)
      assert.equal(good.payload.ok, true)
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      assert.equal(stored.userToken, 'test-token-1234567890')

      // status 现在应报告已配置
      const after = await requestJson(origin, 'GET', '/status')
      assert.equal(after.payload.resolved.source, file)
      assert.equal(after.payload.resolved.length, 'test-token-1234567890'.length)
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('API：未知路由 404，坏 JSON 500', async () => {
  await withServer(createSettingsApi({ ctx: undefined, credentials: fakeCredentials(path.join(tmpdir(), 'x.json')), providerId: 'p' }), async (origin) => {
    const missing = await requestJson(origin, 'GET', '/nope')
    assert.equal(missing.status, 404)
  })
})