#!/usr/bin/env node
/**
 * 用真实账号跑一次联网搜索，验证 userToken 是否可用。
 *
 * 不需要重启 DSH：直接复用插件的 provider 走完整链路
 * （开会话 → PoW → completion → SSE 结果归集），把来源打印出来。
 *
 * 用法：
 *   node scripts/verify-live.mjs                    用默认查询
 *   node scripts/verify-live.mjs "你想搜的关键词"
 *
 * 只读取 $DSH_HOME/deepseek-web-search/credentials.json、环境变量或插件配置，
 * 不会写入任何东西，也不会打印 token 本身。
 *
 * @module dsh-deepseek-web-search/verify-live
 */

import { createCredentialResolver, defaultCredentialsFile } from '../lib/credentials.js'
import { createSessionCache, DeepSeekWebSearchProvider } from '../lib/provider.js'

/** 默认查询：带时效性，能稳定触发联网搜索。 */
const DEFAULT_QUERY = 'DeepSeek 最新模型'

function buildProvider(credentials, origin) {
  return new DeepSeekWebSearchProvider(() => ({
    origin,
    clientVersion: '2.4.0',
    model: 'default',
    thinking: false,
    includeAnswer: false,
    stopAfterResults: true,
    sessionTimeoutMs: 20_000,
    requestTimeoutMs: 90_000,
    powTimeoutMs: 90_000,
    session: createSessionCache(false),
    isAvailable: credentials.probe,
    resolveCredentials: credentials.resolve,
    recordRequest: () => {},
  }))
}

async function main() {
  const query = (process.argv[2] ?? DEFAULT_QUERY).trim()
  const origin = process.env.DEEPSEEK_WEB_ORIGIN?.trim() || 'https://chat.deepseek.com'
  const credentials = createCredentialResolver({ config: {} })

  console.log('DeepSeek 网页搜索自检')
  console.log(`  端点    ：${origin}`)
  console.log(`  凭证文件：${defaultCredentialsFile()}`)
  console.log(`  查询    ：${query}`)
  console.log('')

  const provider = buildProvider(credentials, origin)
  if (!provider.available()) {
    console.error('✗ 没有找到可用凭证。')
    console.error('  先设置：node scripts/set-credential.mjs --user-token "<token>"')
    console.error('  或设置环境变量 DEEPSEEK_WEB_USER_TOKEN。')
    process.exitCode = 2
    return
  }

  const started = Date.now()
  try {
    const result = await provider.search({ query }, new AbortController().signal)
    const elapsed = Date.now() - started
    console.log(`✓ 成功，用时 ${elapsed} ms，拿到 ${result.sources.length} 条来源：\n`)
    result.sources.forEach((source, index) => {
      const date = source.publishedAt ? ` (${source.publishedAt})` : ''
      console.log(`${index + 1}. ${source.title ?? source.url}${date}`)
      console.log(`   ${source.url}`)
      if (source.snippet) console.log(`   ${source.snippet.slice(0, 120)}`)
    })
    console.log('\n凭证可用。重启 DSH 后即可在内置 web_search 里使用。')
  } catch (error) {
    const elapsed = Date.now() - started
    console.error(`✗ 失败（${elapsed} ms）`)
    console.error(`  code: ${error?.code ?? '(无)'}`)
    console.error(`  ${error?.message ?? error}`)
    console.error('')
    console.error('对照 README 的排障表：')
    console.error('  40003 Authorization Failed → token 无效或已过期（最常见），重新取 userToken')
    console.error('  401/403                    → token 过期或被登出，重新取 userToken')
    console.error('  429                        → 上游风控/限流，换网络或稍后重试')
    console.error('  无结构化结果               → 上游改版或该查询未触发联网搜索')
    process.exitCode = 1
  }
}

await main()