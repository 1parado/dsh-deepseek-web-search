/**
 * DeepSeekHashV1 —— chat.deepseek.com 在每次 completion 之前要求的工作量证明。
 *
 * 算法：SHA3-256 的海绵结构（rate 136、domain 0x06、32 字节摘要），但置换用
 * KECCAK-p[1600,23] —— 即 FIPS 202 的置换跳过第一轮，只跑第 1..23 轮，与厂商
 * 自己的 pow_solver.wasm 一致。
 *
 * 搜索空间：nonce 从 0 到 difficulty-1，把 `${salt}_${expireAt}_${nonce}` 喂进
 * 上面的哈希，命中 challenge 里给出的摘要即为答案。前缀只吸收一次，每次尝试
 * 只把 nonce 的十进制字节折进状态，这是厂商 solver 的做法。
 *
 * 移植自 magpie-deepseekweb2api（MIT, Copyright (c) 2026 木子不是木子狸）的
 * src/pow.mjs：算法、字节序与增量搜索结构未改动，只收敛了接口。
 *
 * @module dsh-deepseek-web-search/pow
 */

import { setImmediate } from 'node:timers/promises'

const LANE_MASK = (1n << 64n) - 1n
const RATE = 136
const OUT = 32
const DEEPSEEK_HASH_ROUNDS = 23
const SHA3_DOMAIN_SUFFIX = 0x06
const DIGEST_HEX = /^[a-f0-9]{64}$/i
const HEX = '0123456789abcdef'

/** difficulty 上限：厂商一般要 ~144000，给个上界避免恶意 challenge 把宿主钉死。 */
export const MAX_DIFFICULTY = 5_000_000

/** sha3Digest 的轮数：24 是标准 SHA3-256，23 是 DeepSeekHashV1。 */
export const SHA3_ROUNDS = 24

// 按 x + 5*y 索引，对应 FIPS 202 的状态坐标。
const ROTATION_OFFSETS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

/** 左旋 64 位 lane；amount 为 0 时不做位移，避免 BigInt 移 64 位。 */
function rotateLeft(value, amount) {
  if (amount === 0) return value
  const shift = BigInt(amount)
  return ((value << shift) | (value >> (64n - shift))) & LANE_MASK
}

/** KECCAK-p[1600,24] 的最后 `rounds` 轮；23 即 DeepSeekHashV1，24 即 SHA3-256。 */
function permute(state, rounds) {
  const columnParity = new Array(5)
  const thetaMix = new Array(5)
  const rhoPi = new Array(25)
  for (let round = ROUND_CONSTANTS.length - rounds; round < ROUND_CONSTANTS.length; round++) {
    for (let x = 0; x < 5; x++) {
      columnParity[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
    }
    for (let x = 0; x < 5; x++) {
      thetaMix[x] = columnParity[(x + 4) % 5] ^ rotateLeft(columnParity[(x + 1) % 5], 1)
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) state[x + 5 * y] ^= thetaMix[x]
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const destinationX = y
        const destinationY = (2 * x + 3 * y) % 5
        const lane = x + 5 * y
        rhoPi[destinationX + 5 * destinationY] = rotateLeft(state[lane], ROTATION_OFFSETS[lane])
      }
    }
    for (let y = 0; y < 5; y++) {
      const row = 5 * y
      for (let x = 0; x < 5; x++) {
        state[x + row] =
          rhoPi[x + row] ^ (~rhoPi[((x + 1) % 5) + row] & LANE_MASK & rhoPi[((x + 2) % 5) + row])
      }
    }
    state[0] ^= ROUND_CONSTANTS[round]
  }
}

/** 吸收一个完整 rate 块。 */
function absorb(state, bytes, offset, rounds) {
  for (let index = 0; index < RATE; index++) {
    const lane = index >>> 3
    state[lane] ^= BigInt(bytes[offset + index]) << BigInt((index & 7) * 8)
  }
  permute(state, rounds)
}

