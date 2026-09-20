/**
 * 签到区域编辑的纯逻辑测试（2026-09-20）
 *
 * 重点钉住四件容易错的事：
 *  ① **绝不越出服务端围栏**（上限比例 + GPS 噪声 + 最终夹紧三道）—— 越界就等于"人不该被允许签到"；
 *  ② **"偏内"分布确实生效**（不是贴着圆心、也不是贴边）；
 *  ③ **非法输入原样透传**（不产 NaN、不阻断提交）；
 *  ④ **点位标识字段不受影响**（由 `mornSignSubmit` 的用例保证，这里只测坐标生成）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MORN_SIGN_ZONE,
  normalizeZone,
  offsetMeters,
  sampleDistribution,
  sampleZoneCoord,
} from '../../utils/mp/mornSignZone.ts'

/** 东操场实测坐标（服务端下发）+ 300 m 圈 */
const LAT = '31.370415772884936'
const LNG = '119.48904656767843'
const R = 300

/** 可复现的伪随机（线性同余），避免测试抖动导致偶发失败 */
const mkRand = (seed = 12345) => {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

test('mornSignZone：**任何采样都不得越出服务端围栏**（含噪声很大的极端配置）', () => {
  const cases = [
    { innerFraction: 0.9, outerFraction: 0.95, gpsSigmaM: 50 }, // 最靠边 + 最大噪声
    { innerFraction: 0, outerFraction: 0.95, gpsSigmaM: 30 },
    { innerFraction: 0.5, outerFraction: 0.5, gpsSigmaM: 50 },
  ]
  for (const zone of cases) {
    const rand = mkRand(7)
    for (let i = 0; i < 400; i++) {
      const s = sampleZoneCoord(LAT, LNG, R, zone, rand)
      const d = offsetMeters(LAT, LNG, s.latitude, s.longitude)
      // ⚠️ 容差 +0.5 是为了覆盖坐标 `toFixed(7)`（约 1 cm）的舍入误差 —— 真实距离仍 ≤ R。
      assert.ok(d <= R + 0.5, `配置 ${JSON.stringify(zone)} 第 ${i} 次采样越界：${d.toFixed(2)} m > ${R} m`)
    }
  }
})

test('mornSignZone："偏内"生效 —— 落点既不贴圆心、也不贴边', () => {
  const rand = mkRand(99)
  const { minM, maxM, meanM } = sampleDistribution(LAT, LNG, R, { innerFraction: 0.15, outerFraction: 0.6, gpsSigmaM: 6 }, 400, rand)
  assert.ok(minM < 150, `最小值 ${minM.toFixed(1)} m 说明确实有靠内的样本（不是全贴边）`)
  assert.ok(maxM <= R, `最大值 ${maxM.toFixed(1)} m 不得越界`)
  assert.ok(meanM > 30 && meanM < 220, `均值 ${meanM.toFixed(1)} m 应落在"圈内偏中"的合理区间`)
})

test('mornSignZone：配置归一化 —— 非法值被夹紧、inner>outer 会被**交换**', () => {
  const z1 = normalizeZone({ innerFraction: 0.9, outerFraction: 0.2 })
  assert.ok(z1.innerFraction <= z1.outerFraction, '必须交换成 inner ≤ outer（否则区间退化）')
  assert.equal(z1.innerFraction, 0.2)
  assert.equal(z1.outerFraction, 0.9)
  const z2 = normalizeZone({ gpsSigmaM: 999, bearingJitterDeg: -50 })
  assert.equal(z2.gpsSigmaM, 50, '噪声夹到上限')
  assert.equal(z2.bearingJitterDeg, 0, '负扰动夹到 0')
  const z3 = normalizeZone({ radiusM: 5 })
  assert.equal(z3.radiusM, 20, '半径夹到下限')
  const z4 = normalizeZone({ approachBearingDeg: -30 })
  assert.equal(z4.approachBearingDeg, 330, '方位角归一化到 [0,360)')
  const z5 = normalizeZone(null)
  // ⚠️ 不要用 deepEqual 比对象：归一化会**补出** `disabled: false`，而 DEFAULT 里没这个键。
  //    判据应该是"各字段的**值**等于默认"，而不是"对象形状逐键相同"。
  for (const k of ['radiusM', 'innerFraction', 'outerFraction', 'approachBearingDeg', 'bearingJitterDeg', 'gpsSigmaM'] as const) {
    assert.equal(z5[k], DEFAULT_MORN_SIGN_ZONE[k], `空输入时 ${k} 应等于默认`)
  }
  assert.equal(z5.disabled, false)
})

test('mornSignZone：滑杆累加的浮点噪声被归一化掉（实测拖出 0.6000000000000001）', () => {
  const z = normalizeZone({ innerFraction: 0.6000000000000001, outerFraction: 0.30000000000000004 })
  assert.equal(z.outerFraction, 0.6, '应取整成 0.6（否则界面显示 60.00000000000001%）')
  assert.equal(z.innerFraction, 0.3)
  const z2 = normalizeZone({ gpsSigmaM: 5.999999999, bearingJitterDeg: 34.9999999999 })
  assert.equal(z2.gpsSigmaM, 6)
  assert.equal(z2.bearingJitterDeg, 35)
})

test('mornSignZone：非法坐标/关掉/无半径 ⇒ **原样透传**（不产 NaN，不阻断提交）', () => {
  const a = sampleZoneCoord('abc', LNG, R, null, mkRand())
  assert.equal(a.latitude, 'abc')
  assert.equal(a.distanceM, 0)
  const b = sampleZoneCoord(LAT, LNG, 0, null, mkRand())
  assert.equal(b.latitude, LAT, '没有可用半径 ⇒ 回退成中心点')
  const c = sampleZoneCoord(LAT, LNG, R, { disabled: true }, mkRand())
  assert.equal(c.latitude, LAT, 'disabled ⇒ 原样')
  const d = sampleZoneCoord(LAT, LNG, null, { radiusM: 150 }, mkRand())
  const dist = offsetMeters(LAT, LNG, d.latitude, d.longitude)
  assert.ok(dist <= 150.5, `配置半径 150 时应以它为上限，实际 ${dist.toFixed(1)} m`)
  assert.ok(!/NaN/.test(d.latitude + d.longitude), '不得出现 NaN')
})

test('mornSignZone：`radiusM=null` 跟随服务端；手动值可覆盖', () => {
  const rand = mkRand(3)
  // 服务端 100 m 圈 ⇒ 不得超出 100
  let maxSeen = 0
  for (let i = 0; i < 300; i++) {
    const s = sampleZoneCoord(LAT, LNG, 100, { gpsSigmaM: 20 }, rand)
    maxSeen = Math.max(maxSeen, offsetMeters(LAT, LNG, s.latitude, s.longitude))
  }
  assert.ok(maxSeen <= 100.6, `跟随服务端 100 m 圈时最大 ${maxSeen.toFixed(1)} m`)
  // 手动指定更小的上限 ⇒ 以更小者为准
  let maxSeen2 = 0
  for (let i = 0; i < 300; i++) {
    const s = sampleZoneCoord(LAT, LNG, 300, { radiusM: 60, gpsSigmaM: 10 }, mkRand(11))
    maxSeen2 = Math.max(maxSeen2, offsetMeters(LAT, LNG, s.latitude, s.longitude))
  }
  assert.ok(maxSeen2 <= 60.6, `手动 60 m 上限时最大 ${maxSeen2.toFixed(1)} m`)
})

test('mornSignZone：固定方位（bearingJitter=0）会让方向稳定；有扰动时方向会变', () => {
  const fixed = sampleDistribution(LAT, LNG, R, { approachBearingDeg: 90, bearingJitterDeg: 0, gpsSigmaM: 0, innerFraction: 0.5, outerFraction: 0.5 }, 50, mkRand(5))
  const bearings = new Set(fixed.points.map((p) => Math.round(p.bearingDeg)))
  assert.equal(bearings.size, 1, 'jitter=0 ⇒ 方位恒为设定值（90°=正东）')
  assert.equal([...bearings][0], 90)

  const jittered = sampleDistribution(LAT, LNG, R, { approachBearingDeg: 90, bearingJitterDeg: 35, gpsSigmaM: 0 }, 50, mkRand(5))
  assert.ok(new Set(jittered.points.map((p) => Math.round(p.bearingDeg))).size > 5, 'jitter=35° ⇒ 方位应明显分散')
})
