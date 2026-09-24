/**
 * 「提交前置上下文校验」+「任务号兜底链」的单测（2026-09-23，pre3 实测事故）
 *
 * ## 现场（用户诊断包的铁证）
 * 研究生院「研途健行」2.4 km、`runPointList=[]`（自由路线任务）：
 * ```
 * 11:59:37.487 [info/submit]  用户确认真实提交
 * 11:59:37.488 [gate/blocked] 真实提交被拦：缺少真实会话/档案/任务（或没有可提交的线路/任务号）
 * 写请求：getRunBegin 0 / sunRunExercises 0 / sunRunExercisesDetail 0   ⇒ 一个都没发出去
 * ```
 * 门禁（`allow=true`）已经放行了，卡在**提交前那处内联校验**：
 * `(!freeRun && !lineRequired && !input.line && !paperId)`，而 `paperId` 只取 `task.taskId` ——
 * 他这份任务响应**顶层没有 `taskId`**（只有 `id` / `paperId`）⇒ 空串 ⇒ 必被拒。
 *
 * ## 本文件钉住（两个方向都钉，防改回）
 *   ① 自由路线任务 + 有会话 + 有任务（**故意不带 `taskId`**）⇒ `ok:true` 且 `paperId` = 任务号；
 *   ② 缺任务 / 任务号三者皆空 / 没会话 ⇒ 仍拦，且提示**指路**（"工作台…读取真实账号与任务"）；
 *   ③ 线条目任务零回归：指定了线路却没选 ⇒ 拦；选了 ⇒ 放行；
 *   ④ 自由跑（`runType=1`）照旧不需要任务/线路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskPaperIdOf } from '../../utils/mp/taskShape.ts'
import { evaluateSubmitContext } from '../../utils/mp/submitContext.ts'

/** 🔴 **他这份响应的真实形态**：顶层只有 `id` / `paperId` / `paperName` / `mileage` / `runPointList`，**没有 `taskId`** */
const HIS_TASK = {
  id: 'sunrunTaskPaper-20260923000001',
  paperId: 'sunrunTaskPaper-20260923000001',
  paperName: '研途健行',
  mileage: 2.4,
  fitDegree: 0.6,
  runPointList: [],
}
const LINE_TASK = { ...HIS_TASK, runPointList: [{ pointId: 'L1', pointName: '西操场', pointList: [] }] }
const LINE = { pointId: 'L1', pointName: '西操场', pointList: [] }
const session = { token: 'gho_PROBEtoken0123456789', hasProfile: true, runType: 0 as const }

test('taskPaperIdOf：兜底链 `taskId → paperId → id`，空串当作"没给"继续往后兜', () => {
  assert.equal(taskPaperIdOf(HIS_TASK), 'sunrunTaskPaper-20260923000001', '他这份只有 id/paperId ⇒ 必须兜到')
  assert.equal(taskPaperIdOf({ taskId: 'T-1', paperId: 'P-1', id: 'I-1' }), 'T-1', '三个都有时 taskId 优先（内部口径）')
  assert.equal(taskPaperIdOf({ taskId: '', paperId: 'P-1' }), 'P-1', '空串不算"给了"（`??` 不会跳空串，所以这里用"取非空"）')
  assert.equal(taskPaperIdOf({ paperId: '  P-2  ' }), 'P-2', '两侧空白要剪掉')
  assert.equal(taskPaperIdOf({ id: 12345 }), '12345', '数字型 id 也认（转成字符串）')
  assert.equal(taskPaperIdOf({}), '')
  assert.equal(taskPaperIdOf(null), '')
  assert.equal(taskPaperIdOf(undefined), '')
  assert.equal(taskPaperIdOf({ taskId: { nested: true } }), '', '对象/数组不当任务号')
})

