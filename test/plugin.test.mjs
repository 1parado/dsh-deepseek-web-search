import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { apply, inject, name as pluginName } from '../lib/index.js'
import { PROVIDER_ID } from '../lib/provider.js'

/** 造一个够用的 cordis ctx：只提供 provider 注册与日志。 */
function stubContext() {
  const registered = []
  const warnings = []
  return {
    registered,
    warnings,
    ctx: {
      logger: {
        info: () => {},
        warn: (message) => warnings.push(String(message)),
      },
      get: () => undefined,
      web: {
        registerSearchProvider: (provider) => {
          registered.push(provider)
          return () => {}
        },
      },
    },
  }
}

test('插件入口形状符合 cordis 约定', () => {
  assert.equal(typeof pluginName, 'string')
  assert.equal(pluginName, 'web-search-deepseek-web')
  assert.deepEqual(inject, ['web'])
  assert.equal(typeof apply, 'function')
})

test('apply() 注册恰好一个 provider，id 与常量一致', () => {
  const { ctx, registered } = stubContext()
  apply(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, PROVIDER_ID)
  assert.equal(typeof registered[0].available, 'function')
  assert.equal(typeof registered[0].search, 'function')
})

test('cordis.patch.yml 里钉的 searchProvider 与 provider.id 一致（否则永远选不中）', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const configured = /searchProvider:\s*(\S+)/u.exec(patch)?.[1]
  assert.equal(configured, PROVIDER_ID, 'bundle patch 的 searchProvider 必须等于注册的 provider id')

  const inserted = /id:\s*deepseek-web-search\s*\n\s*name:\s*'([^']+)'/u.exec(patch)?.[1]
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(inserted, manifest.name, 'insert 的 name 必须等于包名')
})

test('未知配置字段只告警，不阻断加载', () => {
  const { ctx, registered, warnings } = stubContext()
  apply(ctx, { 未来字段: 1 })
  assert.equal(registered.length, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /未知配置字段/)
})

test('配置非法时在加载阶段就报错，而不是等到搜索才炸', () => {
  const { ctx } = stubContext()
  assert.throws(() => apply(ctx, { model: '不支持' }), /model 只能是/)
  assert.throws(() => apply(ctx, { requestTimeoutMs: 1 }), /requestTimeoutMs/)
})

test('没有凭证时 provider 仍然注册（工具保持可见，失败带指引）', () => {
  const { ctx, registered } = stubContext()
  const saved = process.env.DEEPSEEK_WEB_USER_TOKEN
  delete process.env.DEEPSEEK_WEB_USER_TOKEN
  try {
    apply(ctx, { credentialsFile: '/definitely/not/here/credentials.json' })
    assert.equal(registered[0].available(), false)
    assert.equal(registered.length, 1, '工具注册跟随产品启用状态，而非后端可用性')
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_WEB_USER_TOKEN = saved
  }
})