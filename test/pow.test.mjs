import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  deepSeekHashV1,
  MAX_DIFFICULTY,
  powHeader,
  powPrefix,
  SHA3_ROUNDS,
  sha3Digest,
  solvePow,
  solvePowAsync,
} from '../lib/pow.js'

/** 与厂商一致的前缀：salt_expireAt_nonce。 */
const SALT = 'test-salt'
const EXPIRE_AT = 1_700_000_000

/** 自己造一个"已知答案"的 challenge：难度刚好覆盖到目标 nonce。 */
function makeChallenge(nonce, overrides = {}) {
  const digest = deepSeekHashV1(`${SALT}_${EXPIRE_AT}_${nonce}`)
  return {
    algorithm: 'DeepSeekHashV1',
    challenge: digest,
    salt: SALT,
    expire_at: EXPIRE_AT,
    expireAt: EXPIRE_AT,
    difficulty: nonce + 1,
    signature: 'test-signature',
    ...overrides,
  }
}

test('sha3Digest(24 轮) 与 node:crypto 的 SHA3-256 逐字节一致', () => {
  const vectors = ['', 'abc', 'a'.repeat(135), 'a'.repeat(136), 'a'.repeat(137), '中文-多字节-测试-'.repeat(20)]
  for (const input of vectors) {
    const expected = createHash('sha3-256').update(input, 'utf8').digest('hex')
    assert.equal(sha3Digest(input, SHA3_ROUNDS), expected, `输入长度 ${input.length} 不一致`)
  }
})

test('deepSeekHashV1 是 23 轮，与 24 轮结果不同但形状相同', () => {
  const input = `${SALT}_${EXPIRE_AT}_0`
  const v1 = deepSeekHashV1(input)
  assert.match(v1, /^[a-f0-9]{64}$/)
  assert.notEqual(v1, sha3Digest(input, SHA3_ROUNDS))
})

test('powPrefix 用 salt_expireAt_ 拼接', () => {
  assert.equal(powPrefix({ salt: SALT, expireAt: EXPIRE_AT }), `${SALT}_${EXPIRE_AT}_`)
})

test('solvePow 能解出各自难度下的 nonce（含 0 与跨 tick 场景）', () => {
  for (const nonce of [0, 1, 7, 137, 300]) {
    const challenge = makeChallenge(nonce)
    assert.equal(solvePow(challenge), nonce, `nonce=${nonce} 未解出`)
  }
})

test('solvePowAsync 在让步点之间仍能解出，且不阻塞事件循环', async () => {
  const challenge = makeChallenge(260)
  let interleaved = false
  const pending = solvePowAsync(challenge, { tick: 128 }).then((answer) => {
    assert.equal(answer, 260)
    return answer
  })
  // 让步点应该让出执行权，使这段同步代码在求解期间先跑完。
  await Promise.resolve().then(() => {
    interleaved = true
  })
  assert.equal(await pending, 260)
  assert.equal(interleaved, true)
})

test('solvePowAsync 支持取消，且 tick 越界会被拒绝', async () => {
  const controller = new AbortController()
  controller.abort(new Error('用户取消'))
  await assert.rejects(
    () => solvePowAsync(makeChallenge(1_000), { signal: controller.signal, tick: 8 }),
    /用户取消|stopped/,
  )
  await assert.rejects(() => solvePowAsync(makeChallenge(1), { tick: 0 }), /tick/)
  await assert.rejects(() => solvePowAsync(makeChallenge(1), { tick: 4096 }), /tick/)
})

test('powHeader 是 challenge 答案的 base64 包装，target_path 随之携带', () => {
  const challenge = makeChallenge(7)
  const header = powHeader(challenge, 7, { targetPath: '/api/v0/chat/completion' })
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  assert.equal(decoded.algorithm, 'DeepSeekHashV1')
  assert.equal(decoded.challenge, challenge.challenge)
  assert.equal(decoded.salt, SALT)
  assert.equal(decoded.answer, 7)
  assert.equal(decoded.signature, 'test-signature')
  assert.equal(decoded.target_path, '/api/v0/chat/completion')
})

test('powHeader 缺省时回落到 challenge 自带的 target_path', () => {
  const challenge = makeChallenge(3, { target_path: '/api/v0/chat/continue' })
  const decoded = JSON.parse(Buffer.from(powHeader(challenge, 3), 'base64').toString('utf8'))
  assert.equal(decoded.target_path, '/api/v0/chat/continue')
})

test('非法 challenge 一律拒绝，不猜测', () => {
  assert.throws(() => solvePow(null), /missing/)
  assert.throws(() => solvePow(makeChallenge(1, { algorithm: 'Other' })), /DeepSeekHashV1/)
  assert.throws(() => solvePow(makeChallenge(1, { challenge: 'zz' })), /64-character hex/)
  assert.throws(() => solvePow(makeChallenge(1, { salt: '' })), /salt/)
  assert.throws(() => solvePow(makeChallenge(1, { difficulty: 0 })), /positive whole number/)
  assert.throws(() => solvePow(makeChallenge(1, { difficulty: MAX_DIFFICULTY + 1 })), /above/)
  assert.throws(() => solvePow(makeChallenge(1, { expireAt: 'x' })), /expire_at/)
})