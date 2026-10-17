/**
 * 凭证文件的原子写入与读取。
 *
 * 写坏凭证文件的代价是"搜索突然不可用且原因难查"，所以写入走
 * 「临时文件 → 校验 → rename」三步：任何一步失败，原文件保持原样。
 *
 * @module dsh-deepseek-web-search/atomic-file
 */

import { writeFile, readFile, rename, mkdir, unlink, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 原子写 JSON：临时文件写完读回来校验，再 rename 覆盖。
 * @param {string} file - 目标路径。
 * @param {object} payload - 要写入的对象。
 * @param {number} [mode] - 文件权限，默认 0o600。
 * @returns {Promise<{bytes: number}>} 写入字节数。
 */
export async function writeJsonAtomic(file, payload, mode = 0o600) {
  const text = `${JSON.stringify(payload, null, 2)}\n`
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode })
    if (process.platform !== 'win32') {
      try { await chmod(temporary, mode) } catch { /* 平台差异，尽力 */ }
    }
    const roundTrip = JSON.parse(await readFile(temporary, 'utf8'))
    if (roundTrip.userToken !== payload.userToken) {
      throw new Error('写入后校验失败：临时文件内容与预期不一致')
    }
    await rename(temporary, file)
    return { bytes: Buffer.byteLength(text, 'utf8') }
  } catch (error) {
    try { await unlink(temporary) } catch { /* 清理失败不影响主错误 */ }
    throw error
  }
}

/**
 * 读凭证文件并做形状校验。
 * @param {string} file - 路径。
 * @returns {Promise<{userToken: string, cookie?: string}|null>} 内容；文件不存在为 null。
 */
export async function readCredentialFile(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { corrupt: true }
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.userToken !== 'string' || !parsed.userToken.trim()) {
    return { corrupt: true }
  }
  return { userToken: parsed.userToken, cookie: typeof parsed.cookie === 'string' ? parsed.cookie : undefined }
}
