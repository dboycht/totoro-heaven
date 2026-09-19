/**
 * 路线库「内外圈合法性」测试（2026-09-19 审计 S1 的回归钉子）
 *
 * 病因回顾：`isPts([])` 对空数组恒真（`every` 在空数组上返回 true）⇒
 *   · `normalizeLibrary` 把 `{lineId, outer: [], inner: []}` 原样收下；
 *   · 界面「保存（本机）」在内外圈不足 3 点时判据失效（`ringCheck` 为 null 让
 *     `Boolean(ringCheck && !ringCheck.ok)` 变 false）⇒ 可保存；
 *   · 之后跑步页把它当"已描过跑道"，而生成器因点数不足**回落到官方模板**（本版禁止）。
 *
 * 判据（可执行）：**内外圈各须 ≥3 点**，否则一律不收（normalize 丢、upsert 拒）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_RING_POINTS, hasValidRings, normalizeLibrary } from '../../utils/mp/trackLibrary.ts'

const pt = (lat, lng) => ({ latitude: lat, longitude: lng })
const ring = (n) => Array.from({ length: n }, (_, i) => pt(31.9 + i * 0.0001, 118.7 + i * 0.0001))

test('trackLibrary：hasValidRings —— 空数组/点数不足一律不合法', () => {
  assert.equal(MIN_RING_POINTS, 3)
  assert.equal(hasValidRings({ outer: [], inner: [] }), false, '空圈必须不合法（isPts([]) 曾恒真）')
  assert.equal(hasValidRings({ outer: ring(3), inner: [] }), false, '内圈空必须不合法')
  assert.equal(hasValidRings({ outer: [], inner: ring(3) }), false, '外圈空必须不合法')
  assert.equal(hasValidRings({ outer: ring(2), inner: ring(3) }), false, '2 点不足成环')
  assert.equal(hasValidRings({ outer: ring(3), inner: ring(2) }), false)
  assert.equal(hasValidRings({ outer: ring(3), inner: ring(3) }), true, '各 3 点是最低下限')
  assert.equal(hasValidRings({ outer: ring(40), inner: ring(40) }), true)
  // 形状对但元素是垃圾 ⇒ 不合法
  assert.equal(hasValidRings({ outer: [{ a: 1 }, { b: 2 }, { c: 3 }], inner: ring(3) }), false)
  assert.equal(hasValidRings({ outer: null, inner: ring(3) }), false)
  assert.equal(hasValidRings({}), false)
})

test('trackLibrary：normalizeLibrary **不再收下空圈**（S1 的入库层防御）', () => {
  const raw = [
    { lineId: 'L-empty', outer: [], inner: [], createdAt: '2026-09-19T00:00:00.000Z', appVersion: '1.1.11' },
    { lineId: 'L-partial', outer: ring(5), inner: [], appVersion: '1.1.11' },
    { lineId: 'L-good', outer: ring(6), inner: ring(6), appVersion: '1.1.11' },
  ]
  const out = normalizeLibrary(raw, '1.1.11')
  assert.deepEqual(
    out.map((e) => e.lineId),
    ['L-good'],
    '只有内外圈都够点的条目才该留下',
  )
})

test('trackLibrary：normalizeLibrary 对垃圾输入不崩（null/字符串/对象映射）', () => {
  assert.deepEqual(normalizeLibrary(null), [])
  assert.deepEqual(normalizeLibrary('nonsense'), [])
  assert.deepEqual(normalizeLibrary([null, 1, 'x']), [])
  // 旧格式（对象映射）走同一条校验
  const legacy = { 'L-empty': { outer: [], inner: [] }, 'L-ok': { outer: ring(3), inner: ring(3) } }
  assert.deepEqual(
    normalizeLibrary(legacy, '1.0.0').map((e) => e.lineId),
    ['L-ok'],
  )
})
