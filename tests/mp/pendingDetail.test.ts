/**
 * 「待补交的轨迹明细」单测（2026-10-07 实测事故）
 *
 * 事故：`sunRunExercises` 提交成功（耗时 13.8 s），紧随其后的 `sunRunExercisesDetail`
 * **一个请求都没发** —— 切标签页后 Edge 冻结/丢弃页面，成绩响应刚回来、还没走到"发明细"就没了 JS 上下文
 * ⇒ 云端**成绩有效但没轨迹**（E33 同族）。欠账现在在"成绩成功"那一刻落盘（含轨迹点本体）。
 * 这里钉住：解析必须耐操（坏数据一律 null）、点列必须拒绝畸形/超量、文案必须带场次号且不含 markdown。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PENDING_DETAIL_KEY,
  PENDING_DETAIL_MAX_POINTS,
  normalizePendingPoints,
  parsePendingDetail,
  pendingDetailProgressNote,
  pendingDetailSummary,
  pendingDetailUsedTime,
  serializePendingDetail,
  type PendingDetail,
} from '../../utils/mp/pendingDetail.ts'

const sample = (over: Partial<PendingDetail> = {}): PendingDetail => ({
  scantronId: 'sunrunId202610072508',
  taskId: 'sunrunTaskPaper-20210917000004',
  lineId: 'sunrunLine-20210918000002',
  runType: 0,
  km: 3.3,
  durationSeconds: 1172,
  startMs: Date.UTC(2026, 9, 7, 12, 21, 38),
  endMs: Date.UTC(2026, 9, 7, 12, 53, 27),
  points: [
    { latitude: 31.9, longitude: 118.78 },
    { latitude: 31.9001, longitude: 118.7801 },
  ],
  at: Date.UTC(2026, 9, 7, 12, 53, 41),
  attempts: 0,
  lastError: '',
  ...over,
})

test('落盘键名是契约（改名等于让"重启后还能补交"失效）', () => {
  assert.equal(PENDING_DETAIL_KEY, 'mp_pending_detail')
})

test('解析：正常往返逐值一致', () => {
  const d = sample()
  assert.deepEqual(parsePendingDetail(serializePendingDetail(d)), d)
})

test('解析：坏数据一律 null（绝不抛、也绝不半信半疑地收下）', () => {
  const bad = [
    '',
    null,
    undefined,
    '{',
    'null',
    '[]',
    '"abc"',
    '123',
    '{}',
    JSON.stringify({ ...sample(), scantronId: '' }), // 没有场次号 ⇒ 没法补
    JSON.stringify({ ...sample(), points: [] }), // 没有点 ⇒ 补不了
    JSON.stringify({ ...sample(), points: [{ latitude: 'x', longitude: 1 }] }),
    JSON.stringify({ ...sample(), km: 0 }),
    JSON.stringify({ ...sample(), durationSeconds: 0 }),
    JSON.stringify({ ...sample(), startMs: 'x' }),
  ]
  for (const raw of bad) {
    assert.equal(parsePendingDetail(raw), null, `应当 null：${String(raw).slice(0, 60)}`)
  }
})

test('解析：缺可选项时给安全默认（endMs 由 start+duration 推出，attempts/lastError 归零）', () => {
  const parsed = parsePendingDetail(
    JSON.stringify({
      scantronId: 's1',
      km: 3,
      durationSeconds: 100,
      startMs: 1000,
      points: [{ latitude: 1, longitude: 2 }],
    }),
  )
  assert.ok(parsed)
  assert.equal(parsed!.endMs, 1000 + 100 * 1000)
  assert.equal(parsed!.attempts, 0)
  assert.equal(parsed!.lastError, '')
  assert.equal(parsed!.taskId, '')
  assert.equal(parsed!.runType, 0)
})

test('点列归一化：拒绝空/超量/非有限数（保护 localStorage，宁可不存）', () => {
  assert.equal(normalizePendingPoints(null), null)
  assert.equal(normalizePendingPoints([]), null)
  assert.equal(normalizePendingPoints([{ latitude: 1, longitude: 2 }])?.length, 1)
  assert.equal(normalizePendingPoints([{ latitude: NaN, longitude: 2 }]), null)
  assert.equal(normalizePendingPoints([{ latitude: 1, longitude: Infinity }]), null)
  assert.equal(normalizePendingPoints(['x']), null)
  const tooMany = Array.from({ length: PENDING_DETAIL_MAX_POINTS + 1 }, () => ({ latitude: 1, longitude: 2 }))
  assert.equal(normalizePendingPoints(tooMany), null, '超过上限必须拒绝')
})

test('时长文案：与报文口径一致（HH:mm:ss）', () => {
  assert.equal(pendingDetailUsedTime(sample({ durationSeconds: 1172 })), '00:19:32')
  assert.equal(pendingDetailUsedTime(sample({ durationSeconds: 3661 })), '01:01:01')
})

test('人话摘要：必须带场次号与里程，且不含 markdown 标记', () => {
  const text = pendingDetailSummary(sample())
  assert.ok(text.includes('sunrunId202610072508'), '场次号是关键（补交就靠它）')
  assert.ok(text.includes('3.30 km'))
  assert.ok(text.includes('00:19:32'))
  assert.ok(text.includes('只在你点的时候发一次'), '必须说清"不会自动重试"')
  assert.ok(!/\*\*|`|^#/m.test(text), '用户可见文案不得含 markdown 标记')
})

test('人话摘要：补交过就如实说"已补交 N 次"与上次失败原因（不假装没试过）', () => {
  const text = pendingDetailSummary(sample({ attempts: 2, lastError: '轨迹提交失败' }))
  assert.ok(text.includes('已补交 2 次'))
  assert.ok(text.includes('轨迹提交失败'))
})

test('清单文案：短、带场次号、不含 markdown', () => {
  const line = pendingDetailProgressNote(sample())
  assert.ok(line.includes('sunrunId202610072508'))
  assert.ok(line.length < 120, `清单里那一步要短（实际 ${line.length} 字）`)
  assert.ok(!/\*\*|`/.test(line))
})
