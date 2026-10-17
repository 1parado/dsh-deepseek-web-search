import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { SearchCollector, sseFrames, toPublishedDate } from '../lib/sse.js'

/** fixture 取自真实抓包的结构（字段名与事件顺序未改动）。 */
async function loadFixture() {
  return readFile(new URL('./fixtures/search-stream.txt', import.meta.url), 'utf8')
}

/** 把 fixture 喂给 sseFrames + 归集器，返回两者结果。 */
async function drain(text) {
  const collector = new SearchCollector()
  const events = []
  for await (const frame of sseFrames(new Response(text).body)) {
    events.push(frame)
    if (frame.event === 'close' || frame.data === '[DONE]') break
    collector.apply(JSON.parse(frame.data))
  }
  return { collector, events }
}

test('SSE 帧按事件切分，event 与 data 都解析出来', async () => {
  const { events } = await drain(await loadFixture())
  assert.deepEqual(events.filter((frame) => frame.event === 'ready').length, 1)
  assert.ok(events.some((frame) => frame.event === 'update_session'))
  assert.equal(events.at(-1).event, 'close')
  assert.ok(events.every((frame) => typeof frame.data === 'string' && frame.data.length > 0))
})

test('LF / CRLF / CR 三种换行都能切帧', async () => {
  const block = (newline, value) => `data: {"v":"${value}"}${newline}${newline}`
  const text = block('\n', 'a') + block('\r\n', 'b') + block('\r', 'c')
  const collector = new SearchCollector()
  const seen = []
  for await (const frame of sseFrames(new Response(text).body)) {
    seen.push(frame.data)
    collector.apply(JSON.parse(frame.data))
  }
  assert.equal(seen.length, 3)
  assert.equal(collector.answerText, 'abc')
})

test('归集器只认结构化 results：URL、标题、摘要、日期、排名', async () => {
  const { collector } = await drain(await loadFixture())
  const sources = collector.list()

  assert.deepEqual(
    sources.map((source) => source.url),
    ['https://example.com/a', 'https://example.com/b', 'https://example.com/c', 'https://example.com/d'],
    '应按 cite_index 升序且去重',
  )
  assert.equal(sources[0].title, 'A 文档')
  assert.equal(sources[0].snippet, '第一段引用摘要。')
  assert.equal(sources[0].publishedAt, '2025-11-16')
  assert.equal(sources[1].publishedAt, '2026-04-14')
  assert.equal(sources[2].publishedAt, undefined, '没有 published_at 就不编造时间')
  assert.equal(sources[3].publishedAt, undefined, 'published_at 为 null 同样省略')
  assert.equal(sources[2].title, 'C 文档', '重复 URL 保留首次出现的条目')
  assert.equal(collector.sources.size, 4)
})

test('归集器记下判停所需的全部状态位', async () => {
  const { collector } = await drain(await loadFixture())
  assert.equal(collector.searchEnabled, true)
  assert.equal(collector.mode, 'SEARCH')
  assert.equal(collector.searchFinished, true)
  assert.deepEqual(collector.queries, ['示例查询一', '示例查询二'])
  assert.equal(collector.status, 'FINISHED')
  assert.equal(collector.settled(), true)
})

test('APPEND 的 fragment 下标续在已有 fragment 之后（回归：别覆盖 SEARCH 的类型）', async () => {
  const { collector } = await drain(await loadFixture())
  assert.equal(collector.fragmentTypes.get(0), 'SEARCH', '第一条 SEARCH fragment 的类型不能被后来的 APPEND 覆盖')
  assert.equal(collector.fragmentTypes.get(1), 'RESPONSE')
  assert.equal(collector.lastFragmentIndex, 1, '-1 应解析为最后出现的 fragment')
})

test('答案正文只累加 RESPONSE 类 fragment，快照作为基线', async () => {
  const { collector } = await drain(await loadFixture())
  assert.equal(collector.answerStarted, true)
  assert.equal(collector.answerText, '这是回答的第一段。')
})

test('绝对路径、显式下标与 BATCH 相对路径三种补丁都能归集', () => {
  const item = (url, cite) => ({ url, title: url, cite_index: cite })

  const explicit = new SearchCollector()
  explicit.apply({ p: 'response/fragments/0/results', v: [item('https://x/1', 1)] })
  assert.deepEqual(explicit.list().map((s) => s.url), ['https://x/1'])

  const relative = new SearchCollector()
  relative.apply({ p: 'response', o: 'BATCH', v: [{ p: 'fragments/-1/results', v: [item('https://x/2', 1)] }] })
  assert.deepEqual(relative.list().map((s) => s.url), ['https://x/2'])

  const fragment = new SearchCollector()
  fragment.apply({ v: { response: { fragments: [{ type: 'SEARCH', results: [item('https://x/3', 1)] }] } } })
  assert.deepEqual(fragment.list().map((s) => s.url), ['https://x/3'])
})

test('缺 url 的条目被丢弃，坏帧不抛异常', () => {
  const collector = new SearchCollector()
  collector.apply(null)
  collector.apply('nope')
  collector.apply({ p: 'response/fragments/-1/results', v: [{ title: '没有 url' }, null, 'x', { url: '  ' }] })
  collector.apply({ p: 'unknown/path', v: 1 })
  assert.deepEqual(collector.list(), [])
})

test('有来源但答案还没开始、也没有终态时不应判停', () => {
  const collector = new SearchCollector()
  assert.equal(collector.settled(), false)
  collector.apply({ p: 'response/fragments/-1/results', v: [{ url: 'https://x/1' }] })
  assert.equal(collector.settled(), false, '搜索可能还要再搜一轮，不能急着停读')
  collector.apply({ p: 'response/fragments/-1/type', v: 'RESPONSE' })
  assert.equal(collector.settled(), true)
})

test('toPublishedDate 只认能识别的输入', () => {
  assert.equal(toPublishedDate(1_763_308_800), '2025-11-16')
  assert.equal(toPublishedDate(1_763_308_800_000), '2025-11-16')
  assert.equal(toPublishedDate('2026-04-14T16:00:00Z'), '2026-04-14')
  assert.equal(toPublishedDate(null), undefined)
  assert.equal(toPublishedDate(0), undefined)
  assert.equal(toPublishedDate(-1), undefined)
  assert.equal(toPublishedDate('不是日期'), undefined)
  assert.equal(toPublishedDate(undefined), undefined)
})