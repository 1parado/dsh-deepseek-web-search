/**
 * 凭证解析：把「网页版 userToken」从三个来源里按固定优先级取出来。
 *
 * 优先级（每个来源都可被下一条覆盖，取第一个命中的）：
 *   1. 插件配置里的字面值 `userToken` / `cookie`（不推荐：会落进配置文件）
 *   2. 启动环境变量 `DEEPSEEK_WEB_USER_TOKEN` / `DEEPSEEK_WEB_COOKIE`
 *   3. 凭证文件 `~/.dsh/deepseek-web-search/credentials.json`
 *
 * 这里**不使用** DSH 的 ctx.credentials：它在 `@deepseek-ai/dsh-credentials` 里，
 * 而该包在 profile 下的 junction 指向 npx 缓存（版本与运行时不符），从插件目录
 * import 会挂。环境变量与文件足以覆盖自持凭证的场景。
 *
 * 每次搜索重新解析一次，因此在文件里轮换 token 不需要重启 DSH（与 DSH 官方
 * provider「凭据按次解析」的行为一致）。
 *
 * @module dsh-deepseek-web-search/credentials
 */

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { CODE, SearchError, safeMessage } from './envelope.js'

/** 环境变量默认名。 */
export const DEFAULT_USER_TOKEN_ENV = 'DEEPSEEK_WEB_USER_TOKEN'
export const DEFAULT_COOKIE_ENV = 'DEEPSEEK_WEB_COOKIE'

/** 凭证文件相对 DSH_HOME 的位置。 */
export const CREDENTIALS_DIR = 'deepseek-web-search'
export const CREDENTIALS_FILE = 'credentials.json'

/**
 * 解析 DSH_HOME：优先 $DSH_HOME，否则 ~/.dsh。
 * @returns {string} 绝对路径。
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv ? path.resolve(fromEnv) : path.join(homedir(), '.dsh')
}

/**
 * 默认凭证文件路径。
 * @returns {string} 绝对路径。
 */
export function defaultCredentialsFile() {
  return path.join(dshHome(), CREDENTIALS_DIR, CREDENTIALS_FILE)
}

/**
 * 配置字段可能被 DSH 包装成「引用」（带 .get()），也可能是裸值。两种都读。
 * @param {unknown} field - 配置字段。
 * @param {unknown} fallback - 缺省值。
 * @returns {unknown} 实际值。
 */
export function readField(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined || value === null ? fallback : value
  }
  return field
}

/** 去掉首尾空白；非字符串或空白都当作"没有"。 */
function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * 读凭证文件。文件不存在返回 {}；存在但坏掉则报错——不静默吞掉配置错误。
 * @param {string} file - 绝对路径。
 * @returns {Promise<{userToken?: string, cookie?: string}>} 文件内容。
 */
export async function readCredentialsFile(file) {
  if (!existsSync(file)) return {}
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (cause) {
    throw new SearchError(`无法读取 DeepSeek 网页凭证文件：${safeMessage(cause)}`, CODE.credentialMissing, { cause })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new SearchError(`DeepSeek 网页凭证文件不是合法 JSON：${file}`, CODE.credentialMissing, { cause })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SearchError(`DeepSeek 网页凭证文件必须是 JSON 对象：${file}`, CODE.credentialMissing)
  }
  return { userToken: clean(parsed.userToken), cookie: clean(parsed.cookie) }
}

/**
 * 构造一个"按次解析"的凭证解析器。
 * @param {object} options - 依赖注入。
 * @param {object} options.config - 已读取默认值的插件配置。
 * @param {() => string} [options.now] - 时间源，保留给将来的缓存策略。
 * @returns {{ describe: () => object, probe: () => boolean, resolve: () => Promise<{userToken: string, cookie?: string, source: string}> }} 解析器。
 */
export function createCredentialResolver(options) {
  const config = options.config ?? {}
  const userTokenEnv = clean(readField(config.userTokenEnv, DEFAULT_USER_TOKEN_ENV)) ?? DEFAULT_USER_TOKEN_ENV
  const cookieEnv = clean(readField(config.cookieEnv, DEFAULT_COOKIE_ENV)) ?? DEFAULT_COOKIE_ENV
  const file = clean(readField(config.credentialsFile, '')) ?? defaultCredentialsFile()

  const describe = () => ({
    userTokenEnv,
    cookieEnv,
    credentialsFile: file,
    hasLiteralToken: clean(readField(config.userToken, '')) !== undefined,
    credentialsFilePresent: existsSync(file),
  })

  // available() 是同步的，只能看"存不存在解析路径"，不能看"值能不能用"。
  // 与 DSH 官方 provider 一致：可用性为真，真正的失败发生在搜索时并带指引。
  const probe = () => {
    if (clean(readField(config.userToken, ''))) return true
    if (clean(process.env[userTokenEnv])) return true
    try {
      return existsSync(file) && statSync(file).isFile()
    } catch {
      return false
    }
  }

  const resolve = async () => {
    const literal = clean(readField(config.userToken, ''))
    if (literal) {
      return { userToken: literal, cookie: clean(readField(config.cookie, '')), source: 'plugin-config' }
    }
    const fromEnv = clean(process.env[userTokenEnv])
    if (fromEnv) {
      return { userToken: fromEnv, cookie: clean(process.env[cookieEnv]), source: userTokenEnv }
    }
    const fromFile = await readCredentialsFile(file)
    if (fromFile.userToken) {
      return { userToken: fromFile.userToken, cookie: fromFile.cookie, source: file }
    }
    throw new SearchError(
      `DeepSeek 网页搜索没有可用的 userToken。三种填法任选其一：` +
        `(1) 设置环境变量 ${userTokenEnv}（Cookie 用 ${cookieEnv}）；` +
        `(2) 写入 ${file}，内容形如 {"userToken":"...","cookie":"..."}；` +
        `(3) 在插件配置里填字面值 userToken。` +
        `userToken 取自浏览器登录 chat.deepseek.com 后 localStorage 里的 userToken 字段（若是 JSON 对象则取其中的 value）。`,
      CODE.credentialMissing,
    )
  }

  return { describe, probe, resolve }
}

/** 校验 token 形状：不能有空白与换行，避免被拼进请求头。 */
export function assertHeaderSafe(token) {
  if (!token || /\s/.test(token)) {
    throw new SearchError(
      'DeepSeek 网页 userToken 形状不合法（为空或含空白/换行）。请重新从浏览器 localStorage 复制原始值。',
      CODE.credentialMissing,
    )
  }
  return token
}