/**
 * `POST /api/local/run/submit/abort` —— **中途叫停**当前提交作业（2026-10-08 用户要求）
 *
 * 接 `防 kill` 重构的第二个边界：作业在服务端跑着（默认要等几十分钟），
 * 用户想放弃时得有个**真的能停**的入口 —— 此前只有「清空本机数据」，
 * 而它只停界面展示、作业**仍在服务端跑**（会照样提交）。
 *
 * ⚠️ **保守口径**（见 `abortRunSubmitJob` 的说明）：只在"**还没发出任何写请求**"的阶段允许
 * （`waiting` / `suspended`）。一旦进入 `scoring`（成绩请求可能已在路上），
 * **明确拒绝**并说明原因 —— 那时打断只会留下"成绩在、轨迹没发"的半成品（`ERROR.md` E71）。
 *
 * 🔒 本端点**不向服务端发任何请求**（也就无从"取消"厂商那边的场次）；它只清本机这一笔的状态。
 */
import { assertLocalRequest } from '../../../../utils/tokenScanState'
import { abortRunSubmitJob } from '../../../../utils/runSubmitJob'
import { logInfo, logWarn } from '../../../../utils/logger'

export default defineEventHandler((event) => {
  assertLocalRequest(event)
  const out = abortRunSubmitJob()
  if (out.ok) {
    logInfo('run', '已按用户要求叫停提交作业（未发送任何写请求）', { phase: out.phase })
  } else {
    logWarn('run', `拒绝叫停提交作业：${out.message}`, { phase: out.phase })
  }
  return out
})