/**
 * 海绵结构摘要：`rounds` 为 24 时就是标准 SHA3-256（测试里用 node:crypto 对齐），
 * 为 23 时即 DeepSeekHashV1。
 * @param {string} input - 待摘要文本。
 * @param {number} rounds - 置换轮数。
 * @returns {string} 64 个小写十六进制字符。
 */
export function sha3Digest(input, rounds) {
  const bytes = new TextEncoder().encode(input)
  const state = new Array(25).fill(0n)
  let offset = 0
  while (offset + RATE <= bytes.length) {
    absorb(state, bytes, offset, rounds)
    offset += RATE
  }
  const remaining = bytes.length - offset
  for (let index = 0; index < remaining; index++) {
    state[index >>> 3] ^= BigInt(bytes[offset + index]) << BigInt((index & 7) * 8)
  }
  state[remaining >>> 3] ^= BigInt(SHA3_DOMAIN_SUFFIX) << BigInt((remaining & 7) * 8)
  state[(RATE - 1) >>> 3] ^= 0x80n << 56n
  permute(state, rounds)
  let digest = ''
  for (let index = 0; index < OUT; index++) {
    digest += HEX[Number((state[index >>> 3] >> BigInt((index & 7) * 8)) & 0xffn) >>> 4]
    digest += HEX[Number((state[index >>> 3] >> BigInt((index & 7) * 8)) & 0x0fn)]
  }
  return digest
}

/** DeepSeekHashV1 = 23 轮的 SHA3 海绵。 */
export function deepSeekHashV1(input) {
  return sha3Digest(input, DEEPSEEK_HASH_ROUNDS)
}

/** challenge 被校验的前缀：salt、expireAt，之后接 nonce。 */
export function powPrefix(challenge) {
  return `${challenge.salt}_${challenge.expireAt}_`
}

/** 校验 challenge 形状，返回前缀。不合法直接抛，不猜。 */
function checkChallenge(challenge) {
  if (!challenge || typeof challenge !== 'object') throw new Error('DeepSeek PoW challenge missing')
  const { algorithm, challenge: digest, salt, difficulty, expireAt } = challenge
  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`DeepSeek PoW algorithm ${JSON.stringify(algorithm)} is not DeepSeekHashV1`)
  }
  if (typeof digest !== 'string' || !DIGEST_HEX.test(digest)) {
    throw new Error('DeepSeek PoW challenge must be a 64-character hex digest')
  }
  if (typeof salt !== 'string' || !salt || salt.length > 4096) {
    throw new Error('DeepSeek PoW challenge salt is missing or too large')
  }
  if (!Number.isSafeInteger(difficulty) || difficulty < 1) {
    throw new Error('DeepSeek PoW difficulty must be a positive whole number')
  }
  if (difficulty > MAX_DIFFICULTY) {
    throw new Error(`DeepSeek PoW difficulty ${difficulty} is above ${MAX_DIFFICULTY}`)
  }
  if (!Number.isSafeInteger(expireAt)) throw new Error('DeepSeek PoW challenge has no expire_at')
  return powPrefix({ salt, expireAt })
}

/**
 * 每 tick 次尝试 yield 一次，让调用方决定是继续跑还是交还事件循环。
 * @param {object} challenge - 已校验形状的 challenge。
 * @param {{ tick: number, signal?: AbortSignal }} options - 让步粒度与取消信号。
 * @yields {number} 已尝试次数。
 * @returns {number} 命中的 nonce。
 */
