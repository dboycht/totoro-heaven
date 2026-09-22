/**
 * 日志纯逻辑测试：**脱敏是硬约束**（绝不能把 token/学号/姓名写进日志）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOG_RING_MAX,
  countByLevel,
  entriesToText,
  formatEntryLine,
  maskSensitive,
  maskTokenLike,
  pushRing,
  redactObject,
  redactValue,
  summarizeUpstream,
  truncate,
} from '../../utils/mp/logFormat.ts'

const TOKEN = `WXXCX${'A'.repeat(96)}` // 101 字符，形似真实 token

test('maskTokenLike：把形似 token 的片段替换为长度标记，不留原文', () => {
  const out = maskTokenLike(`Authorization: Bearer ${TOKEN}`)
  assert.equal(out.includes('WXXCX'), false, '绝不能残留 token 前缀')
  assert.equal(out.includes(TOKEN), false)
  assert.ok(out.includes(`[token len=${TOKEN.length}]`))
  // 短串不受影响
  assert.equal(maskTokenLike('WXXCXshort'), 'WXXCXshort')
  assert.equal(maskTokenLike('普通文本 3.2km'), '普通文本 3.2km')
})

test('redactObject：按字段名掩码 token/学号/姓名，普通字段保留', () => {
  const out = redactObject({
    token: TOKEN,
    snCode: '032530213',
    studentName: '张三',
    km: '3.30',
    usedTime: '00:19:18',
    runType: 0,
    list: [TOKEN, 'x'],
  }) as Record<string, unknown>
  assert.equal(String(out.token).startsWith('[masked'), true)
  assert.equal(String(out.snCode).startsWith('[masked'), true)
  assert.equal(String(out.studentName).startsWith('[masked'), true)
  assert.equal(out.km, '3.30', '非敏感字段应原样保留')
  assert.equal(out.usedTime, '00:19:18')
  assert.equal(out.runType, 0)
  assert.equal(String((out.list as unknown[])[0]).includes('WXXCX'), false, '数组元素也要掩')
  assert.equal(JSON.stringify(out).includes('张三'), false)
  assert.equal(JSON.stringify(out).includes('032530213'), false)
})

test('redactValue：按 key 掩码 + 嵌套对象递归 + 深度保护', () => {
  assert.equal(maskSensitive('abc'), '[masked len=3]')
  assert.equal(maskSensitive(null), 'null')
  const nested = redactValue('', { a: { b: { token: TOKEN, keep: 1 } } }) as Record<string, Record<string, Record<string, unknown>>>
  assert.equal(String(nested.a.b.token).startsWith('[masked'), true)
  assert.equal(nested.a.b.keep, 1)
  /**
   * 深度保护：默认上限 2026-09-22 从 4 放宽到 **8**（`getSunRunSchoolList` 的 `body[0].schoolName`
   * 在第 4 层，默认 4 会把它变成 `[deep]` ⇒ 「全记录」只剩键名）。这里同时钉住两件事：
   *   · 8 层以内**不**降级；超过 8 层仍然 `[deep]`（保护没被取消）；
   *   · 显式传更小上限时旧行为仍在（可回退）。
   */
  const deep8 = redactValue('', { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }) as Record<string, unknown>
  assert.ok(!JSON.stringify(deep8).includes('[deep]'), '8 层以内不得降级（否则内容会被整段丢掉）')
  const deep12 = redactValue('', { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } }) as Record<string, unknown>
  assert.ok(JSON.stringify(deep12).includes('[deep]'), '超过上限仍要保护（不是取消限制）')
  const shallowCap = redactValue('', { a: { b: { c: { d: { e: 1 } } } } }, 0, [], 2) as Record<string, unknown>
  assert.ok(JSON.stringify(shallowCap).includes('[deep]'), '显式传更小上限时，旧行为仍可用')
})

test('summarizeUpstream：只取状态类字段（status/code/msg/header.bizCode）', () => {
  const s = summarizeUpstream({ status: '01', code: '1', msg: 'token失效，注册失败', body: { secret: 1 }, header: { bizCode: -199 } })
  assert.deepEqual(s, { status: '01', code: '1', msg: 'token失效，注册失败', bizCode: -199 })
  assert.equal(JSON.stringify(s).includes('secret'), false)
  assert.deepEqual(summarizeUpstream(null), { kind: 'object' })
  assert.deepEqual(summarizeUpstream('text'), { kind: 'string' })
})

test('pushRing：超过上限丢最旧，保留最近 N 条', () => {
  let arr: number[] = []
  for (let i = 0; i < LOG_RING_MAX + 10; i++) arr = pushRing(arr, i)
  assert.equal(arr.length, LOG_RING_MAX)
  assert.equal(arr[arr.length - 1], LOG_RING_MAX + 9)
  assert.equal(arr[0], 10, '最旧的 0~9 应被丢弃')
})

test('formatEntryLine / entriesToText：一行一条，含等级与类别；空给提示', () => {
  const e = { t: '2026-09-15T12:00:00.000Z', level: 'warn' as const, cat: 'gate', msg: '门禁拦住', data: { blockedBy: 'camera_on' } }
  const line = formatEntryLine(e)
  assert.ok(line.includes('[WARN ]'))
  assert.ok(line.includes('[gate]'))
  assert.ok(line.includes('camera_on'))
  assert.equal(line.includes('\n'), false, '单条必须是一行')
  assert.equal(entriesToText([]), '（暂无日志）')
  assert.equal(entriesToText([e]).split('\n').length, 1)
})

test('countByLevel：统计各等级条数', () => {
  const c = countByLevel([
    { t: '', level: 'info', cat: 'x', msg: '' },
    { t: '', level: 'error', cat: 'x', msg: '' },
    { t: '', level: 'error', cat: 'x', msg: '' },
  ])
  assert.deepEqual(c, { info: 1, warn: 0, error: 2 })
})

test('truncate：超长截断并标注原长度', () => {
  assert.equal(truncate('abc', 10), 'abc')
  const out = truncate('x'.repeat(100), 10)
  assert.ok(out.startsWith('x'.repeat(10)))
  assert.ok(out.includes('共 100 字符'))
})
