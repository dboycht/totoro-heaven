/**
 * 「配速档位」纯逻辑测试（2026-11-24 用户口径）
 *
 * 用户原话：「……首先，我们需要生成其里程长度，对于真实路径直接计算即可，对于模拟路径则进行模拟计算得到数值；
 * 获取时间长度要求，得到配速上下限；平均分为 5 段，中间三个分割点记作最高速，中速，低速；选择相对应的速度后，
 * 用户点击随机配速（仅真实路径），则以其选择的分割点为中心，五均分为半径，随机进行抽取」
 * 👉 当天更正：「我傻了，算错了，应该是**四等分**；四等分中间有三个分界」。
 *
 * 定稿口径（本轮实现）：
 *   · 上下限 = **时长窗 ÷ 里程**（速度窗只在没有时长窗时兜底）；
 *   · 四等分 ⇒ 分界点 0.25 / 0.5 / 0.75 = 最高速 / 中速 / 低速；
 *   · 半径 = **一个等分段宽 = 区间 ÷ 4**（用户跳过的那题取推荐默认：档位中心 ± 半段宽，
 *     相邻档在边界处相接）；
 *   · 采样 = 在 `[中心 − 半径, 中心 + 半径]` 内均匀随机，夹回窗口，并**避开整分钟**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PACE_GEARS,
  createRngFromSeed,
  paceGearOf,
  paceGearPoints,
  previewPlannedKm,
  runPaceWindow,
  sampleGearPace,
} from '../../utils/mp/realism.ts'

/** 南航演示任务：3.2 km、10~25 分钟、速度 3~15 km/h */
const TASK = { minSpeedKmh: 3, maxSpeedKmh: 15, minMinutes: 10, maxMinutes: 25 } as const
const winOf = (km: number) => runPaceWindow({ requiredKm: km, ...TASK }, km)

test('档位就是四等分的三个分界点：0.25 / 0.5 / 0.75（最高速 / 中速 / 低速）', () => {
  assert.deepEqual(
    PACE_GEARS.map((g) => [g.key, g.position, g.label]),
    [
      ['fast', 0.25, '最高速'],
      ['mid', 0.5, '中速'],
      ['slow', 0.75, '低速'],
    ],
  )
  const w = winOf(3.2)
  const pts = paceGearPoints(w)!
  const span = w.hi - w.lo
  assert.equal(pts.length, 3)
  assert.ok(Math.abs(pts[0]!.paceSecPerKm - (w.lo + 0.25 * span)) <= 1, `最高速 ${pts[0]!.paceSecPerKm}`)
  assert.ok(Math.abs(pts[1]!.paceSecPerKm - (w.lo + 0.5 * span)) <= 1, `中速 ${pts[1]!.paceSecPerKm}`)
  assert.ok(Math.abs(pts[2]!.paceSecPerKm - (w.lo + 0.75 * span)) <= 1, `低速 ${pts[2]!.paceSecPerKm}`)
  assert.ok(pts[0]!.paceSecPerKm < pts[1]!.paceSecPerKm && pts[1]!.paceSecPerKm < pts[2]!.paceSecPerKm, '越快数值越小')
})

test('随机半径 = 一个等分段宽（区间 ÷ 4）；三档的随机范围合起来正好盖住整个区间', () => {
  const w = winOf(4) // 4 km 的真实路径（用户点名的场景）
  const pts = paceGearPoints(w)!
  const span = w.hi - w.lo
  for (const p of pts) {
    assert.ok(Math.abs(p.radiusSecPerKm - span / 4) < 1e-9, `${p.key} 半径 ${p.radiusSecPerKm} ≠ ${span / 4}`)
    assert.ok(Math.abs(p.lo - Math.max(w.lo, p.paceSecPerKm - p.radiusSecPerKm)) < 1e-6, `${p.key} 档内下界`)
    assert.ok(Math.abs(p.hi - Math.min(w.hi, p.paceSecPerKm + p.radiusSecPerKm)) < 1e-6, `${p.key} 档内上界`)
    // 中心是整数（界面显示的就是它）
  }
  /**
   * 半径 = 一个等分段宽 ⇒ 每个档位的随机范围宽 = `span / 2`，**相邻两档重叠一段**（各跨到邻档一半）：
   *   最高速档 [0, 0.5]、中速档 [0.25, 0.75]、低速档 [0.5, 1.0]（按区间相对位置）。
   *   这是"中心 ± 半径"的必然结果（用户口径就是"四均分为半径"）。
   */
  for (const p of pts) {
    assert.ok(Math.abs((p.hi - p.lo) - span / 2) <= 1, `${p.key} 档宽 ${p.hi - p.lo} 应 ≈ 区间一半 ${span / 2}`)
  }
  assert.ok(pts[0]!.hi > pts[1]!.lo + 1, '最高速档与中速档应重叠（半径 = 一段宽）')
  assert.ok(pts[1]!.hi > pts[2]!.lo + 1, '中速档与低速档应重叠')
  // 并集 = 整个区间（快端由最高速档覆盖到 lo，慢端由低速档覆盖到 hi）
  assert.ok(Math.abs(pts[0]!.lo - w.lo) <= 1, `最高速档应覆盖快端 ${w.lo}`)
  assert.ok(Math.abs(pts[2]!.hi - w.hi) <= 1, `低速档应覆盖慢端 ${w.hi}`)
  for (const p of pts) assert.equal(p.paceSecPerKm, Math.round(p.paceSecPerKm), `${p.key} 中心应是整数`)
})

