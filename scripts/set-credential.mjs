#!/usr/bin/env node
/**
 * 把 DeepSeek 网页版凭证写进私有文件，供插件按次解析。
 *
 * 用法（不要把这些值写进 shell 历史时请用 --from-stdin）：
 *   node scripts/set-credential.mjs --user-token "<token>" [--cookie "<cookie>"]
 *   Get-Content token.txt | node scripts/set-credential.mjs --from-stdin [--cookie "..."]
 *   node scripts/set-credential.mjs --show        只报告当前解析到哪个来源，不打印值
 *   node scripts/set-credential.mjs --clear       删除凭证文件
 *
 * 写入位置：$DSH_HOME/deepseek-web-search/credentials.json（默认 ~/.dsh/...）。
 * 文件权限设为 0600；Windows 上 chmod 不生效，依赖用户目录 ACL，切勿把该目录
 * 同步到云盘或提交进 Git。
 *
 * @module dsh-deepseek-web-search/set-credential
 */

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { defaultCredentialsFile, readCredentialsFile } from '../lib/credentials.js'

/** 只展示长度与指纹，绝不回显原文。 */
function fingerprint(value) {
  if (typeof value !== 'string' || !value) return '(未设置)'
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8)
  return `长度=${value.length} sha256=${digest}`
}

function parseArguments(argv) {
  const options = { userToken: undefined, cookie: undefined, fromStdin: false, show: false, clear: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--user-token') options.userToken = argv[++index]
    else if (arg === '--cookie') options.cookie = argv[++index]
    else if (arg === '--from-stdin') options.fromStdin = true
    else if (arg === '--show') options.show = true
    else if (arg === '--clear') options.clear = true
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

function usage() {
  console.log(`用法：
  node scripts/set-credential.mjs --user-token "<token>" [--cookie "<cookie>"]
  Get-Content token.txt | node scripts/set-credential.mjs --from-stdin
  node scripts/set-credential.mjs --show
  node scripts/set-credential.mjs --clear

userToken 取自浏览器登录 chat.deepseek.com 后 localStorage 里的 userToken 字段
（若该值是 JSON 对象，取其中的 value）。`)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const file = defaultCredentialsFile()

  if (options.help) {
    usage()
    return
  }

  if (options.show) {
    console.log(`凭证文件：${file}（${existsSync(file) ? '存在' : '不存在'}）`)
    const envToken = process.env.DEEPSEEK_WEB_USER_TOKEN
    console.log(`环境变量 DEEPSEEK_WEB_USER_TOKEN：${fingerprint(envToken)}`)
    const stored = await readCredentialsFile(file)
    console.log(`文件里的 userToken：${fingerprint(stored.userToken)}`)
    console.log(`文件里的 cookie：${fingerprint(stored.cookie)}`)
    console.log(`实际生效来源：${envToken ? '环境变量' : stored.userToken ? '凭证文件' : '无'}`)
    return
  }

  if (options.clear) {
    if (!existsSync(file)) {
      console.log('凭证文件本来就不存在，无需删除。')
      return
    }
    rmSync(file)
    console.log(`已删除 ${file}`)
    return
  }

  const userToken = (options.userToken ?? (options.fromStdin ? await readStdin() : '')).trim()
  if (!userToken) {
    console.error('缺少 userToken。用 --user-token 传入，或 --from-stdin 从标准输入读。')
    process.exitCode = 2
    return
  }
  if (/\s/.test(userToken)) {
    console.error('userToken 含空白或换行，几乎肯定是复制错了（应是一整行不含空格的字符串）。')
    process.exitCode = 2
    return
  }

  mkdirSync(path.dirname(file), { recursive: true })
  const payload = { userToken }
  if (options.cookie) payload.cookie = options.cookie.trim()
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 上 chmod 是空操作；靠用户目录 ACL。
  }

  console.log(`已写入 ${file}`)
  console.log(`  userToken：${fingerprint(userToken)}`)
  console.log(`  cookie：${fingerprint(payload.cookie)}`)
  console.log('重启或热重载不需要：插件每次搜索都会重新读一次文件。')
}

await main()