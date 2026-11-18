/**
 * 真实感规划测试（2026-09-14 用户要求：别跑出 3.20 / 16:00 这种"一眼假"的整数值）
 *
 * 守住三件事：
 *   1. 数值**落在任务窗口内**（速度 km/h、时长分钟都要合法）；
 *   2. 数值**不是整数/整分钟**（超跑里程 + 非整配速）；
 *   3. 同种子可复现、不同种子有差异（每次跑都不一样）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newRunSeed, planRealisticRun, randomRealPathPace, runPaceWindow } from '../../utils/mp/realism.ts'
import type { RunPaceWindow } from '../../utils/mp/realism.ts'
import { generateCorridorRoute } from '../../utils/mp/generateRoute.ts'
import { evaluateRunAgainstTask } from '../../utils/mp/taskRules.ts'
import type { MpSunrunTask } from '../../src/mp/types.ts'

/** 2026-09-14 实测的天目湖阳光跑任务 */
const NUAA_TASK = { mileage: 3.2, minSpeed: 3, maxSpeed: 15, minTime: 10, maxTime: 25 } as const

const planWith = (seed: number, basePaceSecPerKm?: number) =>
  planRealisticRun({
    requiredKm: NUAA_TASK.mileage,
    minSpeedKmh: NUAA_TASK.minSpeed,
    maxSpeedKmh: NUAA_TASK.maxSpeed,
    minMinutes: NUAA_TASK.minTime,
    maxMinutes: NUAA_TASK.maxTime,
    basePaceSecPerKm,
    seed,
  })

test('planRealisticRun：里程略超要求（+0.3%~+4.0% → 3.2km 任务落在 3.21~3.33km）', () => {
  for (const seed of [1, 7, 42, 20260914, 99999]) {
    const plan = planWith(seed)
    assert.ok(plan.targetKm > NUAA_TASK.mileage, `seed=${seed} 应超跑，实际 ${plan.targetKm}`)
    // 2026-09-16 用户要求：里程定为 3.21~3.35km（更贴近真跑；真跑实测 3.21km）
    assert.ok(plan.overshootRatio >= 0.003 && plan.overshootRatio <= 0.04, `超跑比例 ${plan.overshootRatio}`)
    assert.equal(plan.targetKm, Number((NUAA_TASK.mileage * (1 + plan.overshootRatio)).toFixed(2)))
    assert.ok(plan.targetKm >= 3.21 && plan.targetKm <= 3.33, `目标里程 ${plan.targetKm} 超出 3.21~3.33`)
  }
})

test('planRealisticRun：100 个种子的目标里程都落在 3.21~3.33（不含收尾溢出）', () => {
  const targets = new Set<number>()
  for (let seed = 0; seed < 100; seed++) {
    const plan = planWith(seed)
    assert.ok(plan.targetKm >= 3.21 && plan.targetKm <= 3.33, `seed=${seed} → ${plan.targetKm}`)
    targets.add(plan.targetKm)
  }
  assert.ok(targets.size >= 8, `100 个种子只产生 ${targets.size} 种里程，多样性不足`)
})

test('planRealisticRun：配速与时长都落在任务窗口内（速度 3~15 km/h、10~25 分钟）', () => {
  for (let seed = 0; seed < 50; seed++) {
    const plan = planWith(seed)
    const speedKmh = 3600 / plan.paceSecPerKm
    const minutes = (plan.targetKm * plan.paceSecPerKm) / 60
    assert.ok(speedKmh >= 3 && speedKmh <= 15, `seed=${seed} 速度 ${speedKmh.toFixed(2)} km/h 越界`)
    assert.ok(minutes >= 10 && minutes <= 25, `seed=${seed} 时长 ${minutes.toFixed(2)} 分钟越界`)
  }
})

test('planRealisticRun：配速通常不是整分钟（避免 5\'00" 这种圆值）', () => {
  let roundCount = 0
  for (let seed = 0; seed < 40; seed++) {
    if (planWith(seed).paceSecPerKm % 60 === 0) roundCount++
  }
  assert.ok(roundCount <= 4, `40 次里整分钟配速出现 ${roundCount} 次，太多（看起来假）`)
})

test('planRealisticRun：同种子可复现、不同种子有差异', () => {
  assert.deepEqual(planWith(123), planWith(123))
  const targets = new Set(Array.from({ length: 20 }, (_, i) => planWith(i).targetKm))
  assert.ok(targets.size >= 8, `20 个种子只产生 ${targets.size} 种里程，多样性不足`)
})

test('planRealisticRun：窗口很窄时会被夹紧（不会越界）', () => {
  // 只允许 12 km/h（= 5'00"/km），时长窗口放宽
  const plan = planRealisticRun({
    requiredKm: 3.2,
    minSpeedKmh: 12,
    maxSpeedKmh: 12,
    minMinutes: 5,
    maxMinutes: 60,
    seed: 5,
  })
  assert.equal(plan.paceSecPerKm, 300)
})

test('planRealisticRun：不传 basePace 时用 5\'50"~6\'20" 随机，传了则以其为基线', () => {
  const withBase = planWith(9, 390)
  assert.ok(Math.abs(withBase.paceSecPerKm - 390) <= 390 * 0.03 + 1, `实际 ${withBase.paceSecPerKm}`)
  const auto = planWith(9)
  assert.ok(auto.paceSecPerKm >= 330 && auto.paceSecPerKm <= 400, `实际 ${auto.paceSecPerKm}`)
})

test('newRunSeed：连续取值互不相同', () => {
  const seeds = new Set(Array.from({ length: 20 }, () => newRunSeed()))
  assert.ok(seeds.size >= 18, `20 次只生成 ${seeds.size} 个不同种子`)
})

