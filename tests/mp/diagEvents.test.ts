/**
 * 「客户端事件双写 + 三来源合并」的契约层单测（2026-09-23 新增）
 *
 * 覆盖用户要求里**能离线钉住**的部分：
 *   · **字段白名单**：未知 `level` / 坏 `id` / 坏 `at` / 超长文本 / `data` 里的嵌套对象一律拒或丢；
 *   · **脱敏仍生效**：事件文本与 `data` 走同一套判据（`redactFreeText` 由调用方负责，这里钉"白名单不放松"）；
 *   · **受理判定**（`acceptDiagEvents`）：无窗口 ⇒ `ok:false` + `no-window`；单请求上限；每窗口上限；
 *   · **三来源合并**（`mergeDiagEvents`）：按 `id` 去重、顺序（按 `at` 升序）、**各来源条数如实计数**；
 *   · 老数据（没有 `id`）按"时间+文本"退化成同一个键。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DIAG_EVENT_BATCH_MAX,
  DIAG_EVENT_DATA_MAX_KEYS,
  DIAG_EVENT_PER_WINDOW_MAX,
  DIAG_EVENT_TEXT_MAX,
  DIAG_TIMELINE_MAX,
  acceptDiagEvents,
  checkDiagEvent,
  checkDiagEventPayload,
  mergeDiagEvents,
} from '../../utils/mp/diagnostics.ts'

const ev = (over: Record<string, unknown> = {}) => ({
  id: 'c1a2b3-x9',
  at: '2026-09-23T10:00:00.000Z',
  level: 'info',
  cat: 'ui',
  text: '点了「开始跑步」',
  ...over,
})

test('事件白名单：合格事件原样通过（含扁平 data）', () => {
  const ok = checkDiagEvent(ev({ data: { km: 3, ok: true, note: 'x', none: null } }))
  assert.ok(ok, '应当通过')
  assert.equal(ok!.level, 'info')
  assert.deepEqual(ok!.data, { km: 3, ok: true, note: 'x', none: null })
})

test('事件白名单：拒绝未知 level / 坏 id / 坏 at / 空文本', () => {
  assert.equal(checkDiagEvent(ev({ level: 'debug' })), null, '未知 level 要拒')
  assert.equal(checkDiagEvent(ev({ level: 'gate' }))?.level, 'gate', 'gate 是合法 level（被拦下的提交）')
  assert.equal(checkDiagEvent(ev({ id: '' })), null, '空 id 要拒')
  assert.equal(checkDiagEvent(ev({ id: 'a b/c\\d' })), null, '含空白的 id 要拒')
  assert.equal(checkDiagEvent(ev({ id: 'ok-id_1.2:3' }))?.id, 'ok-id_1.2:3', '白名单字符的 id 要收')
  assert.equal(checkDiagEvent(ev({ at: '不是时间' })), null, 'at 解析不了要拒')
  assert.equal(checkDiagEvent(ev({ text: '   ' })), null, '空文本要拒')
  assert.equal(checkDiagEvent(null), null)
  assert.equal(checkDiagEvent([]), null)
})

test('事件白名单：超长文本**截断**（不是拒绝），并标注原长度', () => {
  const long = 'x'.repeat(DIAG_EVENT_TEXT_MAX * 3)
  const ok = checkDiagEvent(ev({ text: long }))
  assert.ok(ok)
  assert.ok(ok!.text.length <= DIAG_EVENT_TEXT_MAX + 30, `截断后不该超上限太多：${ok!.text.length}`)
  assert.match(ok!.text, /\[截断，原 \d+ 字符\]/)
})

test('事件白名单：`data` **只收扁平标量** —— 嵌套对象/数组被丢掉该键（不许原样透传）', () => {
  const ok = checkDiagEvent(
    ev({
      data: {
        flat: 'ok',
        num: 1,
        nested: { a: 1 },
        arr: [1, 2, 3],
        deep: { b: { c: 2 } },
      },
    }),
  )
  assert.ok(ok)
  assert.equal(ok!.data?.flat, 'ok')
  assert.equal(ok!.data?.num, 1)
  assert.equal(ok!.data?.nested, undefined, '嵌套对象必须被丢掉')
  assert.equal(ok!.data?.arr, undefined, '数组必须被丢掉')
  assert.equal(ok!.data?.deep, undefined)
  // 键数上限
  const many = Object.fromEntries(Array.from({ length: DIAG_EVENT_DATA_MAX_KEYS + 5 }, (_, i) => [`k${i}`, i]))
  const capped = checkDiagEvent(ev({ data: many }))
  assert.ok(Object.keys(capped!.data ?? {}).length <= DIAG_EVENT_DATA_MAX_KEYS, 'data 键数要有上限')
})

test('批量校验：单请求上限 + 如实计数被拒条数（不静默丢）', () => {
  const many = Array.from({ length: DIAG_EVENT_BATCH_MAX + 3 }, (_, i) => ev({ id: `c${i}-a` }))
  const r = checkDiagEventPayload(many)
  assert.equal(r.accepted.length, DIAG_EVENT_BATCH_MAX, '单请求只收上限内的')
  assert.equal(r.rejected, 3, '超出部分要如实计数')
  assert.ok(r.reasons.includes('over-batch-max'))
  // 非数组
  assert.deepEqual(checkDiagEventPayload('nope').reasons, ['not-array'])
})

test('受理判定：**没有活动窗口 ⇒ ok:false + no-window**（不是 4xx）', () => {
  const r = acceptDiagEvents([ev()], false, 0)
  assert.equal(r.ok, false)
  assert.equal(r.accepted.length, 0)
  assert.equal(r.reasons[0], 'no-window')
  assert.match(r.note, /没有活动中的记录窗口/)
})

test('受理判定：每窗口上限 —— 收满为止，余下如实拒绝', () => {
  const near = DIAG_EVENT_PER_WINDOW_MAX - 1
  const batch = [ev({ id: 'c1-a' }), ev({ id: 'c2-a' }), ev({ id: 'c3-a' })]
  const r = acceptDiagEvents(batch, true, near)
  assert.equal(r.accepted.length, 1, '只剩 1 条额度')
  assert.equal(r.rejected, 2, '另 2 条要如实拒绝')
  assert.ok(r.reasons.includes('over-window-max'))
  assert.equal(r.countedInWindow, DIAG_EVENT_PER_WINDOW_MAX, '计数要推到上限')
  /** 已经满了 ⇒ 一条也收不下 */
  const full = acceptDiagEvents(batch, true, DIAG_EVENT_PER_WINDOW_MAX)
  assert.equal(full.accepted.length, 0)
  assert.equal(full.ok, false)
})

