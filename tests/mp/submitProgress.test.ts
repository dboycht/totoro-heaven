/**
 * 提交过程文案的单测（2026-09-21 用户要求"要能看到现在在传什么"）
 *
 * 钉住三件事：
 *  ① **六步齐全且顺序正确**（① 前置检查 → ② 建场次 → ③ 真实等待 → ④ 成绩 → ⑤ 轨迹 → ⑥ 判定）；
 *  ② 每步都写清"在传什么/传了多少"（成绩那步带 km/用时/线路点数；轨迹那步带 GPS 点数）；
 *  ③ 超时分支必须**看得出"不是失败"**（出现"结果未知"，并有"已核实入库"与"无法确认"两种结局）；
 *  ④ 这些字符串会**原样显示在界面上** ⇒ 不许出现 markdown 标记（成对星号 / 反引号）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SUBMIT_PROGRESS, formatDuration, formatSeconds, submitProgressLine } from '../../utils/mp/submitProgress.ts'

/** 所有"会显示给用户"的文案（参数用占位符填一遍） */
const allTexts = (): string[] => [
  SUBMIT_PROGRESS.gate(),
  SUBMIT_PROGRESS.gateBlocked('现在是 23:00，处于夜间停用时段'),
  SUBMIT_PROGRESS.gatePassed(),
  SUBMIT_PROGRESS.begin('东操场', '阳光跑'),
  SUBMIT_PROGRESS.begin('', '自由跑'),
  SUBMIT_PROGRESS.beginOk('sunrunId20260921505'),
  SUBMIT_PROGRESS.beginFail('开跑失败：超时'),
  SUBMIT_PROGRESS.wait(1267, 3.3),
  SUBMIT_PROGRESS.waitDone(),
  SUBMIT_PROGRESS.score(3.3, 21, '00:21:07'),
  SUBMIT_PROGRESS.scoreOk(15404),
  SUBMIT_PROGRESS.scoreTimeout(30000),
  SUBMIT_PROGRESS.scoreVerified(),
  SUBMIT_PROGRESS.scoreUnknown(),
  SUBMIT_PROGRESS.scoreFail('HTTP 500：服务器繁忙'),
  SUBMIT_PROGRESS.detail(1112),
  SUBMIT_PROGRESS.detailOk(820),
  SUBMIT_PROGRESS.detailFail('轨迹提交失败'),
  SUBMIT_PROGRESS.detailSkipped('成绩未成功 → 按源码行为不发轨迹'),
  SUBMIT_PROGRESS.verdict(),
  SUBMIT_PROGRESS.verdictOk('scorePassType=1（有效）'),
  SUBMIT_PROGRESS.verdictNone(),
]

test('六步齐全且顺序为 ①②③④⑤⑥（用户要按步骤看进度）', () => {
  const order = ['①', '②', '③', '④', '⑤', '⑥']
  const texts = allTexts()
  for (const num of order) {
    assert.ok(
      texts.some((t) => t.startsWith(num)),
      `缺少 ${num} 开头的步骤文案`,
    )
  }
  // 步骤编号在"主流程"文案里必须递增出现（gate → begin → wait → score → detail → verdict）
  const mainFlow = [
    SUBMIT_PROGRESS.gate(),
    SUBMIT_PROGRESS.begin('东操场', '阳光跑'),
    SUBMIT_PROGRESS.wait(1267, 3.3),
    SUBMIT_PROGRESS.score(3.3, 21, '00:21:07'),
    SUBMIT_PROGRESS.detail(1112),
    SUBMIT_PROGRESS.verdict(),
  ]
  const idx = mainFlow.map((t) => order.findIndex((n) => t.startsWith(n)))
  assert.deepEqual(idx, [0, 1, 2, 3, 4, 5], `主流程步骤顺序不对：${idx.join(',')}`)
})

test('每步写清"在传什么、传了多少"（成绩带 km/用时/线路点数；轨迹带 GPS 点数）', () => {
  const score = SUBMIT_PROGRESS.score(3.3, 21, '00:21:07')
  assert.ok(score.includes('3.30 km'), score)
  assert.ok(score.includes('00:21:07'), score)
  assert.ok(score.includes('线路点列（21 点）'), score)
  const detail = SUBMIT_PROGRESS.detail(1112)
  assert.ok(detail.includes('1112 点'), detail)
  assert.ok(detail.includes('GPS'), detail)
  assert.ok(SUBMIT_PROGRESS.wait(1267, 3.3).includes('21 分 07 秒'), '等待时长要写成人话')
})

test('超时分支必须看得出"不是失败"：结果未知 → 已核实入库 / 无法确认', () => {
  const timeout = SUBMIT_PROGRESS.scoreTimeout(30000)
  assert.ok(timeout.includes('超时'), timeout)
  assert.ok(timeout.includes('结果未知'), timeout)
  assert.ok(timeout.includes('核实'), timeout)
  assert.ok(!timeout.includes('失败'), '超时不能被写成"失败"（那会诱导用户重试）')
  assert.ok(SUBMIT_PROGRESS.scoreVerified().includes('已入库'), SUBMIT_PROGRESS.scoreVerified())
  const unknown = SUBMIT_PROGRESS.scoreUnknown()
  assert.ok(unknown.includes('请勿立即重复提交'), unknown)
  assert.ok(unknown.includes('查询判定'), unknown)
})

test('格式助手：秒数与时长都写成人话', () => {
  assert.equal(formatSeconds(15404), '15.4 秒')
  assert.equal(formatSeconds(820), '0.8 秒')
  assert.equal(formatDuration(1267), '21 分 07 秒')
  assert.equal(formatDuration(0), '0 分 00 秒')
  assert.equal(formatDuration(-5), '0 分 00 秒')
})

test('这些文案会原样显示在界面上 ⇒ 不得含 markdown 标记（成对星号 / 反引号）', () => {
  for (const t of allTexts()) {
    assert.ok(!/\*\*[^*\n]*\*\*/.test(t), `出现成对星号：${t}`)
    assert.ok(!t.includes('`'), `出现反引号：${t}`)
  }
  const line = submitProgressLine('ok', '④ 成绩已上传', 1700000000000)
  assert.equal(line.kind, 'ok')
  assert.equal(line.at, 1700000000000)
  assert.equal(line.text, '④ 成绩已上传')
})
