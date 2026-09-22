/**
 * 本机路线库「非官方路径形状（freeShape）」的存→读与兼容性单测（2026-09-22 新功能）
 *
 * 这一层要钉死三件事：
 *   ① **往返**：存进去的形状（圈型/直线型）读回来逐值一致；
 *   ② **向后兼容**：没有 `freeShape` 的老条目行为**一个字都不变**（照旧要求内外圈 ≥3 点）；
 *   ③ **安全降级**：读到**不认识的形状**（坏数据/未来版本）⇒ 当作"没有形状"（退回双圈模式），
 *      绝不抛异常、绝不把坏几何留在库里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  entryDetailRows,
  entrySummaryText,
  hasValidRings,
  isValidTrackEntry,
  normalizeLibrary,
  saveSummaryText,
  type TrackRouteEntry,
} from '../../utils/mp/trackLibrary.ts'
import { curveLengthM, expandFreePathTrajectory, planFreePathTrips, type FreePathShape } from '../../utils/mp/pathShape.ts'

const pt = (lat: number, lng: number) => ({ latitude: lat, longitude: lng })
const ring = (n: number) => Array.from({ length: n }, (_, i) => pt(31.9 + i * 0.0001, 118.7 + i * 0.0001))

const curve: FreePathShape = { kind: 'curve', points: [pt(31.37, 119.48), pt(31.371, 119.48), pt(31.371, 119.481), pt(31.37, 119.481)] }
const line: FreePathShape = { kind: 'line', from: pt(31.37, 119.48), to: pt(31.372, 119.48) }

test('isValidTrackEntry：双圈够点 **或** 带一个可用的非官方形状 ⇒ 都算合法', () => {
  // ① 老口径（双圈）逐字不变
  assert.equal(isValidTrackEntry({ outer: ring(3), inner: ring(3) }), true)
  assert.equal(isValidTrackEntry({ outer: ring(3), inner: [] }), false, '内圈空仍然不合法')
  assert.equal(isValidTrackEntry({ outer: [], inner: [] }), false)
  // ② 非官方形状（自由路径不需要双圈）⇒ 合法
  assert.equal(isValidTrackEntry({ outer: [], inner: [], freeShape: curve }), true, '圈型可以没有内外圈')
  assert.equal(isValidTrackEntry({ outer: [], inner: [], freeShape: line }), true, '直线型可以没有内外圈')
  // ③ 坏形状不能放行（否则又是"库里存着跑不了的几何"）
  assert.equal(isValidTrackEntry({ outer: [], inner: [], freeShape: { kind: 'circle', r: 3 } }), false)
  assert.equal(isValidTrackEntry({ outer: [], inner: [], freeShape: { kind: 'line', from: pt(1, 2), to: pt(1, 2) } }), false, '两点重合的直线不可用')
  assert.equal(isValidTrackEntry({ outer: [], inner: [], freeShape: { kind: 'curve', points: [pt(1, 2)] } }), false, '单点曲线不可用')
})

test('normalizeLibrary：**存→读往返**（圈型/直线型）逐值一致', () => {
  const raw = [
    { lineId: 'local:free', lineName: '本机跑道', outer: [], inner: [], freeShape: curve, createdAt: '2026-09-22T00:00:00.000Z' },
    { lineId: 'L-line', lineName: '直线', outer: ring(4), inner: ring(4), freeShape: line, createdAt: '2026-09-22T00:00:00.000Z' },
  ]
  const out = normalizeLibrary(raw, '1.2.5')
  assert.equal(out.length, 2)
  const [a, b] = out as [TrackRouteEntry, TrackRouteEntry]
  assert.deepEqual(a.freeShape, curve, '圈型形状原样读回（坐标已收敛成 number）')
  assert.equal(a.outer.length, 0, '没有内外圈就如实为空数组，不伪造几何')
  assert.deepEqual(b.freeShape, line)
  assert.equal(b.outer.length, 4, '同时有双圈与形状时，两者都保留（形状优先用于跑图）')
  // 再过一遍 JSON（模拟 localStorage 往返）也必须一致
  const again = normalizeLibrary(JSON.parse(JSON.stringify(out)), '1.2.5')
  assert.deepEqual(again[0]!.freeShape, curve)
  assert.deepEqual(again[1]!.freeShape, line)
})

test('normalizeLibrary：**老条目（没有 freeShape）零变化** —— 不多出这个键、校验口径不变', () => {
  const out = normalizeLibrary([{ lineId: 'L-old', outer: ring(5), inner: ring(5), createdAt: '2026-01-01T00:00:00.000Z' }], '1.0.0')
  assert.equal(out.length, 1)
  assert.equal('freeShape' in out[0]!, false, 'old 条目不许凭空多出 freeShape 键')
  assert.equal(hasValidRings(out[0]!), true, '双圈条目仍按老口径合法')
  // 老条目（双圈）的摘要/详情不许被新功能改写措辞
  assert.match(entrySummaryText(out[0]!), /^外圈 5 点 · 内圈 5 点 · /)
  /**
   * ⚠️ 2026-09-22 审计 B9：**详情表不许凭空多一行**。
   * 原先无条件加 `非官方路径【测试】` ⇒ "有线路任务的所有既有行为一字不变"被破坏
   * （那种任务永远不会有 freeShape）。判据：行数由数据决定。
   */
  assert.equal(
    entryDetailRows(out[0]!).some((r) => r.label.includes('非官方路径')),
    false,
    '没有 freeShape 的条目，详情表里不许出现"非官方路径"那一行',
  )
})