test('三来源合并：按 id 去重、按时间升序、各来源条数如实计数', () => {
  const client = [
    { id: 'a', at: '2026-09-23T10:00:02.000Z', level: 'info' as const, cat: 'ui', text: '刷新后 1' },
    { id: 'b', at: '2026-09-23T10:00:03.000Z', level: 'info' as const, cat: 'ui', text: '刷新后 2' },
  ]
  const storage = [
    // 与 client 的 a 同 id（刷新前就写了兜底）⇒ 应当被去重
    { id: 'a', at: '2026-09-23T10:00:02.000Z', level: 'info' as const, cat: 'ui', text: '刷新前 1' },
    { id: 'z', at: '2026-09-23T09:59:59.000Z', level: 'info' as const, cat: 'ui', text: '刷新前 0（更早）' },
  ]
  const server = [
    { id: 'a', at: '2026-09-23T10:00:02.000Z', level: 'info' as const, cat: 'ui', text: '刷新前 1' },
    { id: 's1', at: '2026-09-23T10:00:01.000Z', level: 'gate' as const, cat: 'blocked', text: '真实提交被拦：x' },
  ]
  const { items, stats } = mergeDiagEvents([
    { source: 'localStorage', events: storage },
    { source: 'client', events: client },
    { source: 'server', events: server },
  ])
  assert.deepEqual(
    { client: stats.client, localStorage: stats.localStorage, server: stats.server },
    { client: 2, localStorage: 2, server: 2 },
    '各来源条数要如实（去重前）',
  )
  assert.equal(stats.merged, 4, '去重后 4 条（a/b/z/s1）')
  assert.equal(stats.duplicates, 2, 'a 在两处重复 ⇒ 丢 2 条要计数')
  assert.deepEqual(items.map((e) => e.id), ['z', 's1', 'a', 'b'], '按 at 升序')
  // 同 id 以**先传入的来源**为准（调用方按 localStorage → client → server 传）
  assert.equal(items.find((e) => e.id === 'a')!.text, '刷新前 1')
  assert.equal(items.find((e) => e.id === 'a')!.source, 'localStorage')
  assert.equal(items.find((e) => e.id === 'b')!.source, 'client')
  assert.equal(items.find((e) => e.id === 's1')!.source, 'server')
})

test('三来源合并：没有 id 的老数据按"时间+文本"退化去重；超上限仍保留最早若干条', () => {
  const legacy = [
    { at: '2026-09-23T10:00:00.000Z', level: 'info' as const, cat: 'ui', text: '老数据' },
    { at: '2026-09-23T10:00:00.000Z', level: 'info' as const, cat: 'ui', text: '老数据' },
  ] as unknown as { id: string; at: string; level: 'info'; cat: string; text: string }[]
  const { items, stats } = mergeDiagEvents([{ source: 'client', events: legacy }])
  assert.equal(items.length, 1, '同时间同文本的重复老数据要被合成一条')
  assert.equal(stats.duplicates, 1)
  // 上限兜底（保留最早 DIAG_TIMELINE_HEAD_KEEP 条 + 最新若干条）
  const many = Array.from({ length: DIAG_TIMELINE_MAX + 50 }, (_, i) => ({
    id: `c${i}-a`,
    at: new Date(Date.UTC(2026, 8, 23, 10, 0, 0) + i * 1000).toISOString(),
    level: 'info' as const,
    cat: 'ui',
    text: `e${i}`,
  }))
  const capped = mergeDiagEvents([{ source: 'client', events: many }])
  assert.equal(capped.stats.merged, DIAG_TIMELINE_MAX, '合并结果要受全局上限约束')
  assert.equal(capped.items[0]!.id, 'c0-a', '最早那条要留下（"从哪一步开始不对"）')
})
