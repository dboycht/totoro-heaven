/**
 * 任务约束自检测试
 *
 * 重点覆盖两类判断：
 *   - `hard`（里程 / 拟合度）：**参与 pass**，错了会误判成绩；
 *   - `inferred`（配速 / 时长 / 时段）：口径是推断的（单位未实测），**只提示不阻断** ——
 *     这条边界必须锁住，否则 9-14 前会把"推断"当"事实"用（本项目踩过这个坑，见 ERROR.md E23）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateRunAgainstTask,
  formatTaskPeriod,
  parseClock,
  toDurationSeconds,
  toPaceSecPerKm,
} from '../../utils/mp/taskRules.ts'
import type { MpSunrunTask } from '../../src/mp/types.ts'
import { DEMO_TASK } from '../../src/mp/demo.ts'

const makeTask = (overrides: Partial<MpSunrunTask> = {}): MpSunrunTask => ({
  paperName: '测试任务',
  taskId: 'task-1',
  mileage: 3,
  fitDegree: 0.6,
  runPointList: [],
  ...overrides,
})

const itemOf = (result: ReturnType<typeof evaluateRunAgainstTask>, key: string) =>
  result.items.find((item) => item.key === key)!

test('toPaceSecPerKm：>30 视为配速秒、≤30 视为 m/s、支持 M\'SS"', () => {
  assert.equal(toPaceSecPerKm(330), 330)
  assert.equal(Math.round(toPaceSecPerKm(3)!), 333) // 3 m/s ≈ 333 秒/公里
  assert.equal(toPaceSecPerKm(`5'30"`), 330)
  assert.equal(toPaceSecPerKm(undefined), undefined)
  assert.equal(toPaceSecPerKm(0), undefined)
})

test('toDurationSeconds：≤120 视为分钟，>120 视为秒', () => {
  assert.equal(toDurationSeconds(10), 600)
  assert.equal(toDurationSeconds(1200), 1200)
  assert.equal(toDurationSeconds('15'), 900)
  assert.equal(toDurationSeconds(undefined), undefined)
})

test('parseClock：支持 HH:mm:ss 与 HH:mm，非法返回 undefined', () => {
  assert.equal(parseClock('06:00:00'), 21600)
  assert.equal(parseClock('06:00'), 21600)
  assert.equal(parseClock('22:30:15'), 81015)
  assert.equal(parseClock('abc'), undefined)
  assert.equal(parseClock(undefined), undefined)
})

test('里程不足 → hard 不通过，pass=false 且给出原因', () => {
  const result = evaluateRunAgainstTask({ task: makeTask(), km: 2.4, durationSeconds: 900, fitDegree: 0.98 })
  assert.equal(result.pass, false)
  assert.equal(itemOf(result, 'mileage').ok, false)
  assert.equal(result.problems.length, 1)
  assert.match(result.problems[0]!, /里程不足/)
})

test('里程与拟合度都达标 → pass=true', () => {
  const result = evaluateRunAgainstTask({ task: makeTask(), km: 3.02, durationSeconds: 1100, fitDegree: 0.97 })
  assert.equal(result.pass, true)
  assert.equal(result.problems.length, 0)
  assert.equal(itemOf(result, 'mileage').confidence, 'hard')
  assert.equal(itemOf(result, 'fitDegree').confidence, 'hard')
})

test('拟合度不足 → hard 不通过（阈值缺省按 0.6）', () => {
  const result = evaluateRunAgainstTask({
    task: makeTask({ fitDegree: undefined }),
    km: 3.05,
    durationSeconds: 1100,
    fitDegree: 0.42,
  })
  assert.equal(result.pass, false)
  assert.match(itemOf(result, 'fitDegree').detail, /0\.42 \/ 阈值 0\.6/)
})

test('推断项（配速/时长/时段）不阻断 pass —— 单位未实测前只提示', () => {
  const result = evaluateRunAgainstTask({
    task: makeTask({ minSpeed: 3, maxSpeed: 12, minTime: 10, maxTime: 40, startTime: '06:00:00', endTime: '08:00:00' }),
    km: 3,
    durationSeconds: 1000,
    fitDegree: 0.95,
    // 12:00 落在生效时段之外 → window 项为 false，但不应阻断
    now: new Date(2026, 8, 14, 12, 0, 0),
  })
  assert.equal(result.pass, true, '推断项不应阻断')
  assert.equal(itemOf(result, 'window').ok, false)
  assert.equal(itemOf(result, 'window').confidence, 'inferred')
  for (const key of ['pace', 'duration', 'window']) {
    assert.equal(itemOf(result, key).confidence, 'inferred', `${key} 应为推断项`)
  }
})

test('时段规则：命中任一时段即通过', () => {
  const task = makeTask({
    runTimeRuleList: [
      { startTime: '06:00:00', endTime: '08:30:00' },
      { startTime: '16:30:00', endTime: '22:00:00' },
    ],
  })
  const morning = evaluateRunAgainstTask({
    task,
    km: 3,
    durationSeconds: 1000,
    fitDegree: 0.9,
    now: new Date(2026, 8, 14, 7, 30, 0),
  })
  assert.equal(itemOf(morning, 'window').ok, true)

  const evening = evaluateRunAgainstTask({
    task,
    km: 3,
    durationSeconds: 1000,
    fitDegree: 0.9,
    now: new Date(2026, 8, 14, 19, 0, 0),
  })
  assert.equal(itemOf(evening, 'window').ok, true)

  const noon = evaluateRunAgainstTask({
    task,
    km: 3,
    durationSeconds: 1000,
    fitDegree: 0.9,
    now: new Date(2026, 8, 14, 12, 0, 0),
  })
  assert.equal(itemOf(noon, 'window').ok, false)
})

test('配速区间：按小/大归一化，超出上限判 false', () => {
  const task = makeTask({ minSpeed: 3, maxSpeed: 12 })
  // 3 m/s ≈ 333 s/km 为最慢、12 m/s ≈ 83 s/km 为最快
  const normal = evaluateRunAgainstTask({ task, km: 3, durationSeconds: 990, fitDegree: 0.95 })
  assert.equal(itemOf(normal, 'pace').ok, true, '5\'30" 应在区间内')

  const tooSlow = evaluateRunAgainstTask({ task, km: 3, durationSeconds: 1500, fitDegree: 0.95 })
  assert.equal(itemOf(tooSlow, 'pace').ok, false, '8\'20" 应超慢')
})

test('字段缺失的约束项标 info / ok=undefined，不误判', () => {
  const result = evaluateRunAgainstTask({
    task: makeTask({ minSpeed: undefined, maxSpeed: undefined, minTime: undefined, maxTime: undefined }),
    km: 3,
    durationSeconds: 1000,
    fitDegree: 0.9,
  })
  assert.equal(result.pass, true)
  assert.equal(itemOf(result, 'pace').ok, undefined)
  assert.equal(itemOf(result, 'pace').confidence, 'info')
  assert.equal(itemOf(result, 'duration').ok, undefined)
  assert.equal(itemOf(result, 'window').ok, undefined)
})

test('formatTaskPeriod：缺字段用 — 兜底', () => {
  assert.equal(formatTaskPeriod(makeTask({ startDate: '2026-09-14', endDate: '2027-01-10' })), '2026-09-14 ~ 2027-01-10')
  assert.equal(formatTaskPeriod(makeTask()), '— ~ —')
})

test('演示数据自洽：DEMO_TASK + 一次典型 3km（约 16.5 分钟、拟合度 1.00）→ 约束项全部通过', () => {
  // 这条守住 demo 的叙事：跑完默认演示任务应当「各项都绿」，否则页面截图会自相矛盾
  const result = evaluateRunAgainstTask({
    task: DEMO_TASK,
    km: 3,
    durationSeconds: 996, // 5'32"/km
    fitDegree: 1,
    now: new Date(2026, 8, 14, 7, 0, 0), // 落在 06:00-08:30 时段内
  })
  assert.equal(result.pass, true)
  assert.deepEqual(result.problems, [])
  for (const key of ['mileage', 'fitDegree', 'pace', 'duration', 'window']) {
    assert.equal(itemOf(result, key).ok, true, `${key} 应为通过：${itemOf(result, key).detail}`)
  }
})