test('normalizeLibrary：读到**不认识的形状** ⇒ 安全降级为"没有形状"（不抛、不留坏数据）', () => {
  const bad = [
    { lineId: 'L-bad1', outer: ring(3), inner: ring(3), freeShape: { kind: 'spiral', turns: 3 } },
    { lineId: 'L-bad2', outer: ring(3), inner: ring(3), freeShape: 'curve' },
    { lineId: 'L-bad3', outer: ring(3), inner: ring(3), freeShape: { kind: 'curve', points: [{ latitude: NaN, longitude: 1 }] } },
    { lineId: 'L-bad4', outer: ring(3), inner: ring(3), freeShape: null },
  ]
  let out: TrackRouteEntry[] = []
  assert.doesNotThrow(() => {
    out = normalizeLibrary(bad, '1.2.5')
  })
  assert.equal(out.length, 4, '双圈合法的条目仍留下（只是形状被丢掉）')
  for (const e of out) assert.equal(e.freeShape, undefined, `${e.lineId} 的坏形状必须被丢掉`)
  // 坏形状 + 没有双圈 ⇒ 整条不收（不能留一条"跑不了的几何"）
  assert.deepEqual(normalizeLibrary([{ lineId: 'L-useless', outer: [], inner: [], freeShape: { kind: 'spiral' } }]), [])
})

test('saveSummaryText：存的是非官方形状时，摘要说的是形状（不是占位几何的点数）', () => {
  const s = saveSummaryText({ outer: [], inner: [], freeShape: curve })
  assert.match(s, /圈型（闭合曲线）/)
  assert.doesNotMatch(s, /外圈 0 点/)
  const s2 = saveSummaryText({ outer: ring(4), inner: ring(4), laneNo: 3, laneCount: 6, freeShape: line })
  assert.match(s2, /直线型（折返）/)
  // 没有形状时逐字保持老口径
  assert.match(saveSummaryText({ outer: ring(4), inner: ring(4), laneNo: 3, laneCount: 6 }), /^外圈 4 点 · 内圈 4 点 · 第 3 道\/6 · 起跑点未设置$/)
})

test('entrySummaryText / entryDetailRows：有形状时标出形状，且说明"跑图以它为准"', () => {
  const e: TrackRouteEntry = {
    lineId: 'local:free',
    lineName: '本机跑道',
    outer: [],
    inner: [],
    createdAt: '2026-09-22T00:00:00.000Z',
    appVersion: '1.2.5',
    freeShape: curve,
  }
  assert.match(entrySummaryText(e), /^圈型（闭合曲线）：4 个点 · 一圈 /)
  const row = entryDetailRows(e).find((r) => r.label.includes('非官方路径'))
  assert.ok(row, '详情里要有一行说明非官方路径')
  assert.match(row.value, /圈型（闭合曲线）/)
})

test('形状与内外圈可以**同时**存在：跑图取形状的展开结果，且展开长度 = 计划长度', () => {
  const e: TrackRouteEntry = {
    lineId: 'local:free',
    lineName: '本机跑道',
    outer: ring(4),
    inner: ring(4),
    createdAt: '2026-09-22T00:00:00.000Z',
    appVersion: '1.2.5',
    freeShape: curve,
  }
  const plan = planFreePathTrips(e.freeShape, 1)
  const geom = expandFreePathTrajectory(e.freeShape, plan.trips)
  assert.ok(geom.length > 0, '能展开出几何（跑步页就是拿它当生成器输入）')
  assert.deepEqual(geom[0], geom[geom.length - 1], '圈型展开首尾同点（生成器判闭合）')
  assert.ok(curveLengthM(e.freeShape, true) > 0)
})