function* searchPow(challenge, { tick, signal }) {
  const prefix = checkChallenge(challenge)
  const prefixBytes = new TextEncoder().encode(prefix)
  const baseState = new Array(25).fill(0n)
  let offset = 0
  while (offset + RATE <= prefixBytes.length) {
    absorb(baseState, prefixBytes, offset, DEEPSEEK_HASH_ROUNDS)
    offset += RATE
  }
  const tailLength = prefixBytes.length - offset
  const tail = new Array(Math.ceil(tailLength / 8)).fill(0n)
  for (let index = 0; index < tailLength; index++) {
    tail[index >>> 3] ^= BigInt(prefixBytes[offset + index]) << BigInt((index & 7) * 8)
  }
  const wanted = challenge.challenge.toLowerCase()
  const target = new Array(OUT >>> 3).fill(0n)
  for (let index = 0; index < OUT; index++) {
    const byte = BigInt(`0x${wanted.slice(index * 2, index * 2 + 2)}`)
    target[index >>> 3] |= byte << BigInt((index & 7) * 8)
  }
  const state = new Array(25).fill(0n)
  const { difficulty } = challenge
  for (let nonce = 0; nonce < difficulty; nonce++) {
    if (signal?.aborted) throw signal.reason ?? new Error('DeepSeek PoW search was stopped')
    state.length = 0
    for (let lane = 0; lane < 25; lane++) state[lane] = baseState[lane]
    for (let lane = 0; lane < tail.length; lane++) state[lane] ^= tail[lane]
    let position = tailLength
    const text = String(nonce)
    for (let index = 0; index < text.length; index++) {
      state[position >>> 3] ^= BigInt(text.charCodeAt(index)) << BigInt((position & 7) * 8)
      position += 1
      if (position === RATE) {
        permute(state, DEEPSEEK_HASH_ROUNDS)
        position = 0
      }
    }
    state[position >>> 3] ^= BigInt(SHA3_DOMAIN_SUFFIX) << BigInt((position & 7) * 8)
    state[(RATE - 1) >>> 3] ^= 0x80n << 56n
    permute(state, DEEPSEEK_HASH_ROUNDS)
    let matched = true
    for (let lane = 0; lane < target.length; lane++) {
      if (state[lane] !== target[lane]) {
        matched = false
        break
      }
    }
    if (matched) return nonce
    if (nonce % tick === tick - 1) yield nonce + 1
  }
  throw new Error(`DeepSeek PoW challenge was not solved within ${difficulty} tries`)
}

/**
 * 同步求解，供离线向量与自持取消的调用方使用。
 * @param {object} challenge - create_pow_challenge 返回的 challenge。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {number} 命中的 nonce。
 */
export function solvePow(challenge, signal) {
  const search = searchPow(challenge, { tick: 8192, signal })
  for (;;) {
    const step = search.next()
    if (step.done) return step.value
  }
}

/**
 * 异步求解：每 tick 次尝试交还一次执行权，宿主 RPC 与取消在计算期间仍可推进。
 * @param {object} challenge - create_pow_challenge 返回的 challenge。
 * @param {{ signal?: AbortSignal, timeoutMs?: number, tick?: number }} [options] - 取消/超时/让步粒度。
 * @returns {Promise<number>} 命中的 nonce。
 */
export async function solvePowAsync(challenge, options = {}) {
  const tick = options.tick ?? 128
  if (!Number.isSafeInteger(tick) || tick < 1 || tick > 1024) {
    throw new Error('DeepSeek async PoW tick must be between 1 and 1024')
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 90_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const search = searchPow(challenge, { tick, signal })
  try {
    for (;;) {
      const step = search.next()
      if (step.done) return step.value
      await setImmediate()
    }
  } finally {
    search.return()
  }
}

/**
 * x-ds-pow-response 请求头的内容：challenge 答案的 base64 包装。
 * @param {object} challenge - create_pow_challenge 返回的 challenge。
 * @param {number} answer - 求解出的 nonce。
 * @param {{ targetPath?: string }} [options] - 覆盖目标路径。
 * @returns {string} base64 字符串。
 */
export function powHeader(challenge, answer, options = {}) {
  const body = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: options.targetPath ?? challenge.targetPath ?? challenge.target_path ?? '',
  }
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
}