/**
 * 「进场段」单测（2026-10-30，1.3.3 需求：路线更真实）
 *
 * 需求原话（用户）：**"在进行圈跑之前，应该会有一段进场路线，也就是与跑道轨迹相切的一段小直线"**，
 * 并明确：**"用户自行设置这一小段"**（⇒ 不自动算切点，用户点哪就是哪）。
 *
 * 这一层钉住四件事（任何一条破都说明"进场段会毁掉轨迹"）：
 *   · **A 正常拼**：返回 `[进场点, 起跑点, 起跑点后…]`，长度 = 原车道线 + 1，进场段米数 = 两点直线距离；
 *   · **B 边界拒绝**：太短（< 3 m）/ 太长（> 120 m）**一律不拼**，且**必须返回人话原因**（不许静默）；
 *   · **C 没设进场点**：原样返回、`skipped` 为空（这是正常情况，不能报"跳过"）；
 *   · **D 车道线不合格**：不足 3 点时原样返回并报原因（绝不许产出一条退化几何）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENTRY_MAX_M,
  ENTRY_MIN_M,
  prependEntrySegment,
  type TrackEntry,
} from '../../utils/mp/pathShape.ts'
import { distanceMeters } from '../../utils/mp/routeSimilarity.ts'

/** 一个边长约 100 m 的方形"跑道"（首点 = 起跑点，闭合几何末尾不重复） */
const SQUARE = [
  { latitude: 32.0, longitude: 118.0 },
  { latitude: 32.0, longitude: 118.00108 },
  { latitude: 32.0009, longitude: 118.00108 },
  { latitude: 32.0009, longitude: 118.0 },
]

/** 起跑点正北方向 offsetM 米处的点（用于构造"离起跑点多远"的进场点） */
const northOf = (offsetM: number) => ({ latitude: 32.0 + offsetM / 111320, longitude: 118.0 })

test('进场段 A：正常拼在原几何前面，起点是进场点、第二点是起跑点', () => {
  const entry: TrackEntry = { point: northOf(25) }
  const r = prependEntrySegment(SQUARE, entry)

  assert.equal(r.skipped, '', '合法进场点不该被跳过')
  assert.equal(r.points.length, SQUARE.length + 1, '恰好多一个点（进场点）')
  assert.equal(r.points[0]!.latitude, entry.point.latitude, '第 0 点 = 进场点')
  assert.equal(r.points[1]!.latitude, SQUARE[0]!.latitude, '第 1 点 = 起跑点（车道线原第 0 点）')

  const measured = distanceMeters(
    Number(r.points[0]!.latitude),
    Number(r.points[0]!.longitude),
    Number(r.points[1]!.latitude),
    Number(r.points[1]!.longitude),
  )
  assert.ok(Math.abs(r.entryM - measured) < 0.01, `entryM(${r.entryM}) 应等于实际两点距离(${measured})`)
  assert.ok(Math.abs(r.entryM - 25) < 1, `25 m 的进场点应算出约 25 m，实际 ${r.entryM}`)
})

test('进场段 B：太短 / 太长一律不拼，且必须给出人话原因', () => {
  const tooShort = prependEntrySegment(SQUARE, { point: northOf(ENTRY_MIN_M / 3) })
  assert.equal(tooShort.points.length, SQUARE.length, '太短不得改变几何')
  assert.notEqual(tooShort.skipped, '', '太短必须报原因（不许静默）')
  assert.match(tooShort.skipped, /不足/)

  const tooLong = prependEntrySegment(SQUARE, { point: northOf(ENTRY_MAX_M + 50) })
  assert.equal(tooLong.points.length, SQUARE.length, '太长不得改变几何')
  assert.notEqual(tooLong.skipped, '', '太长必须报原因')
  assert.match(tooLong.skipped, /超过上限/)
})

test('进场段 C：没设进场点 ⇒ 原样返回，且 skipped 为空（这是正常情况）', () => {
  for (const e of [null, undefined]) {
    const r = prependEntrySegment(SQUARE, e)
    assert.equal(r.skipped, '', '没设进场点不是"跳过"，不该报原因')
    assert.equal(r.points.length, SQUARE.length)
    assert.equal(r.entryM, 0)
  }
})

test('进场段 D：车道线不足 3 点 ⇒ 原样返回并报原因（绝不产出退化几何）', () => {
  const r = prependEntrySegment(
    [
      { latitude: 32.0, longitude: 118.0 },
      { latitude: 32.0009, longitude: 118.0 },
    ],
    { point: northOf(25) },
  )
  assert.equal(r.points.length, 2, '不合法车道线不得被改动')
  assert.match(r.skipped, /车道线不足/)
})

test('进场段 E：进场点坐标是脏数据（NaN/空）⇒ 视同未设置，不崩', () => {
  const r = prependEntrySegment(SQUARE, { point: { latitude: Number.NaN, longitude: 118 } })
  assert.equal(r.skipped, '')
  assert.equal(r.points.length, SQUARE.length)
})

test('进场段 F：拼好后仍是一条连续路径（相邻点不重复、不跳变）', () => {
  const r = prependEntrySegment(SQUARE, { point: northOf(20) })
  for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1]!
    const b = r.points[i]!
    const d = distanceMeters(Number(a.latitude), Number(a.longitude), Number(b.latitude), Number(b.longitude))
    assert.ok(d > 0, `第 ${i} 段长度为 0（相邻重复点）`)
    assert.ok(d < 200, `第 ${i} 段长度 ${d.toFixed(1)} m 异常（疑似跳变）`)
  }
})
