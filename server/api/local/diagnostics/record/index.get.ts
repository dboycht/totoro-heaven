/**
 * `GET /api/local/diagnostics/record` —— 读「这一次诊断记录」的**当前状态**（2026-09-22 新增）
 *
 * ## 为什么要有它（issue #12 的原始症状）
 * 用户的抱怨是"刷新为什么会丢？"—— 旧实现的记录状态在**浏览器内存**里，刷新就归零；
 * 现在窗口由服务端持有（`server/utils/diagSession.ts`，绑定**当前运行的实例**），
 * 界面**刷新后靠本接口恢复**"正在记录 + 已记录多久"（时长按服务端 `startedAt` 补算，不归零）。
 *
 * 响应（结构与 `utils/mp/diagnostics.ts` 的 `DiagRecordState` 对齐）：
 * ```json
 * { "window": { "id": "w-…", "recording": true, "startedAt": "…", … } | null,
 *   "elapsedSeconds": 123,
 *   "serverInstance": { "instanceId": "…", "startedAtMs": 0, "pid": 1234 } }
 * ```
 * `window: null` = 这一次运行还没点过「开始记录」（**关掉程序再启动就是这个状态**，不继承上次的窗口）。
 *
 * ⚠️ 接口**只返回 id / 时间 / 开关**，不返回也不接受任何身份或凭证字段（窗口里本来就没有）。
 */
import { assertLocalRequest } from '../../../../utils/tokenScanState'
import { DIAG_INSTANCE_ID, DIAG_INSTANCE_STARTED_MS, readSession, sessionElapsedSeconds } from '../../../../utils/diagSession'

export default defineEventHandler((event) => {
  assertLocalRequest(event)
  const win = readSession()
  return {
    window: win,
    elapsedSeconds: sessionElapsedSeconds(win),
    serverInstance: { instanceId: DIAG_INSTANCE_ID, startedAtMs: DIAG_INSTANCE_STARTED_MS, pid: process.pid },
  }
})
