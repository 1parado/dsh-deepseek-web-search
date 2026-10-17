import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  assertHeaderSafe,
  createCredentialResolver,
  defaultCredentialsFile,
  dshHome,
  readCredentialsFile,
  readField,
} from '../lib/credentials.js'

const TOKEN_ENV = 'DSH_TEST_DEEPSEEK_WEB_TOKEN'
const COOKIE_ENV = 'DSH_TEST_DEEPSEEK_WEB_COOKIE'

/** 临时目录 + 环境变量的一次性管理。 */
function withSandbox(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-dws-'))
  const file = path.join(directory, 'credentials.json')
  const saved = { token: process.env[TOKEN_ENV], cookie: process.env[COOKIE_ENV] }
  return Promise.resolve()
    .then(() => run({ directory, file }))
    .finally(() => {
      for (const [key, value] of [[TOKEN_ENV, saved.token], [COOKIE_ENV, saved.cookie]]) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(directory, { recursive: true, force: true })
    })
}

/** 造一个只认文件/环境/字面值的解析器。 */
function resolverFor(file, overrides = {}) {
  return createCredentialResolver({
    config: { userTokenEnv: TOKEN_ENV, cookieEnv: COOKIE_ENV, credentialsFile: file, ...overrides },
  })
}

test('优先级：插件配置字面值 > 环境变量 > 凭证文件', async () => {
  await withSandbox(async ({ file }) => {
    writeFileSync(file, JSON.stringify({ userToken: 'FROM-FILE', cookie: 'FILE-COOKIE' }))
    process.env[TOKEN_ENV] = 'FROM-ENV'
    process.env[COOKIE_ENV] = 'ENV-COOKIE'

    const fromLiteral = await resolverFor(file, { userToken: 'FROM-CONFIG', cookie: 'CONFIG-COOKIE' }).resolve()
    assert.deepEqual(fromLiteral, { userToken: 'FROM-CONFIG', cookie: 'CONFIG-COOKIE', source: 'plugin-config' })

    const fromEnv = await resolverFor(file).resolve()
    assert.deepEqual(fromEnv, { userToken: 'FROM-ENV', cookie: 'ENV-COOKIE', source: TOKEN_ENV })

    delete process.env[TOKEN_ENV]
    delete process.env[COOKIE_ENV]
    const stored = await resolverFor(file).resolve()
    assert.deepEqual(stored, { userToken: 'FROM-FILE', cookie: 'FILE-COOKIE', source: file })
  })
})

test('三个来源都没有时抛出可执行的 WEB_PROVIDER_CREDENTIAL_MISSING', async () => {
  await withSandbox(async ({ file }) => {
    delete process.env[TOKEN_ENV]
    await assert.rejects(() => resolverFor(file).resolve(), (error) => {
      assert.equal(error.name, 'WebError')
      assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
      assert.match(error.message, new RegExp(TOKEN_ENV))
      assert.match(error.message, /credentials\.json/)
      assert.equal(error.message.includes('userToken'), true)
      return true
    })
  })
})

test('凭证文件坏掉时明确报错，而不是静默当作没有凭证', async () => {
  await withSandbox(async ({ file }) => {
    delete process.env[TOKEN_ENV]
    writeFileSync(file, '{ 这不是 JSON')
    await assert.rejects(() => readCredentialsFile(file), /不是合法 JSON/)
    writeFileSync(file, '["数组不是对象"]')
    await assert.rejects(() => readCredentialsFile(file), /JSON 对象/)
  })
})

test('probe() 只看"有没有解析路径"，不看值能不能用', async () => {
  await withSandbox(async ({ file }) => {
    delete process.env[TOKEN_ENV]
    const resolver = resolverFor(file)
    assert.equal(resolver.probe(), false, '无字面值/环境/文件时应为 false')
    process.env[TOKEN_ENV] = 'ENV'
    assert.equal(resolver.probe(), true)
    delete process.env[TOKEN_ENV]
    writeFileSync(file, JSON.stringify({ userToken: 'FILE' }))
    assert.equal(resolver.probe(), true)
    assert.equal(resolverFor(file, { userToken: 'LITERAL' }).probe(), true)
  })
})

test('readField 同时兼容裸值与 DSH 的引用包装（.get()）', () => {
  assert.equal(readField('abc', 'fallback'), 'abc')
  assert.equal(readField({ get: () => 'wrapped' }, 'fallback'), 'wrapped')
  assert.equal(readField({ get: () => undefined }, 'fallback'), 'fallback')
  assert.equal(readField(undefined, 'fallback'), 'fallback')
  assert.equal(readField(null, 'fallback'), 'fallback')
})

test('describe() 只报告来源与开关，不含任何凭证值', async () => {
  await withSandbox(async ({ file }) => {
    const described = resolverFor(file, { userToken: 'SUPER-SECRET-TOKEN-VALUE' }).describe()
    assert.equal(described.hasLiteralToken, true)
    assert.equal(described.userTokenEnv, TOKEN_ENV)
    assert.equal(described.credentialsFile, file)
    assert.equal(JSON.stringify(described).includes('SUPER-SECRET-TOKEN-VALUE'), false)
  })
})

test('assertHeaderSafe 拒绝空值与含空白的 token', () => {
  assert.equal(assertHeaderSafe('good-token'), 'good-token')
  assert.throws(() => assertHeaderSafe(''), /形状不合法/)
  assert.throws(() => assertHeaderSafe('has space'), /形状不合法/)
  assert.throws(() => assertHeaderSafe('has\nnewline'), /形状不合法/)
})

test('DSH_HOME 决定默认凭证文件位置', async () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = path.join(tmpdir(), 'dsh-home-for-test')
    assert.equal(dshHome(), path.resolve(process.env.DSH_HOME))
    assert.equal(defaultCredentialsFile(), path.join(path.resolve(process.env.DSH_HOME), 'deepseek-web-search', 'credentials.json'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})