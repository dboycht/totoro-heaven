/**
 * 任务窗口冲突的"冗余提示"单测（2026-09-21 用户要求）
 *
 * 背景：任务的**速度窗**（配速上下限）与**时长窗**（跑多久）偶尔会**互相矛盾**（任务参数本身有错），
 * 此时 `planRealisticRun` 只能以速度窗为准 —— 结果必然违反时长窗。
 * 用户判断"这种情况基本不可能"，所以**不做结构性处理，只做冗余提示**：如实标记 + 可读说明
 * （含两侧窗口与里程，方便用户直接发给开发者核对）。
 *
 * 钉住三件事：① 正常任务**不带**冲突标记（不污染常规产物）；② 矛盾任务**一定**被标出来且说明可读；
 *            ③ 标出来的那种情况**确实**违反了时长窗（证明这个告警不是多余的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planRealisticRun } from '../../utils/mp/realism.ts'

test('正常任务：不带 windowConflict 标记，配速落在速度窗内', () => {
  const plan = planRealisticRun({
    requiredKm: 3.27,
    minSpeedKmh: 8,
    maxSpeedKmh: 15,
    minMinutes: 15,
    maxMinutes: 30,
    seed: 1,
  })
  assert.equal(plan.windowConflict, undefined, '正常任务不该带冲突标记')
  assert.equal(plan.windowConflictDetail, undefined)
  // 速度窗 8~15 km/h ⇒ 配速 240~450 秒/公里
  assert.ok(plan.paceSecPerKm >= 239 && plan.paceSecPerKm <= 451, `配速 ${plan.paceSecPerKm} 应落在速度窗内`)
  // 时长落在时长窗内（15~30 分钟）
  assert.ok(plan.durationSeconds >= 15 * 60 - 2 && plan.durationSeconds <= 30 * 60 + 2, `时长 ${plan.durationSeconds} 应落在时长窗内`)
})

test('任务参数矛盾（速度窗与时长窗无交集）：必须标记冲突并给出可读说明', () => {
  // 速度窗 8~15 km/h ⇒ 配速 240~450 秒/公里；时长窗 60~90 分钟 / 3.27 km ⇒ 配速约 1090~1640 秒/公里
  // 两者无交集（最长也只要 450 秒/公里 ≈ 25 分钟）⇒ 只能以速度窗为准
  const plan = planRealisticRun({
    requiredKm: 3.27,
    minSpeedKmh: 8,
    maxSpeedKmh: 15,
    minMinutes: 60,
    maxMinutes: 90,
    seed: 7,
  })
  assert.equal(plan.windowConflict, true, '矛盾任务必须被标出来（不能静默）')
  const detail = String(plan.windowConflictDetail ?? '')
  assert.ok(detail.includes('无交集'), detail)
  assert.ok(detail.includes('速度窗'), detail)
  assert.ok(detail.includes('时长窗'), detail)
  assert.ok(detail.includes('发给开发者'), '要明确请用户把参数发给开发者（用户要求）')
  // 证明确实违反了时长窗 —— 这正是必须告警的原因
  assert.ok(plan.durationSeconds < 60 * 60, `时长 ${plan.durationSeconds} 秒应短于时长窗下限 3600 秒`)
})

test('只给速度窗（任务没给时长）时不算冲突', () => {
  const plan = planRealisticRun({ requiredKm: 3.27, minSpeedKmh: 8, maxSpeedKmh: 15, seed: 3 })
  assert.equal(plan.windowConflict, undefined)
})
