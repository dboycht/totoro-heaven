/**
 * 起跑点 / 绕向 的几何测试（2026-09-20，1.1.12 需求②）
 *
 * 夹具与 `trackEditor.test.ts` 同源：以 (31.37, 119.48) 为圆心的**正圆**。
 * 正圆的好处：① 周长有解析解（2πr），弧长偏移可以精确验证；
 * ② 绕向已知（`circle()` 生成的是**逆时针**），顺/逆时针文案可以断言。
 *
 * ⭐ 本文件最重要的一条是"**未设起跑点必须与旧行为逐点一致**"（回归保证）：
 *    生成器永远从数组第 0 点起跑，所以我们用"旋转 + 反向"实现起跑点 ——
 *    一旦 `rotateLoop(loop, 0)` 不再返回原序列，所有老用户的轨迹都会悄悄变形。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyStartToLoop,
  pointAtArcM,
  ringLengthM,
  ringOrientation,
  rotateLoop,
  snapToLoop,
  startDirectionLabel,
} from '../../utils/mp/trackEditor.ts'
import { distanceMeters } from '../../utils/mp/routeSimilarity.ts'

const CENTER = { latitude: 31.37, longitude: 119.48 }
const mLat = 111320
const mLng = 111320 * Math.cos((CENTER.latitude * Math.PI) / 180)

/** 造一个半径 r 米的圆（n 个点）—— 与 trackEditor.test.ts 同一份夹具 */
const circle = (r: number, n = 120) =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return {
      latitude: CENTER.latitude + (r * Math.sin(a)) / mLat,
      longitude: CENTER.longitude + (r * Math.cos(a)) / mLng,
    }
  })

/** 点相对圆心的半径（米） */
const radiusOf = (p: { latitude: number | string; longitude: number | string }) =>
  Math.hypot((Number(p.latitude) - CENTER.latitude) * mLat, (Number(p.longitude) - CENTER.longitude) * mLng)

/** 两点距离（米） */
const dist = (a: { latitude: number | string; longitude: number | string }, b: { latitude: number | string; longitude: number | string }) =>
  distanceMeters(Number(a.latitude), Number(a.longitude), Number(b.latitude), Number(b.longitude))

const r = 100
const loop = circle(r, 120)
const total = ringLengthM(loop)

test('ringOrientation：正圆夹具是逆时针；反向数组是顺时针；点数不足为 unknown', () => {
  assert.equal(ringOrientation(loop), 'ccw')
  assert.equal(ringOrientation([...loop].reverse()), 'cw')
  assert.equal(ringOrientation(loop.slice(0, 2)), 'unknown')
  assert.equal(ringOrientation([]), 'unknown')
})

test('pointAtArcM：0 = 第 0 点；1/4 周长 = 圆上 90 度处；超周长自动取模', () => {
  const p0 = pointAtArcM(loop, 0)!
  assert.ok(dist(p0, loop[0]!) < 0.5, '弧长 0 必须就是第 0 个点')

  const quarter = pointAtArcM(loop, total / 4)!
  // 仍在圆上
  assert.ok(Math.abs(radiusOf(quarter) - r) < 1, `半径 ${radiusOf(quarter).toFixed(1)} 应≈${r}`)
  // 与第 0 点的弦长 = 2r·sin(45°) ≈ 141.4 m
  assert.ok(Math.abs(dist(p0, quarter) - 2 * r * Math.sin(Math.PI / 4)) < 2)

  // 取模：跑满一圈回到原点；负偏移等价于"倒着走"
  assert.ok(dist(pointAtArcM(loop, total)!, p0) < 0.5)
  assert.ok(dist(pointAtArcM(loop, -total / 4)!, pointAtArcM(loop, (total * 3) / 4)!) < 1)
  // 点数不足 ⇒ null（调用方据此不画起跑点）
  assert.equal(pointAtArcM(loop.slice(0, 1), 10), null)
})

test('⭐ rotateLoop(loop, 0) 必须原样返回（未设起跑点 = 与旧版逐点一致）', () => {
  const same = rotateLoop(loop, 0)
  assert.equal(same.length, loop.length)
  assert.deepEqual(same, loop)
  // 负数/NaN 同样视为"不旋转"
  assert.deepEqual(rotateLoop(loop, -5), loop)
  assert.deepEqual(rotateLoop(loop, Number.NaN), loop)
})

test('rotateLoop：按弧长旋转后，第 0 点落在偏移处、点数与周长都不变', () => {
  const off = total / 4
  const rotated = rotateLoop(loop, off)
  assert.equal(rotated.length, loop.length)
  assert.ok(dist(rotated[0]!, pointAtArcM(loop, off)!) < 0.6, '旋转后第 0 点应落到偏移处')
  // 周长不变（同一条几何，只是起点换了）
  assert.ok(Math.abs(ringLengthM(rotated) - total) < 1)
  // 偏移超过一圈自动取模
  const wrapped = rotateLoop(loop, total + off)
  assert.ok(dist(wrapped[0]!, rotated[0]!) < 0.6)
  // 几何退化（点数不足）⇒ 原样返回
  assert.deepEqual(rotateLoop(loop.slice(0, 2), 50).length, 2)
})