test('🔴 自由路线任务 + 有会话 + 有任务（**没有 `taskId`**）⇒ 必须放行，且任务号走兜底链', () => {
  const r = evaluateSubmitContext({ ...session, task: HIS_TASK, lineRequired: false, line: null })
  assert.equal(r.ok, true, '这正是用户卡的现场：不许再因为"没有线路"拦他')
  assert.equal(r.reasonCode, 'ok')
  assert.equal(r.message, '')
  assert.equal(r.paperId, 'sunrunTaskPaper-20260923000001', '任务号必须兜到 paperId/id ⇒ 报文里 paperId 非空')
  // 调用方显式给了任务号 ⇒ 用调用方的（但仍要非空）
  assert.equal(evaluateSubmitContext({ ...session, task: HIS_TASK, lineRequired: false, paperId: 'EXPLICIT-1' }).paperId, 'EXPLICIT-1')
  // 调用方给的是**空串** ⇒ 继续兜底（老代码 `input.paperId ?? taskId` 在这里就会取到空串 ✗）
  assert.equal(evaluateSubmitContext({ ...session, task: HIS_TASK, lineRequired: false, paperId: '' }).paperId, 'sunrunTaskPaper-20260923000001')
})

test('自由路线任务：缺任务 / 任务号三者皆空 ⇒ 仍拦，且提示**指路**（不是笼统"缺少…"）', () => {
  const noTask = evaluateSubmitContext({ ...session, task: null, lineRequired: false, line: null })
  assert.equal(noTask.ok, false)
  assert.equal(noTask.reasonCode, 'no-task')
  assert.match(noTask.message, /工作台/)
  assert.match(noTask.message, /读取真实账号与任务/)

  const noId = evaluateSubmitContext({ ...session, task: { paperName: '研途健行', runPointList: [] }, lineRequired: false })
  assert.equal(noId.ok, false, '连 id/paperId 都没有 ⇒ 报文无从归属，必须拦')
  assert.equal(noId.reasonCode, 'no-task-id')
  assert.match(noId.message, /taskId \/ paperId \/ id/)
  assert.match(noId.message, /工作台/)
})

test('会话/档案缺失 ⇒ 拦（两种跑法都一样），提示指路', () => {
  for (const input of [
    { ...session, token: '', task: HIS_TASK, lineRequired: false },
    { ...session, hasProfile: false, task: HIS_TASK, lineRequired: false },
    { token: null, hasProfile: true, runType: 0 as const, task: HIS_TASK },
  ]) {
    const r = evaluateSubmitContext(input)
    assert.equal(r.ok, false, JSON.stringify(input))
    assert.equal(r.reasonCode, 'no-session')
    assert.match(r.message, /工作台/)
  }
})

test('线条目任务**零回归**：指定了线路却没选 ⇒ 拦；选了 ⇒ 放行', () => {
  const noLine = evaluateSubmitContext({ ...session, task: LINE_TASK, lineRequired: true, line: null })
  assert.equal(noLine.ok, false, '老行为：指定了线路就必须选到')
  assert.equal(noLine.reasonCode, 'no-line')
  assert.match(noLine.message, /线路/)
  assert.match(noLine.message, /工作台|选一条/, '要告诉用户下一步做什么')

  const ok = evaluateSubmitContext({ ...session, task: LINE_TASK, lineRequired: true, line: LINE })
  assert.equal(ok.ok, true)
  assert.equal(ok.paperId, LINE_TASK.id, '任务号照样兜底（有线路时被报文构造器忽略，但别丢）')
  // ⚠️ 零回归细节：**有线路**时任务对象没有任务号也必须放行（报文取 `line.taskId`，提交构造器的既有口径）
  const lineWithoutTaskId = evaluateSubmitContext({
    ...session,
    task: { paperName: '只有线路没任务号', runPointList: [LINE] },
    lineRequired: true,
    line: { ...LINE, taskId: 'LINE-TASK-1' },
  })
  assert.equal(lineWithoutTaskId.ok, true, '有线路可提供 taskId ⇒ 不许因为"任务对象没任务号"拦（老行为）')
  assert.equal(lineWithoutTaskId.paperId, '')
})

test('自由跑（runType=1）：厂商口径不取线路、不带任务号 ⇒ 有会话+档案就放行（没有任务也放行）', () => {
  const r = evaluateSubmitContext({ token: 'gho_x', hasProfile: true, runType: 1, task: null, line: null })
  assert.equal(r.ok, true)
  assert.equal(r.reasonCode, 'ok')
})