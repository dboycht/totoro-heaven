/**
 * 写操作"结果未知"的判定与措辞（纯函数，可离线单测）—— 2026-09-21 修 GitHub issue #11
 *
 * **实测背景**（作者提供的服务端日志原文）：
 * ```
 * POST /wxxcx/sunrun/sunRunExercises  http:200  ms:15404
 *   upstream: {"status":"00","code":"0","message":"提交成功"}
 *   body:     {"scantronId":"sunrunId20260921505","km":"3.30","usedTime":"00:21:07"}
 * ```
 * 厂商回了 **提交成功**、本地代理耗时 **15404 ms**，而客户端超时上限是 **15000 ms**
 * ⇒ 浏览器只比真实响应早放弃 **404 毫秒**。结果：界面报"提交失败"、**轨迹明细被跳过**，
 * 但成绩其实已经入库 ⇒ 用户看到的就是 issue 标题那两个字的感受（"假报错"）。
 *
 * **判据（可执行）**：**超时 ≠ 失败**。
 * 超时只说明"没等到响应"，必须去服务端**核实**（`getSunrunArch` 按 `scantronId` 查归档）才能定性：
 *   · 核实到已入库 ⇒ 按成功继续（并补交轨迹明细，把缺掉的那一步补上）；
 *   · 核实不到     ⇒ 只能说"**结果未知**"，并明确"**请勿立即重复提交**"。
 * 绝不要把超时当成"确定失败"：那会诱导用户重试，而**重复提交会多录一条成绩**（比缺轨迹严重得多）。
 */
export type WriteOutcome = 'ok' | 'timeout-landed' | 'timeout-unknown' | 'failed'

/**
 * 把"一次写调用的结果 + 核实结果"归成四种结局。
 *
 * @param call  写调用本身的判定（`ok` / `timedOut`）
 * @param landed 核实结果：`true` = 服务端归档里找到了这条；`false`/`null` = 没找到或没能核实
 */
export function classifyWriteOutcome(call: { ok: boolean; timedOut?: boolean }, landed: boolean | null): WriteOutcome {
  if (call.ok) return 'ok'
  if (!call.timedOut) return 'failed'
  return landed ? 'timeout-landed' : 'timeout-unknown'
}

/** 是否应当"按成功继续"（决定要不要继续提交轨迹明细） */
export const outcomeIsSuccess = (outcome: WriteOutcome): boolean => outcome === 'ok' || outcome === 'timeout-landed'

/**
 * ⚠️ 2026-09-21（冗余加固，审计 B4）：**这笔结算是不是"上一个任务/演示数据"留下的？**
 *
 * 场景：`applyToRunner()` 换任务时只换 `task`/线路、**不清 `run`** ⇒ 从"演示数据跑完"切到
 * "读取真实任务"后，旧结算还挂着且 `run.status === 'finished'` ⇒ 原判据允许把**旧轨迹**
 * 配**当前任务的 taskId** 提交（服务端会多一条来路不明的成绩）。
 *
 * 判据（可执行）：**结算时刻必须晚于"本次任务读取时刻"**；任一侧缺失（0）时**不判定为陈旧**
 * （避免误伤"任务还没读取"或"旧版本没有这个字段"的情况）。
 */
export function isStaleSettlement(settledAtMs: number, loadedAtMs: number): boolean {
  const settled = Number(settledAtMs)
  const loaded = Number(loadedAtMs)
  return settled > 0 && loaded > 0 && settled < loaded
}

/** 结局对应的用户可见措辞（`ok` 返回空串，表示"用原来的成功文案"） */
export function writeOutcomeMessage(outcome: WriteOutcome, rawMessage = ''): string {
  switch (outcome) {
    case 'ok':
      return ''
    case 'timeout-landed':
      return '首次请求超时，但已在服务端核实到本次成绩已入库 —— 已按成功处理并补交轨迹明细'
    case 'timeout-unknown':
      return (
        '提交结果未知：请求超时，且服务端归档里暂时查不到这条。' +
        '请勿立即重复提交（可能多录一条成绩）——稍后在「跑步」页点「查询判定」核实；' +
        (rawMessage ? `原始错误：${rawMessage}` : '')
      )
    case 'failed':
      return rawMessage || '提交失败'
  }
}
