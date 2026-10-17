import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply } from '../lib/index.js'

/**
 * 装配级测试：跑真的 apply()，用假 webServer 收下 handler，再起 HTTP 服务打
 * 真实请求。这类测试专抓「handler 单测全绿、但 apply 忘了传依赖」的错 ——
 * 上一版 /check-connection 与 /test-search 在设置页必报
 * "Cannot read properties of undefined"，就是这个原因，且未被任何测试拦住。
 */
function stubContext(options = {}) {
  let handler = null
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    inject: (names, setup) => {
      // cordis 语义：依赖缺失时 fiber 保持 pending。测试里直接喂一个 stub。
      setup({ webServer: { register: (route) => { handler = route.handler } } })
    },
    web: {
      registerSearchProvider: (provider) => {
        registered.push(provider)
        return () => {}
      },
    },
  }
  return { ctx, registered, getHandler: () => handler }
}

async function withServer(handler, run) {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch(() => {
      res.writeHead(500)
      res.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    return await run(origin)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function callJson(origin, method, route, body) {
  const response = await fetch(`${origin}/api/deepseek-web-search${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, payload: await response.json() }
}

test('apply() 装配：/check-connection 不应报 undefined（回归：漏传 provider/settings）', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-apply-'))
  const file = path.join(directory, 'credentials.json')
  // 一个确定失效的假 token：连接检测应给出「认证失败」类的真实结果，
  // 而不是 "Cannot read properties of undefined"
  writeFileSync(file, JSON.stringify({ userToken: 'invalid-token-for-assembly-test-000000' }), 'utf8') // secret-scan: ignore（合成假 token）
  try {
    const { ctx, registered, getHandler } = stubContext()
    apply(ctx, { credentialsFile: file })
    assert.equal(registered.length, 1)
    const handler = getHandler()
    assert.equal(typeof handler, 'function', 'webServer 路由应被注册')

    await withServer(handler, async (origin) => {
      const { status, payload } = await callJson(origin, 'POST', '/check-connection')
      assert.equal(status, 200)
      assert.equal(payload.error?.includes('Cannot read properties of undefined'), false, '不应再出现 undefined 报错')
      // 假 token 打真实上游：预期是认证类失败，而不是组装错误
      assert.equal(payload.ok, false, '假 token 的连接检测必然失败')
      assert.equal(typeof payload.error, 'string')
      assert.notEqual(payload.error, '')
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('apply() 装配：/test-search 不应报 undefined（回归：漏传 provider）', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-apply2-'))
  const file = path.join(directory, 'credentials.json')
  writeFileSync(file, JSON.stringify({ userToken: 'invalid-token-for-assembly-test-000000' }), 'utf8') // secret-scan: ignore（合成假 token）
  try {
    const { ctx, getHandler } = stubContext()
    apply(ctx, { credentialsFile: file })
    await withServer(getHandler(), async (origin) => {
      const { status, payload } = await callJson(origin, 'POST', '/test-search')
      assert.equal(status, 200)
      assert.equal(payload.error?.includes('Cannot read properties of undefined'), false, '不应再出现 undefined 报错')
      assert.equal(payload.ok, false)
      assert.equal(typeof payload.error, 'string')
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('apply() 装配：/status 报告三层中的本地层', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-apply3-'))
  const file = path.join(directory, 'credentials.json')
  try {
    const { ctx, getHandler } = stubContext()
    apply(ctx, { credentialsFile: file })
    await withServer(getHandler(), async (origin) => {
      const { payload } = await callJson(origin, 'GET', '/status')
      assert.equal(payload.local.fileExists, false)
      assert.equal(payload.local.valid, false)
      assert.equal(typeof payload.credentialsFile, 'string')
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})