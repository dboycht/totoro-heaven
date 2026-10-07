/**
 * `GET /api/local/run/submit/status` —— **轮询提交作业的进度**（前端只做展示；2026-10-07 用户要求）
 *
 * 返回的 `job` 就是 `server/utils/runSubmitJob.ts` 的单例状态视图：
 * 阶段 / 进度清单 / 剩余秒数 / 结果。**不含 token、不含报文**（作业结束即丢输入）。
 * 页面刷新或被关掉再打开，也可以靠它**重新接上**正在跑的作业（进度与倒计时照旧显示）。
 */
import { assertLocalRequest } from '../../../../utils/tokenScanState'
import { getRunSubmitJobView, isDryRun } from '../../../../utils/runSubmitJob'

export default defineEventHandler((event) => {
  assertLocalRequest(event)
  return {
    ok: true,
    job: getRunSubmitJobView(),
    /**
     * 🔒 **安全闸**：把"当前是不是演练模式"一并告诉调用方。
     * 探针据此**拒绝在非演练模式下发起作业**（否则一次误触就是往真实账号写成绩）。
     */
    dryRun: isDryRun(),
  }
})
