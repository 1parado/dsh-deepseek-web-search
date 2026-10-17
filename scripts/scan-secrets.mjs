#!/usr/bin/env node
/**
 * 发布前敏感信息扫描。
 *
 * 默认只扫**暂存区**（给 pre-commit 用），也可以扫全仓库或指定目录。
 * 命中即非零退出，让提交/发布在流水线上就断掉，而不是靠人记得检查。
 *
 * 用法：
 *   node scripts/scan-secrets.mjs               扫暂存区（pre-commit 默认）
 *   node scripts/scan-secrets.mjs --all         扫全部被 git 跟踪的文件
 *   node scripts/scan-secrets.mjs --path <目录>  扫指定目录（含未跟踪文件）
 *   node scripts/scan-secrets.mjs --json        机器可读输出
 *
 * 误报抑制：在该行任意位置加注释 `secret-scan: ignore`（或 GitHub 惯用的
 * `allowlist secret`）即可跳过该行。**只对确实合成的示例用**，别拿它掩盖真凭证。
 *
 * 安全约定：本脚本**从不完整打印**命中的内容，只给出长度与前 4 位 ——
 * 一个把 token 回显到终端的扫描器，本身就成了泄漏源。
 *
 * @module dsh-deepseek-web-search/scan-secrets
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 命中即阻断的规则。顺序无关，全部逐行跑一遍。 */
const RULES = [
  // 私钥块
  { id: 'private-key', label: '私钥', re: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/g },
  // 常见平台 token 前缀
  { id: 'github-token', label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { id: 'github-pat', label: 'GitHub PAT', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { id: 'openai-key', label: 'API key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { id: 'aws-key', label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'google-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe-key', label: 'Stripe key', re: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/g },
  // JWT：三段式，任意一段足够长
  { id: 'jwt', label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g },
  // 凭证赋值：键名像凭证，值足够长（真实 token 通常 >100 字符；32 是保守下界）
  // 键名后允许跟一个引号，覆盖 JSON 的 `"password": "..."` 写法。
  {
    id: 'credential-assignment',
    label: '凭证赋值',
    re: /\b(user_?token|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\b["'`]?\s*[:=]\s*["'`]?([A-Za-z0-9._\-+/=]{32,})/gi,
    valueGroup: 2,
  },
]

/** 绝不允许被提交的文件名。 */
const FORBIDDEN_PATHS = [
  { re: /(^|\/)\.env(\.|$)/, label: '.env 文件' },
  { re: /(^|\/)credentials\.json$/, label: '凭证文件' },
  { re: /\.(pem|key|p12|pfx|keystore|jks)$/i, label: '密钥文件' },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/, label: 'SSH 私钥' },
]

/** 目录遍历时跳过的位置。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', 'dist', '.plugin-manager'])

/** 单文件扫描上限，避免把大文件读进内存。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 高熵串的最小长度。 */
const ENTROPY_MIN_LENGTH = 40
/** 高熵判定阈值（bits/char）。base64 token 通常 > 4.5，自然语言 < 4。 */
const ENTROPY_THRESHOLD = 3.6

/** 该行是否被显式豁免。 */
export function isIgnoredLine(line) {
  return /secret-scan:\s*ignore|allowlist\s+secret/i.test(line)
}

/** 只暴露长度与前 4 位，绝不回显完整值。 */
export function mask(value) {
  return `[REDACTED 长度=${value.length} 前4=${value.slice(0, 4)}…]`
}

/** 香农熵，用来把「看起来随机的长串」和「正常长标识符」分开。 */
export function shannonEntropy(text) {
  const counts = new Map()
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / text.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

/** 明显不是凭证的高熵串：摘要、常量名、URL 片段。 */
export function isBenignHighEntropy(candidate, line) {
  if (/^sha(1|256|384|512)-/i.test(candidate)) return true
  if (/^[a-f0-9]{40}$/i.test(candidate)) return true // git commit sha
  if (/^[a-f0-9]{64}$/i.test(candidate)) return true // sha256
  // 全大写的 SCREAMING_SNAKE：环境变量名 / 常量名，不是凭证值
  if (/^[A-Z][A-Z0-9_]*$/.test(candidate)) return true
  // 点号不在 base64 字母表里，出现即说明是域名、文件名或路径
  if (candidate.includes('.')) return true
  // 同一行有协议头且片段含斜杠：URL 路径
  if (candidate.includes('/') && /:\/\//.test(line)) return true
  // 含斜杠且出现 5 个以上连续小写字母：路径/标识符（真实 token 几乎不会这样）
  if (candidate.includes('/') && /[a-z]{5,}/.test(candidate)) return true
  return false
}

/**
 * 扫描一段文本。
 * @param {string} text - 文件内容。
 * @param {string} file - 展示用路径。
 * @returns {Array<{file: string, line: number, rule: string, label: string, sample: string}>} 命中项。
 */
export function scanText(text, file) {
  const findings = []
  const lines = text.split(/\r\n|\r|\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || isIgnoredLine(line)) continue

    for (const rule of RULES) {
      rule.re.lastIndex = 0
      let match
      while ((match = rule.re.exec(line)) !== null) {
        const value = rule.valueGroup === undefined ? match[0] : match[rule.valueGroup]
        if (!value) continue
        findings.push({ file, line: index + 1, rule: rule.id, label: rule.label, sample: mask(value) })
        if (rule.re.lastIndex === match.index) rule.re.lastIndex += 1
      }
    }

    // 高熵长串：兜住没有固定前缀的随机 token
    const candidateRe = /[A-Za-z0-9+/=_-]{40,}/g
    let candidate
    while ((candidate = candidateRe.exec(line)) !== null) {
      const value = candidate[0]
      if (value.length < ENTROPY_MIN_LENGTH) continue
      if (isBenignHighEntropy(value, line)) continue
      if (shannonEntropy(value) < ENTROPY_THRESHOLD) continue
      findings.push({ file, line: index + 1, rule: 'high-entropy', label: '高熵长串', sample: mask(value) })
    }
  }

  return findings
}

/** 路径本身是否就不该出现。 */
export function checkPath(file) {
  for (const rule of FORBIDDEN_PATHS) {
    if (rule.re.test(file)) {
      return { file, line: 0, rule: 'forbidden-path', label: rule.label, sample: '(文件名命中，未读取内容)' }
    }
  }
  return null
}

/** 二进制文件跳过（含 NUL 即视为二进制）。 */
function looksBinary(buffer) {
  const probe = buffer.subarray(0, 8000)
  return probe.includes(0)
}

/** 缓存解析结果：undefined = 还没找过，null = 确实找不到。 */
let gitCommand

/**
 * 定位 git 可执行文件。
 *
 * 为什么要费这个劲：pre-commit 钩子在 Git for Windows 的 sh 里跑，Node 继承到的
 * PATH 是 POSIX 形式（/mingw64/bin），`spawn('git')` 会直接 ENOENT。所以钩子会把
 * 绝对路径通过 `DSH_GIT_EXECUTABLE` 传进来，这里再兜底试 PATH 与常见安装位置。
 * @returns {string|null} 可用的 git 命令，找不到返回 null。
 */
export function resolveGit() {
  if (gitCommand !== undefined) return gitCommand
  const candidates = [
    process.env.DSH_GIT_EXECUTABLE,
    'git',
    ...(process.platform === 'win32'
      ? [
          process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
          process.env.ProgramW6432 && path.join(process.env.ProgramW6432, 'Git', 'cmd', 'git.exe'),
          process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
        ]
      : []),
    '/usr/bin/git',
    '/usr/local/bin/git',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0)

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      gitCommand = candidate
      return gitCommand
    } catch {
      // 试下一个候选
    }
  }
  gitCommand = null
  return null
}

/** 跑 git，拿文本输出。 */
function git(args) {
  const command = resolveGit()
  if (command === null) throw new Error('git 不可用')
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** 跑 git，拿原始字节（`git show :path` 可能是二进制）。 */
function gitBuffer(args) {
  const command = resolveGit()
  if (command === null) throw new Error('git 不可用')
  return execFileSync(command, args, { maxBuffer: 64 * 1024 * 1024 })
}

/** 暂存区文件列表。 */
function stagedFiles() {
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
  return out.split('\0').filter(Boolean)
}

/** 全部被跟踪文件。 */
function trackedFiles() {
  const out = git(['ls-files', '-z'])
  return out.split('\0').filter(Boolean)
}

/** 递归列目录（跳过 SKIP_DIRS）。 */
function walk(directory, base = directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      found.push(...walk(path.join(directory, entry.name), base))
    } else if (entry.isFile()) {
      found.push(path.relative(base, path.join(directory, entry.name)).split(path.sep).join('/'))
    }
  }
  return found
}

/** 读文件：暂存区走 `git show :path`，其余读工作区。 */
function readContent(file, fromIndex) {
  if (fromIndex) {
    const buffer = gitBuffer(['show', `:${file}`])
    if (looksBinary(buffer)) return null
    return buffer.toString('utf8')
  }
  const absolute = path.resolve(file)
  if (!statSync(absolute).isFile()) return null
  if (statSync(absolute).size > MAX_FILE_BYTES) return null
  const buffer = readFileSync(absolute)
  if (looksBinary(buffer)) return null
  return buffer.toString('utf8')
}

function parseArguments(argv) {
  const options = { all: false, json: false, path: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--all') options.all = true
    else if (argument === '--json') options.json = true
    else if (argument === '--path') options.path = argv[++index]
    else if (argument === '--help' || argument === '-h') options.help = true
  }
  return options
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('用法：node scripts/scan-secrets.mjs [--all | --path <目录>] [--json]')
    return
  }

  // 安全门禁在无法执行时必须失败关闭 —— 静默放过比不做检查更糟。
  if (options.path === null && resolveGit() === null) {
    console.error('✗ 找不到 git，无法确定要扫描哪些文件。')
    console.error('  pre-commit 钩子在 Git Bash 下需要绝对路径：')
    console.error('    设 DSH_GIT_EXECUTABLE 指向 git 可执行文件（如 D:\\Git\\cmd\\git.exe）')
    console.error('  本次扫描失败关闭，不会放行。')
    process.exitCode = 2
    return
  }

  const fromIndex = options.path === null && !options.all
  let files
  if (options.path) files = walk(path.resolve(options.path))
  else if (options.all) files = trackedFiles()
  else files = stagedFiles()

  const findings = []
  let scanned = 0
  for (const file of files) {
    const pathFinding = checkPath(file)
    if (pathFinding) {
      findings.push(pathFinding)
      continue
    }
    let content
    try {
      content = readContent(file, fromIndex)
    } catch {
      continue // 已被删除或不可读，交给 git 自己报错
    }
    if (content === null) continue
    scanned += 1
    findings.push(...scanText(content, file))
  }

  if (options.json) {
    console.log(JSON.stringify({ scanned, files: files.length, findings }, null, 2))
  } else {
    console.log(`敏感信息扫描：${files.length} 个文件（可读 ${scanned} 个）`)
    if (findings.length === 0) {
      console.log('✓ 未发现疑似凭证。')
    } else {
      console.log(`\n✗ 发现 ${findings.length} 处疑似敏感信息：\n`)
      for (const finding of findings) {
        const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file
        console.log(`  ${where}  [${finding.rule}] ${finding.label}`)
        console.log(`    ${finding.sample}`)
      }
      console.log('\n处理方式：')
      console.log('  · 真凭证 → 立刻从文件移除，并到对应平台**轮换/吊销**（提交历史里已存在就算删掉也不安全）')
      console.log('  · 合成示例 → 在该行加注释 `secret-scan: ignore`')
      console.log('  · 凭证文件 → 加进 .gitignore 并 `git rm --cached`')
    }
  }

  if (findings.length > 0) process.exitCode = 1
}

// 直接执行时才跑 CLI；被测试 import 时只暴露函数。
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) main()