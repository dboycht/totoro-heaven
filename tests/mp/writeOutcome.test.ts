/**
 * 写操作"结果未知"判定的单测（2026-09-21 修 GitHub issue #11）
 *
 * 为什么值得钉住：这条判据一旦写反，代价是**用户的成绩被重复录入**（比"缺轨迹"严重得多）。
 * 四种结局必须严格对应，尤其：**超时 + 核实不到 ≠ 确定失败**（只能说"未知"，且不许诱导重试）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyWriteOutcome, isStaleSettlement, outcomeIsSuccess, writeOutcomeMessage } from '../../utils/mp/writeOutcome.ts'
import { MP_READ_TIMEOUT_MS, MP_WRITE_TIMEOUT_MS, isTimeoutError, timeoutForMethod } from '../../src/wrappers/MpApiWrapper.ts'

/**
 * 超时口径的"钉子"（2026-09-21）：把实测数据钉进单测，防止有人把写超时改回 15 秒。
 * 实测：厂商 `sunRunExercises` 正常耗时 14.8 s（09-18 我们）/ **15.404 s**（09-21 用户日志 `ms:15404`）。
 */
test('超时口径：写 ≥ 30s 且必须大于上游实测最慢（15404 ms）；读 15s；GET/POST 分别取值', () => {
  assert.equal(timeoutForMethod('GET'), MP_READ_TIMEOUT_MS)
  assert.equal(timeoutForMethod('POST'), MP_WRITE_TIMEOUT_MS)
  assert.ok(MP_WRITE_TIMEOUT_MS > 15404, `写超时必须大于实测最慢 15404 ms，当前 ${MP_WRITE_TIMEOUT_MS}`)
  assert.ok(MP_WRITE_TIMEOUT_MS >= MP_READ_TIMEOUT_MS * 2, '写超时至少是读的两倍')
})

test('isTimeoutError：认出 ky 的 TimeoutError 与 ETIMEDOUT，不误伤其它错误', () => {
  assert.equal(isTimeoutError({ name: 'TimeoutError' }), true)
  assert.equal(isTimeoutError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), true)
  assert.equal(isTimeoutError(new Error('boom')), false)
  assert.equal(isTimeoutError({ name: 'AbortError' }), false, 'AbortError 语义是"被取消"，不是超时')
  assert.equal(isTimeoutError(null), false)
  assert.equal(isTimeoutError(undefined), false)
  assert.equal(isTimeoutError('TimeoutError'), false)
})

test('classifyWriteOutcome：成功就是成功，超时且未核实到就是"未知"（不是失败）', () => {
  assert.equal(classifyWriteOutcome({ ok: true }, null), 'ok')
  assert.equal(classifyWriteOutcome({ ok: true, timedOut: true }, null), 'ok', '拿到了响应就不看 timedOut')
  assert.equal(classifyWriteOutcome({ ok: false, timedOut: true }, true), 'timeout-landed')
  assert.equal(classifyWriteOutcome({ ok: false, timedOut: true }, false), 'timeout-unknown')
  assert.equal(classifyWriteOutcome({ ok: false, timedOut: true }, null), 'timeout-unknown', '没能核实也算未知')
  assert.equal(classifyWriteOutcome({ ok: false }, true), 'failed', '非超时的失败就是失败（核实到有记录也不改口）')
  assert.equal(classifyWriteOutcome({ ok: false }, null), 'failed')
})

test('outcomeIsSuccess：只有 ok 与"超时但已核实入库"算成功（决定要不要补交轨迹明细）', () => {
  assert.equal(outcomeIsSuccess('ok'), true)
  assert.equal(outcomeIsSuccess('timeout-landed'), true)
  assert.equal(outcomeIsSuccess('timeout-unknown'), false)
  assert.equal(outcomeIsSuccess('failed'), false)
})

test('writeOutcomeMessage：未知态必须提示"别急着重试"，且带上原始错误', () => {
  assert.equal(writeOutcomeMessage('ok'), '', '成功态沿用原文案')
  const landed = writeOutcomeMessage('timeout-landed')
  assert.ok(landed.includes('已入库') && landed.includes('补交'), landed)
  const unknown = writeOutcomeMessage('timeout-unknown', '请求超时：30 秒内未收到响应')
  assert.ok(unknown.includes('结果未知'), unknown)
  assert.ok(unknown.includes('请勿立即重复提交'), unknown)
  assert.ok(unknown.includes('查询判定'), unknown)
  assert.ok(unknown.includes('请求超时：30 秒内未收到响应'), unknown)
  assert.equal(writeOutcomeMessage('failed'), '提交失败', '无原始信息时给兜底文案')
  assert.equal(writeOutcomeMessage('failed', 'HTTP 500：服务器繁忙'), 'HTTP 500：服务器繁忙')
})

/**
 * 冗余加固（2026-09-21，审计 B4）：**"上一笔结算"不许当成当前任务的成绩提交**。
 * 判据：结算时刻必须晚于"本次任务读取时刻"；任一侧缺失（0）时不判陈旧（避免误伤）。
 */
test('isStaleSettlement：结算早于本次任务读取 ⇒ 陈旧（禁止提交）', () => {
  const loaded = 1_700_000_000_000
  assert.equal(isStaleSettlement(loaded - 60_000, loaded), true, '演示/上一任务的结算早于本次读取 ⇒ 陈旧')
  assert.equal(isStaleSettlement(loaded + 1, loaded), false, '本次任务内跑完再结算 ⇒ 不陈旧')
  assert.equal(isStaleSettlement(loaded, loaded), false, '同一毫秒不算陈旧（边界取"早于"）')
  // 任一侧缺失（还没读取任务 / 旧数据没有该字段）⇒ 不判陈旧，避免误伤
  assert.equal(isStaleSettlement(0, loaded), false)
  assert.equal(isStaleSettlement(loaded - 60_000, 0), false)
  assert.equal(isStaleSettlement(0, 0), false)
})
