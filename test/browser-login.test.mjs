import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { findBrowser, listBrowsers, labelFor } from '../lib/browser-login.js'

/** 建一个临时的"伪浏览器"文件，模拟安装在任意盘符/自定义位置。 */
function fakeBrowser(name = 'my-browser.exe') {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-browser-'))
  const file = path.join(directory, name)
  writeFileSync(file, '')
  return { directory, file }
}

test('指定路径：存在即严格使用', () => {
  const { file, directory } = fakeBrowser()
  try {
    assert.equal(findBrowser(file), file)
    assert.equal(listBrowsers(file)[0].path, file)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('指定路径：不存在直接抛错，绝不静默换别的浏览器', () => {
  assert.throws(() => findBrowser('X:\\nowhere\\chrome.exe'), /指定的浏览器不存在/)
  // listBrowsers 不抛，但不把它列进去
  assert.equal(listBrowsers('X:\\nowhere\\chrome.exe').some((entry) => entry.path.includes('nowhere')), false)
})

test('自动选择：总能找到一个候选或返回 null（不抛）', () => {
  const found = findBrowser()
  const listed = listBrowsers()
  if (listed.length === 0) assert.equal(found, null)
  else {
    assert.equal(typeof found, 'string')
    assert.equal(listed.some((entry) => entry.path === found), true, '自动选择应来自列表首位')
  }
})

test('列表去重且路径真实存在', () => {
  const listed = listBrowsers()
  const lower = listed.map((entry) => entry.path.toLowerCase())
  assert.equal(new Set(lower).size, lower.length, '同一真实路径不应出现两次')
  for (const entry of listed) assert.equal(existsSync(entry.path), true, entry.path)
})

test('展示名映射常见浏览器', () => {
  const sample = labelFor(path.join('C:', 'Tools', 'msedge.exe'))
  assert.equal(sample, 'Microsoft Edge')
  const unknown = labelFor(path.join('D:', 'MyTools', 'mybrowser.exe'))
  assert.equal(unknown, 'mybrowser')
})