test('里程变化会把整组档位挪动（4 km 的档位整体快于 3.2 km 的）', () => {
  const a = paceGearPoints(winOf(3.2))!
  const b = paceGearPoints(winOf(4))!
  for (let i = 0; i < 3; i++) {
    assert.ok(b[i]!.paceSecPerKm < a[i]!.paceSecPerKm, `第 ${i} 档：4 km ${b[i]!.paceSecPerKm} 应快于 3.2 km ${a[i]!.paceSecPerKm}`)
  }
  // 交错：4 km 的中速档比 3.2 km 的中速档快，但仍慢于 3.2 km 的最高速档
  assert.ok(b[1]!.paceSecPerKm > a[0]!.paceSecPerKm, '4 km 中速不该快过 3.2 km 最高速（里程不会改变档位次序）')
})

test('sampleGearPace：抽出来的值落在**所选档位**的范围内（不是整个区间）', () => {
  const w = winOf(4)
  const pts = paceGearPoints(w)!
  for (const p of pts) {
    const seen = new Set<number>()
    for (let seed = 0; seed < 80; seed++) {
      const pace = sampleGearPace({ gear: p.key, window: w, rng: createRngFromSeed(seed) })
      assert.ok(pace >= Math.floor(p.lo) && pace <= Math.ceil(p.hi), `${p.key} seed=${seed} 抽出 ${pace} 越出档内 ${p.lo}~${p.hi}`)
      seen.add(pace)
    }
    assert.ok(seen.size >= 10, `${p.key} 档 80 个种子只抽出 ${seen.size} 种配速`)
    // 档位中心不是唯一解
    assert.ok([...seen].some((x) => x !== p.paceSecPerKm), `${p.key} 档抽来抽去都是中心值`)
  }
})

test('sampleGearPace：避开整分钟（整分钟看起来假）', () => {
  const w = winOf(3.2)
  for (const g of PACE_GEARS) {
    for (let seed = 0; seed < 60; seed++) {
      const pace = sampleGearPace({ gear: g.key, window: w, rng: createRngFromSeed(seed) })
      assert.notEqual(pace % 60, 0, `${g.key} seed=${seed} 抽出整分钟 ${pace}`)
    }
  }
})

test('sampleGearPace：区间不可用（任务两个窗都没下发）⇒ 退回基线口径而不是崩', () => {
  const none = runPaceWindow({ requiredKm: 3.2 }, 3.2)
  assert.equal(paceGearPoints(none), null)
  assert.equal(paceGearOf(none, 'mid'), null)
  for (let seed = 0; seed < 20; seed++) {
    const pace = sampleGearPace({ gear: 'mid', window: none, basePaceSecPerKm: 390, targetKm: 3.2, rng: createRngFromSeed(seed) })
    assert.ok(Math.abs(pace - 390) <= 390 * 0.03 + 2, `无区间时应围绕基线 390，实际 ${pace}`)
  }
})

test('previewPlannedKm：模拟路径的预览里程 = 要求里程 ×(1+超跑中值 2.15%)', () => {
  assert.equal(previewPlannedKm(3.2), 3.27)
  assert.equal(previewPlannedKm(2.4), 2.45)
  assert.equal(previewPlannedKm(0), previewPlannedKm(0.1))
  // 预览里程落在真随机超跑区间（+0.3%~+4.0%）之内
  assert.ok(previewPlannedKm(3.2) >= 3.2 * 1.003 && previewPlannedKm(3.2) <= 3.2 * 1.04)
})
