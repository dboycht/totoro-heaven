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

test("toPaceSecPerKm：数字按【时速 km/h】换算（实测口径），支持 M'SS\" 直读", () => {
  // ✅ 2026-09-14 实测：任务下发 minSpeed:"3" / maxSpeed:"15"，字段名 minSpeedHour/maxSpeedHour ⇒ km/h
  assert.equal(toPaceSecPerKm(15), 240) // 15 km/h = 4'00"/km
  assert.equal(toPaceSecPerKm(3), 1200) // 3 km/h = 20'00"/km
  assert.equal(toPaceSecPerKm('12'), 300) // 12 km/h = 5'00"/km
  assert.equal(toPaceSecPerKm(`5'30"`), 330) // 配速字符串原样解析
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

/**
 * ⚠️ 2026-09-22 改写（issue #12）：**服务端未下发 `fitDegree` ⇒ 本任务不判拟合度**。
 *
 * 旧实现 `Number(task.fitDegree ?? 0.6)` 会**自己造出一个服务端没提的要求**：自检表里凭空多一条
 * "拟合度不达标"的硬性失败（甚至会拦住提交）。而"没下发"的正确含义是**我们无从判定**。
 * 新判据来自纯函数 `fitRequirementOf()`（`utils/mp/taskShape.ts`）：
 * 缺失 / null / 空串 / 非数字 / ≤0 ⇒ `skipped: true` + `ok: true` + `confidence: 'info'`（不进 pass）。
 */
test('拟合度：服务端未下发阈值（fitDegree 缺失）⇒ 只提示、不判失败、不进 pass', () => {
  const result = evaluateRunAgainstTask({
    task: makeTask({ fitDegree: undefined }),
    km: 3.05,
    durationSeconds: 1100,
    // ⚠️ 这个值若还按历史兜底 0.6 判就会失败 —— 正是本条要防的回归
    fitDegree: 0.42,
  })
  const item = itemOf(result, 'fitDegree')
  assert.equal(result.pass, true, '未下发阈值时不得因拟合度判失败')
  assert.deepEqual(result.problems, [], '不得写进 problems（否则会被当成硬性不通过）')
  assert.equal(item.ok, true, 'ok 必须是 true（不是 false，也不是 undefined）')
  assert.equal(item.skipped, true, '必须带 skipped 标记 —— 界面据此显示成"提示"而不是"通过/失败"')
  assert.equal(item.confidence, 'info', '不参与 pass（pass 只统计 hard 项）')
  assert.match(item.detail, /服务端未下发拟合度阈值/)
  assert.doesNotMatch(item.detail, /阈值 0\.6/, '不得再出现历史兜底 0.6')
})

test('拟合度：阈值 0 / 非数字 / 空串 同样按"未下发"处理（只提示，不判失败）', () => {
  for (const v of [0, '0', 'abc', '']) {
    const result = evaluateRunAgainstTask({
      task: makeTask({ fitDegree: v }),
      km: 3.05,
      durationSeconds: 1100,
      fitDegree: 0.1,
    })
    const item = itemOf(result, 'fitDegree')
    assert.equal(result.pass, true, `fitDegree=${JSON.stringify(v)} 时不该判失败`)
    assert.equal(item.skipped, true, `fitDegree=${JSON.stringify(v)} 时该是提示项`)
    assert.equal(item.ok, true)
  }
})

test('拟合度：服务端**下发了**阈值 ⇒ 行为与旧版逐字一致（照阈值判 hard）', () => {
  const low = evaluateRunAgainstTask({
    task: makeTask({ fitDegree: 0.6 }),
    km: 3.05,
    durationSeconds: 1100,
    fitDegree: 0.42,
  })
  assert.equal(low.pass, false)
  assert.equal(itemOf(low, 'fitDegree').ok, false)
  assert.equal(itemOf(low, 'fitDegree').skipped, undefined, '有阈值时不得带 skipped 标记')
  assert.equal(itemOf(low, 'fitDegree').confidence, 'hard')
  assert.match(itemOf(low, 'fitDegree').detail, /0\.42 \/ 阈值 0\.6/)

  const ok = evaluateRunAgainstTask({
    task: makeTask({ fitDegree: 0.6 }),
    km: 3.05,
    durationSeconds: 1100,
    fitDegree: 0.97,
  })
  assert.equal(ok.pass, true)
  assert.equal(itemOf(ok, 'fitDegree').ok, true)
  assert.equal(itemOf(ok, 'fitDegree').confidence, 'hard')
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

test('配速区间：按小/大归一化（km/h → 秒/公里），超出区间判 false', () => {
  const task = makeTask({ minSpeed: 3, maxSpeed: 15 })
  // 15 km/h = 4'00"/km（最快）~ 3 km/h = 20'00"/km（最慢）
  const normal = evaluateRunAgainstTask({ task, km: 3.2, durationSeconds: 1060, fitDegree: 0.95 })
  assert.equal(itemOf(normal, 'pace').ok, true, '5\'31"/km 应在区间内')

  const tooSlow = evaluateRunAgainstTask({ task, km: 3.2, durationSeconds: 4400, fitDegree: 0.95 })
  assert.equal(itemOf(tooSlow, 'pace').ok, false, '22\'55"/km 应超慢（>20\'00"）')

  const tooFast = evaluateRunAgainstTask({ task, km: 3.2, durationSeconds: 700, fitDegree: 0.95 })
  assert.equal(itemOf(tooFast, 'pace').ok, false, '3\'39"/km 应超快（<4\'00"）')
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

test('演示数据自洽：DEMO_TASK（已对齐 9-14 实测值）+ 一次典型 3.2km → 约束项全部通过', () => {
  // 这条守住 demo 的叙事：跑完默认演示任务应当「各项都绿」，否则页面截图会自相矛盾
  const result = evaluateRunAgainstTask({
    task: DEMO_TASK,
    km: 3.2,
    durationSeconds: 1060, // 5'31"/km
    fitDegree: 1,
    now: new Date(2026, 8, 14, 7, 0, 0), // 落在 06:00-23:00 时段内
  })
  assert.equal(result.pass, true)
  assert.deepEqual(result.problems, [])
  for (const key of ['mileage', 'fitDegree', 'pace', 'duration', 'window']) {
    assert.equal(itemOf(result, key).ok, true, `${key} 应为通过：${itemOf(result, key).detail}`)
  }
})
