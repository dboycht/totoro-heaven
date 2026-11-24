/**
 * 「研途健行」跑步页设置的纯逻辑测试（2026-09-29）
 *
 * 钉住四件事（每一条都对应一个"两处口径不一致就会骗到用户"的风险）：
 *   ① `clampYtuTargetKm` 是**唯一归一化入口**：空/坏输入回落默认值、越界夹紧、两位小数；
 *   ② 它与自由跑那套（`clampFreeRunKm`）**不是同一个口径**（默认值/小数位不同，别互相复用）；
 *   ③ `normalizeYtuLaps`：空白＝没填（`null`）、非法＝填错（也 `null`，界面另说）、合法夹到 [1,999]；
 *   ④ `ytuRunPreview` 三个数字**同源**（时长 = 里程 × 配速、速度 = 3600 / 配速）——
 *      这正是 issue #13 里"右下角的配速无效"要修的那一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  YTU_TARGET_KM_FALLBACK,
  YTU_TARGET_KM_MAX,
  YTU_TARGET_KM_MIN,
  clampYtuTargetKm,
  formatYtuTargetKm,
  normalizeYtuLaps,
  paceWindowText,
  parseStoredYtuLaps,
  parseStoredYtuTargetKm,
  ytuRunPreview,
} from '../../utils/mp/ytuRun.ts'
import { clampFreeRunKm } from '../../utils/mp/freeRun.ts'

test('clampYtuTargetKm：空 / 坏输入回落**兜底任务里程**（不是 0、也不是下限）', () => {
  for (const bad of [null, undefined, '', '   ', 'abc', NaN, Infinity, {}, []]) {
    const v = clampYtuTargetKm(bad)
    assert.equal(v, YTU_TARGET_KM_FALLBACK, `输入 ${JSON.stringify(bad)} 应回落兜底值`)
  }
  // 传了任务里程当兜底时，用任务里程（这是正常路径：默认值 = 任务 mileage）
  assert.equal(clampYtuTargetKm(null, 2.4), 2.4)
})

test('clampYtuTargetKm：越界夹紧、保留两位小数（任务里程实测就是两位：2.40）', () => {
  assert.equal(clampYtuTargetKm(0), YTU_TARGET_KM_MIN)
  assert.equal(clampYtuTargetKm(-5), YTU_TARGET_KM_MIN)
  assert.equal(clampYtuTargetKm(999), YTU_TARGET_KM_MAX)
  assert.equal(clampYtuTargetKm(2.4), 2.4)
  assert.equal(clampYtuTargetKm('2.446'), 2.45)
  assert.equal(clampYtuTargetKm(2.401), 2.4)
  assert.equal(formatYtuTargetKm(2.4), '2.40')
  assert.equal(formatYtuTargetKm(5), '5.00')
})

test('研途健行与自由跑的里程口径**不是一回事**（默认值/小数位都不同，别互相复用）', () => {
  // 自由跑：清空回落 5.0（一位小数）
  assert.equal(clampFreeRunKm(null), 5)
  // 研途健行：清空回落"任务里程/兜底"，两位小数
  assert.equal(clampYtuTargetKm(null, 2.4), 2.4)
  assert.equal(formatYtuTargetKm(clampYtuTargetKm(null, 2.4)), '2.40')
  // 一个任务里程低于自由跑下限时，两种口径会给不同答案（证明不能共用）
  assert.equal(clampFreeRunKm(0.3), 0.5)
  assert.equal(clampYtuTargetKm(0.3, 0.3), 0.3)
})

test('parseStoredYtuTargetKm：落盘值坏掉时回落（绝不返回 NaN/0）', () => {
  assert.equal(parseStoredYtuTargetKm('2.4'), 2.4)
  assert.equal(parseStoredYtuTargetKm(''), YTU_TARGET_KM_FALLBACK)
  assert.equal(parseStoredYtuTargetKm(null), YTU_TARGET_KM_FALLBACK)
  assert.equal(parseStoredYtuTargetKm('abc', 2.4), 2.4)
})

test('normalizeYtuLaps：空白 = 没填、非法 = 填错（都 null）、合法夹到 [1, 999] 整数', () => {
  for (const blank of [null, undefined, '', '   ']) assert.equal(normalizeYtuLaps(blank), null, `空白 ${JSON.stringify(blank)}`)
  for (const bad of [0, -1, 'abc', NaN]) assert.equal(normalizeYtuLaps(bad), null, `非法 ${JSON.stringify(bad)}`)
  assert.equal(normalizeYtuLaps(3), 3)
  assert.equal(normalizeYtuLaps('7'), 7)
  assert.equal(normalizeYtuLaps(2.6), 3)
  assert.equal(normalizeYtuLaps(99999), 999)
  assert.equal(parseStoredYtuLaps('5'), 5)
  assert.equal(parseStoredYtuLaps(''), null)
})

test('⭐ ytuRunPreview：时长与速度都**从配速同源算出**（不许各算一遍）', () => {
  const p = ytuRunPreview(2.44, 658)
  assert.equal(p.km, 2.44)
  assert.equal(p.paceText, `10'58"`)
  assert.equal(p.durationSeconds, Math.round(2.44 * 658))
  assert.equal(p.durationSeconds, 1606)
  assert.equal(p.speedKmh, Math.round((3600 / 658) * 10) / 10)
  // 入参非法时如实给 0，不许 NaN
  const bad = ytuRunPreview(NaN, NaN)
  assert.equal(Number.isFinite(bad.km), true)
  assert.equal(bad.durationSeconds, 0)
  assert.equal(bad.speedKmh, 0)
})

test('paceWindowText：把生效区间如实说成人话；没有窗口时不编数字；冲突时给开发者的指引', () => {
  // 🔄 2026-11-24：有时长窗 ⇒ 区间按**时间要求**换算出来（不再报"速度要求 + 时长要求"的合成口径）
  const both = paceWindowText({ lo: 514, hi: 875, hasSpeedWindow: true, hasTimeWindow: true })
  assert.ok(both.includes('按时间要求换算'), both)
  assert.ok(both.includes(`8'34"`) && both.includes(`14'35"`), both)
  assert.ok(both.includes('km/h'), both)
  const speedOnly = paceWindowText({ lo: 240, hi: 450, hasSpeedWindow: true, hasTimeWindow: false })
  assert.ok(speedOnly.includes('按速度要求换算'), speedOnly)
  assert.ok(paceWindowText({ lo: 0, hi: Infinity, hasSpeedWindow: false, hasTimeWindow: false }).includes('没有下发'), '没窗口要如实说')
  const conflict = paceWindowText({ lo: 240, hi: 450, hasSpeedWindow: true, hasTimeWindow: true, conflict: true })
  assert.ok(conflict.includes('发给开发者') && conflict.includes('按时长窗'), conflict)
  // 退化成一点
  const point = paceWindowText({ lo: 300, hi: 300, hasSpeedWindow: true, hasTimeWindow: true })
  assert.ok(point.includes(`5'00"`), point)
})
