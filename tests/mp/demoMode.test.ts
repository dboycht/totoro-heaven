/**
 * 演示模式补齐（2026-11-24）—— 纯数据与判据的回归测试。
 *
 * 盯三件事：
 *   ① 演示数据的**可识别性**（场次号 `demo-` 前缀 / 预设 id `demo-preset-` 前缀）—— 落盘剔除靠它；
 *   ② 数据本身**够用**（轨迹点够多、圈长能量出来、两个月都有记录），否则界面演示不起来；
 *   ③ 研途健行演示任务确实是「未下发线路」形态（判据 `routeRequirementOf().kind === 'free'`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEMO_ARCH_MONTHS,
  DEMO_ARCH_RECORDS,
  DEMO_RECORDS_SEED,
  DEMO_REAL_PATH_RUNS,
  DEMO_SIGN_ARCH,
  DEMO_SIGN_TASK,
  DEMO_TASK,
  DEMO_TASK_YTU,
  demoArchPoints,
} from '../../src/mp/demo.ts'
import { DEMO_SCORE_ID_PREFIX, extractOneLap, isDemoScoreId, pathLengthM } from '../../utils/mp/realPath.ts'
import { DEMO_TRACK_ID_PREFIX, isDemoTrackEntry } from '../../utils/mp/trackLibrary.ts'
import { routeRequirementOf } from '../../utils/mp/taskShape.ts'

test('演示判据：场次号 `demo-` 前缀才算演示，真实场次号不算', () => {
  assert.equal(DEMO_SCORE_ID_PREFIX, 'demo-')
  for (const r of DEMO_REAL_PATH_RUNS) assert.equal(isDemoScoreId(r.scoreId), true, r.scoreId)
  assert.equal(isDemoScoreId('sunrunId202611010901'), false)
  assert.equal(isDemoScoreId(''), false)
  assert.equal(isDemoScoreId(null), false)
  assert.equal(isDemoScoreId(undefined), false)
})

test('演示判据：预设 id 以 `demo-preset-` 开头才算演示条目（落盘剔除的唯一依据）', () => {
  assert.equal(DEMO_TRACK_ID_PREFIX, 'demo-preset-')
  assert.equal(isDemoTrackEntry({ id: 'demo-preset-real-1', lineId: 'demo_line_002' }), true)
  assert.equal(isDemoTrackEntry({ id: 'p-abc-0000001', lineId: 'demo_line_002' }), false)
  // 旧数据没有 id ⇒ 退回 lineId；演示线路的 lineId 不是预设 id，不许误判成演示
  assert.equal(isDemoTrackEntry({ lineId: 'demo_line_001' }), false)
  assert.equal(isDemoTrackEntry(null), false)
})

test('演示真实路径：两条都用整场轨迹（≥200 点、坐标有限），一圈长度量得出来', () => {
  assert.ok(DEMO_REAL_PATH_RUNS.length >= 2, '至少两条才有「随机选一条」')
  for (const run of DEMO_REAL_PATH_RUNS) {
    const pts = run.points
    assert.ok(pts.length >= 200, `${run.scoreId} 点数 ${pts.length}`)
    for (const p of pts) {
      assert.ok(Number.isFinite(p.latitude) && Number.isFinite(p.longitude), '坐标必须有限')
    }
    const total = pathLengthM(pts as { latitude: number; longitude: number }[])
    assert.ok(total > 2500 && total < 4500, `${run.scoreId} 整场 ${Math.round(total)} m 应接近 3.2 km`)
    const lap = extractOneLap(pts as { latitude: number; longitude: number }[], { tolM: 25, minM: 200 })
    assert.ok(lap.length < pts.length, '应切得出一圈（否则预览按整条一色）')
    const lapM = pathLengthM(lap as { latitude: number; longitude: number }[])
    assert.ok(lapM > 330 && lapM < 480, `${run.scoreId} 一圈 ${Math.round(lapM)} m 应接近 400 m`)
  }
})

test('演示归档：两个月都有记录，且每条都读得到轨迹', () => {
  assert.equal(DEMO_ARCH_MONTHS.length, 2)
  for (const m of DEMO_ARCH_MONTHS) {
    const inMonth = DEMO_ARCH_RECORDS.filter((r) => String(r.date).startsWith(m.monthId))
    assert.ok(inMonth.length > 0, `${m.monthId} 这个月至少要有一条演示成绩`)
  }
  for (const r of DEMO_ARCH_RECORDS) {
    assert.ok(isDemoScoreId(r.scoreId))
    assert.ok(demoArchPoints(String(r.scoreId)).length > 100, `${r.scoreId} 要有轨迹`)
  }
  assert.equal(DEMO_ARCH_RECORDS.filter((r) => Number(r.passType) === 0).length, 1, '要有一条"无效"用来演示判定列')
})

test('演示本机记录：四条、全部标 demo（记录页的「提交」列据此显示"演示"）', () => {
  assert.ok(DEMO_RECORDS_SEED.length >= 4)
  for (const r of DEMO_RECORDS_SEED) {
    assert.equal(r.submitState, 'demo')
    assert.ok(isDemoScoreId(String(r.scoreId)))
    assert.ok(String(r.mileage).length > 0)
  }
})

test('研途健行演示任务：`runPointList` 为空（才走"未下发线路"那套界面）', () => {
  assert.equal((DEMO_TASK_YTU.runPointList ?? []).length, 0)
  assert.equal(routeRequirementOf(DEMO_TASK_YTU).kind, 'free')
  assert.equal(routeRequirementOf(DEMO_TASK).kind, 'line')
  // 其余约束与阳光跑演示任务逐字一致，避免"演示两种任务约束不一样"
  assert.equal(DEMO_TASK_YTU.mileage, DEMO_TASK.mileage)
  assert.equal(DEMO_TASK_YTU.fitDegree, DEMO_TASK.fitDegree)
})

test('演示签到：3 个点位、全天窗口、二维码带 DEMO- 前缀（不能拿去提交）', () => {
  assert.equal(DEMO_SIGN_TASK.signPointList.length, 3)
  for (const p of DEMO_SIGN_TASK.signPointList) {
    assert.equal(p.taskId, 'demo-sign-task')
    assert.ok(String(p.pointName).includes('（演示）'))
    assert.ok(String(p.qrCode).startsWith('DEMO-'))
    assert.ok(Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)))
  }
  // 全天窗口：真实窗口（06:00~08:30）之外按钮是灰的，演示时多半点不到"提交"
  assert.equal(DEMO_SIGN_TASK.startTime, '00:00:00')
  assert.equal(DEMO_SIGN_TASK.endTime, '23:59:59')
  // 0/1：今日还没签，否则"提交签到"按钮会因"今日已签满"变灰
  assert.equal(DEMO_SIGN_TASK.dayNeedSignCount, '1')
  assert.equal(DEMO_SIGN_TASK.dayCompSignCount, '0')
  assert.ok(DEMO_SIGN_ARCH.records.length >= 3)
  assert.equal(DEMO_SIGN_ARCH.required, DEMO_SIGN_ARCH.completed + DEMO_SIGN_ARCH.incomplete)
})
