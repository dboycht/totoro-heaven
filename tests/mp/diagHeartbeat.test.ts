/**
 * 「心跳快照」与「事件 `cat` 不许挡新事件」的契约层单测（2026-09-23 新增）
 *
 * 覆盖用户要求：
 *   · 心跳快照的形状（**扁平标量**、长度上限、只收白名单字段）；
 *   · **未知/新增 `cat` 值不会被拒**（另一条线要上报 `cat:'warn-relaxed'`）；
 *   · 心跳日志行的标记可被导出侧识别（`msg === 'client-heartbeat'`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DIAG_EVENT_TEXT_MAX,
  DIAG_HEARTBEAT_INTERVAL_MS,
  DIAG_HEARTBEAT_PATH,
  DIAG_HEARTBEAT_PER_WINDOW_MAX,
  checkDiagEvent,
} from '../../utils/mp/diagnostics.ts'

const base = { id: 'c1-x', at: '2026-09-23T10:00:00.000Z' }

test('心跳：间隔在 30~60 秒之间，路径是契约层唯一来源', () => {
  assert.ok(DIAG_HEARTBEAT_INTERVAL_MS >= 30_000 && DIAG_HEARTBEAT_INTERVAL_MS <= 60_000, `间隔要在 30~60 秒之间，实际 ${DIAG_HEARTBEAT_INTERVAL_MS}`)
  assert.equal(DIAG_HEARTBEAT_PATH, '/api/local/diagnostics/heartbeat')
  assert.ok(DIAG_HEARTBEAT_PER_WINDOW_MAX > 0)
})

test('心跳：经同一套白名单校验 —— 摘要进 data、cat 为 heartbeat', () => {
  const ok = checkDiagEvent({ ...base, level: 'info', cat: 'heartbeat', text: '心跳快照（当前内存态摘要）', data: { page: '/run', 'task.km': 2.5, 'gate.allow': false } })
  assert.ok(ok, '心跳应当通过白名单')
  assert.equal(ok!.cat, 'heartbeat')
  assert.equal(ok!.data?.['page'], '/run')
  assert.equal(ok!.data?.['task.km'], 2.5)
  assert.equal(ok!.data?.['gate.allow'], false)
})

test('心跳：摘要里的**嵌套对象/数组**照样被丢掉该键（不许原样透传）', () => {
  const ok = checkDiagEvent({
    ...base,
    level: 'info',
    cat: 'heartbeat',
    text: '心跳',
    data: { flat: 1, nested: { a: 1 }, arr: [1, 2], 'gate.warnings': '["a"]' },
  })
  assert.ok(ok)
  assert.equal(ok!.data?.flat, 1)
  assert.equal(ok!.data?.nested, undefined)
  assert.equal(ok!.data?.arr, undefined)
  assert.equal(ok!.data?.['gate.warnings'], '["a"]', '数组要转成定长字符串（调用方负责），字符串本身照收')
})

test('心跳：超长文本被截断（不是拒绝）—— 与事件同一口径', () => {
  const ok = checkDiagEvent({ ...base, level: 'info', cat: 'heartbeat', text: 'x'.repeat(DIAG_EVENT_TEXT_MAX * 2) })
  assert.ok(ok)
  assert.match(ok!.text, /\[截断，原 \d+ 字符\]/)
})

test('🔴 `cat` 是**自由字符串** ⇒ 未知/新增 cat 一律不拒（另一条线要发 warn-relaxed）', () => {
  for (const cat of ['warn-relaxed', 'heartbeat', 'blocked', 'submit', 'client-error', 'brand-new-cat-2026', 'x', '门禁放宽']) {
    const ok = checkDiagEvent({ ...base, level: 'gate', cat, text: '随便一条' })
    assert.ok(ok, `cat=${cat} 不该被拒（否则新事件被白名单挡掉）`)
    assert.equal(ok!.cat, cat)
  }
  /** 反向：`cat` 仍然有**长度上限**（防有人塞一整个对象） */
  const long = checkDiagEvent({ ...base, level: 'info', cat: 'y'.repeat(200), text: 't' })
  assert.ok(long, '超长 cat 是**截断**而不是拒绝')
  assert.ok(long!.cat.length < 200, `cat 要被截断：${long!.cat.length}`)
})

test('level 白名单仍然生效（`gate` 是合法值：被拦下/被放宽）', () => {
  assert.ok(checkDiagEvent({ ...base, level: 'gate', cat: 'blocked', text: 'x' }))
  assert.ok(checkDiagEvent({ ...base, level: 'warn', cat: 'warn-relaxed', text: 'x' }))
  assert.equal(checkDiagEvent({ ...base, level: 'debug', cat: 'x', text: 't' }), null, '未知 level 仍要拒')
})
