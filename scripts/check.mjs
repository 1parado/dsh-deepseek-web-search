#!/usr/bin/env node
/**
 * 本地检查：先对每个源文件做语法检查，再跑 node:test。
 *
 * @module dsh-deepseek-web-search/check
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const targets = ['lib', 'scripts', 'test'].flatMap((directory) =>
  readdirSync(path.join(root, directory))
    .filter((entry) => /\.m?js$/u.test(entry))
    .sort()
    .map((entry) => path.join(directory, entry)),
)

let failed = false
for (const target of targets) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, target)], { stdio: 'inherit' })
    console.log(`ok  ${target}`)
  } catch {
    failed = true
    console.error(`FAIL ${target}`)
  }
}

if (failed) {
  console.error('\n有文件未通过语法检查。')
  process.exit(1)
}

// `node --test <目录>` 在部分 Node 版本里会被当成模块路径，因此让 Node 自行发现用例。
execFileSync(process.execPath, ['--test'], { stdio: 'inherit', cwd: root })

// 最后跑敏感信息扫描：扫整个被跟踪的文件集合，命中即失败。
console.log('\n--- 敏感信息扫描 ---')
try {
  execFileSync(process.execPath, ['scripts/scan-secrets.mjs', '--all'], { stdio: 'inherit', cwd: root })
} catch (error) {
  // 退出码 1 = 扫描发现命中（已经打印过明细），必须让整体失败。
  if (error.status === 1) process.exit(1)
  console.warn('跳过敏感信息扫描：当前目录可能不是 git 仓库。')
}