test('端到端真实感：规划 → 生成轨迹 → 任务自检全绿，且数值不是圆值', () => {
  const task: MpSunrunTask = {
    paperName: '天目湖阳光跑（测试）',
    taskId: 'sunrunTaskPaper-20210917000004',
    mileage: 3.2,
    minSpeed: 3,
    maxSpeed: 15,
    minTime: 10,
    maxTime: 25,
    fitDegree: 0.6,
    runPointList: [],
  }
  const loop = [
    { latitude: 31.9, longitude: 119.1 },
    { latitude: 31.902, longitude: 119.1 },
    { latitude: 31.902, longitude: 119.102 },
    { latitude: 31.9, longitude: 119.102 },
    { latitude: 31.9, longitude: 119.1 },
  ]

  const plan = planRealisticRun({
    requiredKm: task.mileage,
    minSpeedKmh: task.minSpeed,
    maxSpeedKmh: task.maxSpeed,
    minMinutes: task.minTime,
    maxMinutes: task.maxTime,
    seed: 20260914,
  })
  const generated = generateCorridorRoute(loop, { targetKm: plan.targetKm, stepM: 3, drift: true, seed: 20260914 })
  const km = Number(generated.km)
  const durationSeconds = Math.round(km * plan.paceSecPerKm)

  const check = evaluateRunAgainstTask({ task, km, durationSeconds, fitDegree: Number(generated.fitDegree) })
  assert.equal(check.pass, true, JSON.stringify(check.problems))

  // 数值"不像整数"：里程不是 3.20、时长不是整分钟
  assert.notEqual(km.toFixed(2), task.mileage.toFixed(2), '里程不应正好等于任务要求')
  assert.notEqual(durationSeconds % 60, 0, `时长 ${durationSeconds}s 是整分钟，看起来假`)
  // 拟合度口径（**2026-09-17 用户改为 0.97~1.00**）：优先"看起来在跑道上"，
  // 因为判据容差是 25 m —— 压到 0.8x 就必须偏离路线 25 m+（甩出跑道、手机上一眼假）。
  assert.ok(Number(generated.fitDegree) >= 0.97, `拟合度 ${generated.fitDegree} 低于新下限 0.97`)
  assert.ok(Number(generated.fitDegree) <= 1, `拟合度 ${generated.fitDegree} 超过上限 1.00`)
})

// ── 🆕 2026-11-18：真实路径的「随机配速」按钮（用户："不是 6:00 这种太假的，而是那种 6:11 这种"）──

const windowOf = (input: Parameters<typeof runPaceWindow>[0]): RunPaceWindow => runPaceWindow(input, input.requiredKm)

/** 无任何约束的窗口（任务没下发速度/时长） */
const FREE_WINDOW: RunPaceWindow = {
  lo: 0,
  hi: Infinity,
  speedLo: 0,
  speedHi: Infinity,
  timeLo: 0,
  timeHi: Infinity,
  hasSpeedWindow: false,
  hasTimeWindow: false,
  conflict: false,
}

test('🔴 randomRealPathPace：结果**不是整分钟**（6\'00" 这种一眼假的不许出现）', () => {
  for (let i = 0; i < 50; i++) {
    const pace = randomRealPathPace({ basePaceSecPerKm: 360, window: FREE_WINDOW, targetKm: 3.2, rng: () => i / 50 })
    assert.notEqual(pace % 60, 0, `第 ${i} 次随机出了整分钟配速 ${pace}`)
  }
})

test('randomRealPathPace：落在任务允许区间内（与模拟跑同一个采样器）', () => {
  const win = windowOf({ requiredKm: 3.2, minSpeedKmh: 3, maxSpeedKmh: 15, minMinutes: 10, maxMinutes: 25 })
  for (let i = 0; i < 50; i++) {
    const pace = randomRealPathPace({ basePaceSecPerKm: 360, window: win, targetKm: 3.2 })
    assert.ok(pace >= win.lo && pace <= win.hi, `配速 ${pace} 越出 [${win.lo}, ${win.hi}]`)
  }
})

test('randomRealPathPace：可复现（注入 rng）且通常有变化', () => {
  const a = randomRealPathPace({ basePaceSecPerKm: 360, window: FREE_WINDOW, targetKm: 3.2, rng: () => 0.5 })
  const b = randomRealPathPace({ basePaceSecPerKm: 360, window: FREE_WINDOW, targetKm: 3.2, rng: () => 0.5 })
  assert.equal(a, b, '同一 rng 必须同一个结果')
  const set = new Set<number>()
  for (let i = 0; i < 30; i++) set.add(randomRealPathPace({ basePaceSecPerKm: 360, window: FREE_WINDOW, targetKm: 3.2, rng: () => i / 30 }))
  assert.ok(set.size >= 10, `30 个 rng 只产生 ${set.size} 种配速，多样性不足`)
})

test('randomRealPathPace：基线在区间外时也不越界（越界基线不会把结果顶到界外）', () => {
  // 研途健行式窄窗：514~875，而默认策略 6'00"=360 远在快侧之外
  const win = windowOf({ requiredKm: 2.4, minSpeedKmh: 4, maxSpeedKmh: 7, minMinutes: 20, maxMinutes: 35 })
  for (let i = 0; i < 50; i++) {
    const pace = randomRealPathPace({ basePaceSecPerKm: 360, window: win, targetKm: 2.4, rng: () => i / 50 })
    assert.ok(pace >= win.lo && pace <= win.hi, `配速 ${pace} 越出 [${win.lo}, ${win.hi}]`)
  }
})