test('applyStartToLoop：未设置 = 原样；reverse = 起点仍在第 0 位、其余倒序', () => {
  // ① 未设置（undefined / null / 偏移 0 且不反向）→ 逐点一致
  assert.deepEqual(applyStartToLoop(loop, undefined), loop)
  assert.deepEqual(applyStartToLoop(loop, null), loop)
  assert.deepEqual(applyStartToLoop(loop, { offsetM: 0, direction: 'forward' }), loop)

  // ② 反向：第 0 点保留，其余倒序 —— 即"从同一点朝相反方向跑"
  const rev = applyStartToLoop(loop, { offsetM: 0, direction: 'reverse' })
  assert.equal(rev.length, loop.length)
  assert.ok(dist(rev[0]!, loop[0]!) < 0.5, '反向时起点仍然是同一个点')
  assert.ok(dist(rev[1]!, loop[loop.length - 1]!) < 0.5, '第二个点应是原来的最后一个点（倒序）')
  assert.ok(dist(rev[rev.length - 1]!, loop[1]!) < 0.5)

  // ③ 偏移 + 反向：起点落在偏移处，方向相反（相邻点应在"原顺序"的另一侧）
  const off = total / 4
  const both = applyStartToLoop(loop, { offsetM: off, direction: 'reverse' })
  assert.ok(dist(both[0]!, pointAtArcM(loop, off)!) < 0.6)
  const forwardNext = pointAtArcM(loop, off + total / loop.length)!
  const backwardNext = pointAtArcM(loop, off - total / loop.length)!
  assert.ok(dist(both[1]!, backwardNext) < dist(both[1]!, forwardNext), 'reverse 时第二个点应朝反方向')
})

test('snapToLoop：把圈外的点吸附到线上，并给出弧长偏移与"点偏了多少米"', () => {
  // 圆心外 120 m 处（正东）→ 应吸附到圆上最近点（半径 100、偏移≈0）
  const outside = { latitude: CENTER.latitude, longitude: CENTER.longitude + 120 / mLng }
  const snapped = snapToLoop(loop, outside)!
  assert.ok(Math.abs(radiusOf(snapped.point) - r) < 1, `吸附点应在圆上，实测半径 ${radiusOf(snapped.point).toFixed(1)}`)
  assert.ok(Math.abs(snapped.distanceM - 20) < 1.5, `应报告"点了圈外 20 m"，实测 ${snapped.distanceM.toFixed(1)}`)
  assert.ok(snapped.offsetM < 1 || Math.abs(snapped.offsetM - total) < 1, `正东是第 0 点附近，实测偏移 ${snapped.offsetM}`)

  // 在 1/4 周长处的点附近点一下 → 偏移应≈该处（说明偏移口径与 pointAtArcM 一致）
  const target = pointAtArcM(loop, total / 4)!
  const near = { latitude: Number(target.latitude) + 8 / mLat, longitude: Number(target.longitude) } // 往北偏 8 m
  const s2 = snapToLoop(loop, near)!
  assert.ok(Math.abs(s2.offsetM - total / 4) < 3, `偏移应≈${(total / 4).toFixed(1)}，实测 ${s2.offsetM.toFixed(1)}`)
  assert.ok(s2.distanceM > 4 && s2.distanceM < 12, `偏离应≈8 m，实测 ${s2.distanceM.toFixed(1)}`)

  // 点数不足 ⇒ null（调用方给"先描圈"的提示，而不是崩）
  assert.equal(snapToLoop(loop.slice(0, 2), outside), null)
})

test('startDirectionLabel：顺/逆时针由**几何**算出来，圈向未知时不瞎猜', () => {
  // 夹具是逆时针 ⇒ forward = 逆时针
  assert.equal(startDirectionLabel(loop, 'forward'), '逆时针')
  assert.equal(startDirectionLabel(loop, 'reverse'), '顺时针')
  // 反过来画的圈：forward = 顺时针
  const cw = [...loop].reverse()
  assert.equal(startDirectionLabel(cw, 'forward'), '顺时针')
  assert.equal(startDirectionLabel(cw, 'reverse'), '逆时针')
  // 圈向未知（点数不足）→ 用中性措辞，绝不编造顺/逆
  assert.equal(startDirectionLabel(loop.slice(0, 2), 'forward'), '沿描圈方向')
  assert.equal(startDirectionLabel([], 'reverse'), '反向')
})
