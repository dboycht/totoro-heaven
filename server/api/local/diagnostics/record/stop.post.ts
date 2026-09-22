/**
 * `POST /api/local/diagnostics/record/stop` —— **结束记录但不导出**（2026-09-22 新增）
 *
 * 为什么单独有它（而不是"结束并导出"一步到位）：
 *   ① 用户可能只想先停下来（服务端日志不再被"窗口"约束成"仍在增长的一段"），过一会儿再导出；
 *   ② 界面「结束并导出」也走它 —— 先把窗口**封存**（`recording: false` + `endedAt`），
 *      再采集快照、再 POST 导出 ⇒ 导出时窗口区间是**确定**的，不会把"点导出之后"的日志也算进去。
 *
 * 封存后的窗口**仍然保留**（服务端内存 + `diagnostics/session.json`，作为"最近一次"），
 * 所以导出读到的就是这一段区间；再点一次「开始记录」才会被新窗口覆盖。
 * 幂等：没有窗口 ⇒ `{ ok: true, session: null }`；窗口已结束 ⇒ 原样返回（不会把 `endedAt` 冲掉）。
 */
import { assertLocalRequest } from '../../../../utils/tokenScanState'
import { DIAG_INSTANCE_ID, DIAG_INSTANCE_STARTED_MS, sessionElapsedSeconds, stopSession } from '../../../../utils/diagSession'
import { logInfo } from '../../../../utils/logger'

export default defineEventHandler((event) => {
  assertLocalRequest(event)
  const session = stopSession()
  logInfo('ui', '结束诊断记录（服务端记录窗口已封存，等待导出）', {
    windowId: session?.id ?? '',
    instanceId: session?.instanceId ?? DIAG_INSTANCE_ID,
    elapsedSeconds: sessionElapsedSeconds(session),
    endedAt: session?.endedAt ?? '',
  })
  return { ok: true, session, serverInstance: { instanceId: DIAG_INSTANCE_ID, startedAtMs: DIAG_INSTANCE_STARTED_MS, pid: process.pid } }
})
