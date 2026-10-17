import test from 'node:test'
import assert from 'node:assert/strict'

import { checkPath, isBenignHighEntropy, mask, scanText, shannonEntropy } from '../scripts/scan-secrets.mjs'

/**
 * 测试用的假凭证一律**动态拼出来**，不在源码里留字面量 ——
 * 否则这个测试文件本身就会被扫描器命中。
 */
const dashes = '-'.repeat(5)
const HIGH_ENTROPY = (() => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' // secret-scan: ignore（字符表，不是凭证）
  let state = 42
  let out = ''
  for (let index = 0; index < 64; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    out += alphabet[state % alphabet.length]
  }
  return out
})()

/** 扫描单行，返回命中的规则 id 集合。 */
function rulesFor(line) {
  return new Set(scanText(line, 'inline').map((finding) => finding.rule))
}

test('能抓到常见平台凭证', () => {
  assert.ok(rulesFor(`aws = ${'AKIA' + 'IOSFODNN7EXAMPLE'}`).has('aws-key'))
  assert.ok(rulesFor(`token = ${'ghp' + '_' + 'a'.repeat(24)}`).has('github-token'))
  assert.ok(rulesFor(`key = ${'sk' + '-' + 'b'.repeat(24)}`).has('openai-key'))
  assert.ok(rulesFor(`slack = ${'xox' + 'b-' + '1234567890abc'}`).has('slack-token'))
  assert.ok(rulesFor(`${dashes}BEGIN RSA PRIVATE KEY${dashes}`).has('private-key'))
})

test('能抓到 JWT 与凭证赋值', () => {
  const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(8)}`
  assert.ok(rulesFor(`Authorization: ${jwt}`).has('jwt'))

  assert.ok(rulesFor(`userToken: ${HIGH_ENTROPY}`).has('credential-assignment'))
  assert.ok(rulesFor(`cookie = "${'a1b2c3d4'.repeat(6)}"`).has('credential-assignment'))
  assert.ok(rulesFor(`"password": "${'Zx9'.repeat(15)}"`).has('credential-assignment'))
})

test('能抓到没有固定前缀的高熵 token（最关键的一条）', () => {
  assert.ok(rulesFor(`const leaked = '${HIGH_ENTROPY}'`).has('high-entropy'))
})

test('secret-scan: ignore 能抑制该行', () => {
  assert.equal(scanText(`const sample = '${HIGH_ENTROPY}' // secret-scan: ignore`, 'inline').length, 0)
  assert.equal(scanText(`const sample = '${HIGH_ENTROPY}' # allowlist secret`, 'inline').length, 0)
})

test('不误报环境变量名、URL、路径与摘要', () => {
  assert.equal(scanText('const env = "DEEPSEEK_WEB_USER_TOKEN"', 'inline').length, 0)
  assert.equal(scanText('// 见 https://github.com/1parado/dsh-deepseek-web-search/releases/tag/v0.1.0', 'inline').length, 0)
  assert.equal(scanText('凭证文件：$DSH_HOME/deepseek-web-search/credentials.json', 'inline').length, 0)
  assert.equal(scanText(`integrity: sha512-${'A'.repeat(86)}==`, 'inline').length, 0)
  assert.equal(scanText('commit e6f12d04dd25a946b02848cf7eb22ff78d7e3039', 'inline').length, 0)
})

test('不误报普通中文、代码与短值', () => {
  assert.equal(scanText('这是一个普通的句子，用来确认扫描器不会乱报。', 'inline').length, 0)
  assert.equal(scanText('userToken: "<token>"', 'inline').length, 0)
  assert.equal(scanText(`{ "value": "xxxxx", "__version": "0" }`, 'inline').length, 0)
})

test('禁止提交的路径一律拦下', () => {
  assert.equal(checkPath('.env')?.rule, 'forbidden-path')
  assert.equal(checkPath('config/.env.local')?.rule, 'forbidden-path')
  assert.equal(checkPath('credentials.json')?.rule, 'forbidden-path')
  assert.equal(checkPath('secrets/server.pem')?.rule, 'forbidden-path')
  assert.equal(checkPath('deploy/id_rsa')?.rule, 'forbidden-path')
  assert.equal(checkPath('lib/index.js'), null)
  assert.equal(checkPath('test/fixtures/search-stream.txt'), null)
})

test('mask 绝不回显原值', () => {
  const masked = mask(HIGH_ENTROPY)
  assert.equal(masked.includes(HIGH_ENTROPY), false)
  assert.equal(masked.includes(HIGH_ENTROPY.slice(4, 12)), false)
  assert.match(masked, /长度=64/)
})

test('高熵判定：随机串高、自然语言低', () => {
  assert.ok(shannonEntropy(HIGH_ENTROPY) > 3.6)
  assert.ok(shannonEntropy('the quick brown fox jumps over the lazy dog') < 4.6)
  assert.equal(isBenignHighEntropy('DEEPSEEK_WEB_USER_TOKEN', ''), true)
  assert.equal(isBenignHighEntropy(HIGH_ENTROPY, ''), false)
})