/**
 * 「非官方路径保存报文」的单测（2026-09-22，审计 B1 的回归钉子）
 *
 * 抓到的真 bug：保存形状时**没传 `start`**，而 `upsert` 的口径是「`undefined` = 沿用旧值」⇒
 * 「跑道编辑」里按**旧几何**设过的起跑点 `offsetM` 会被**悄悄沿用到新形状**上
 * （`applyStartToLoopKeepingVertices` 只按模绕回、不报错 ⇒ 用户以为起点还在原处）。
 *
 * 判据（可执行）：
 *   · 形状保存报文里 `start` 必须是**显式的 `null`**（`'start' in payload` 且 `payload.start === null`）；
 *   · 按 `useTrackLibrary.upsert` 的同一口径（`undefined ⇒ 沿用旧值`）合并后，**结果里不许再有 start**；
 *   · 占位几何 ≥3 点（审计 B3）、且**不传** `laneNo`/`laneCount`（那是跑道编辑页的事）；
 *   · 形状不可用 ⇒ `null`（调用方如实报"还存不了"），绝不产出坏报文。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFreeShapeSave, startClearedNote } from '../../utils/mp/freePathSave.ts'

const pt = (latitude: number, longitude: number) => ({ latitude, longitude })
const curve = (n = 4) => ({
  kind: 'curve' as const,
  points: Array.from({ length: n }, (_, i) => pt(31.37 + i * 0.0004, 119.48 + i * 0.0004)),
})
const line = { kind: 'line' as const, from: pt(31.37, 119.48), to: pt(31.372, 119.482) }

/** `composables/useTrackLibrary.ts` 的 `upsert` 对 start 的合并口径（**照抄一行**，用于回归断言） */
const mergeStart = (input: { start?: unknown }, old?: { start?: { offsetM: number } }) =>
  input.start === undefined ? old?.start : ((input.start ?? undefined) as { offsetM: number } | undefined)

test('⭐ B1：保存形状的报文里 `start` 必须是**显式 null**（不许"不传" ⇒ 沿用旧起跑点）', () => {
  for (const shape of [curve(), line]) {
    const payload = buildFreeShapeSave({ shape, lineId: 'local:free', lineName: '本机跑道（本任务未下发线路）' })
    assert.ok(payload, '可用形状必须构造出报文')
    assert.equal('start' in payload, true, '必须**显式带上** start 字段')
    assert.equal(payload.start, null, 'start 必须是 null（明确清掉）')
    assert.equal(payload.freeShape, shape, '形状原样带上（跑图以它为准）')
    assert.equal(payload.lineId, 'local:free')
  }
})

test('⭐ B1：按 upsert 的口径合并后，**旧的 offsetM 不许留下来**（同一形状改点也同理）', () => {
  const old = { start: { offsetM: 772 } }
  const before = buildFreeShapeSave({ shape: curve(4), lineId: 'local:free', lineName: 'x' })!
  assert.equal(mergeStart(before, old), undefined, '带 start:null 的报文合并后不能再有旧起跑点')

  /** 反例（把病根钉住）：**不传** start 时，旧值会原样留下 —— 这正是当时那个 bug */
  const buggy = { ...before } as Record<string, unknown>
  delete buggy.start
  assert.deepEqual(mergeStart(buggy, old), old.start, '不传 start ⇒ upsert 沿用旧值（bug 的成因，必须被上面那条挡住）')

  /** 改点后的新形状同样必须清掉（形状变了，旧 offsetM 是按旧几何量的） */
  const changed = { kind: 'curve' as const, points: [pt(31.4, 119.5), pt(31.402, 119.502), pt(31.404, 119.5)] }
  const after = buildFreeShapeSave({ shape: changed, lineId: 'local:free', lineName: 'x' })!
  assert.equal(mergeStart(after, old), undefined)
})

test('B3：占位几何各 ≥3 点、且一律 number 坐标；直线型是 A/中点/B', () => {
  const curvePayload = buildFreeShapeSave({ shape: curve(4), lineId: 'local:free', lineName: 'x' })!
  assert.ok(curvePayload.outer.length >= 3 && curvePayload.inner.length >= 3, `outer=${curvePayload.outer.length} inner=${curvePayload.inner.length}`)
  for (const p of [...curvePayload.outer, ...curvePayload.inner]) {
    assert.equal(typeof p.latitude, 'number')
    assert.equal(typeof p.longitude, 'number')
  }
  const linePayload = buildFreeShapeSave({ shape: line, lineId: 'local:free', lineName: 'x' })!
  assert.equal(linePayload.outer.length, 3, '直线型占位 = A / 中点 / B')
  assert.deepEqual(linePayload.outer[1], { latitude: (31.37 + 31.372) / 2, longitude: (119.48 + 119.482) / 2 })
  assert.notEqual(linePayload.outer, linePayload.inner, 'outer / inner 必须是两份数组（避免调用方就地改到另一份）')
})

test('不传 laneNo / laneCount（那是「跑道编辑」双圈的事，本页不碰）', () => {
  const payload = buildFreeShapeSave({ shape: curve(), lineId: 'local:free', lineName: 'x' })!
  assert.equal('laneNo' in payload, false)
  assert.equal('laneCount' in payload, false)
})

test('形状不可用 ⇒ null（调用方如实报"还存不了"），绝不产出坏报文', () => {
  for (const bad of [null, undefined, { kind: 'curve', points: [pt(31.37, 119.48)] }, { kind: 'line', from: pt(31.37, 119.48), to: pt(31.37, 119.48) }]) {
    assert.equal(buildFreeShapeSave({ shape: bad as never, lineId: 'local:free', lineName: 'x' }), null, JSON.stringify(bad))
  }
})

test('startClearedNote：真的清掉了才说（没有起跑点时不编一句话）', () => {
  assert.equal(startClearedNote(false), '')
  const note = startClearedNote(true)
  assert.match(note, /原先的起跑点已清除/)
  assert.equal(note.includes('**'), false, '用户可见文案不许出现成对星号')
  assert.equal(note.includes('`'), false, '用户可见文案不许出现反引号')
})
