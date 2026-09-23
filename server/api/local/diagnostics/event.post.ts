/**
 * `POST /api/local/diagnostics/event` —— 客户端事件**双写服务端**（2026-09-23 新增）
 *
 * ## 为什么要有它（用户原话）
 * 「诊断系统捕获的数据量不全，**用户刷新一下界面我们就丢失数据捕获**」
 * —— 记录窗口、服务端日志、响应原文本来就在服务端（刷新不丢），**只有"客户端操作时间线"原先在页面内存里**。
 * 本端点让每条客户端事件**同时**落一份到服务端日志 ⇒ 自动受**记录窗口过滤** ⇒ 导出包里就有 ⇒ 刷新前的操作也在。
 * 客户端另外还有 localStorage 兜底（连"还没上报就刷新"的那 1~2 秒也不丢），导出时三处按 `id` 去重合并。
 *
 * ## 契约（与 `utils/mp/diagnostics.ts` 的 `checkDiagEvent` 同一份白名单，**不在这里另写一套**）
 * body: `{ events: DiagEvent[] }`
 * - **字段白名单**：`{id, at, level, cat, text, data?}`；`data` **只允许扁平标量**（键数与长度都受限），
 *   嵌套对象/数组**直接丢掉该键**（"不许把整个对象原样透传"）；
 * - `id` 只允许 `[A-Za-z0-9._:-]`（防注入换行/引号/路径）；`level` 必须是 `info|warn|error|gate`；
 * - **脱敏**：落盘前**再走一遍** `redactFreeText()`（同一套判据：凭证样式 / 已知身份 / 自述人名 / 数字兜底），
 *   客户端已经脱过一次，这里是**第二道**（服务端不信任客户端是惯例）；
 * - **限流**：单请求 ≤ `DIAG_EVENT_BATCH_MAX`；每窗口 ≤ `DIAG_EVENT_PER_WINDOW_MAX`（**超限如实拒绝并说明**）；
 * - **只在有活动窗口时接受**：没有窗口 ⇒ `{ ok:false, reason:'no-window' }`（**200 而不是 4xx**，沿用既有约定）；
 * - 落盘形式：`logInfo('ui', 'client-event', { event })` —— 事件本体在 `data.event` 里，导出时按 `cat==='ui'` +
 *   `msg==='client-event'` 反解回来（**解析器只有一处**：`server/utils/diagEvents.ts`）。
 */
import { assertLocalRequest } from '../../../utils/tokenScanState'
import { DIAG_EVENT_PER_WINDOW_MAX, acceptDiagEvents } from '../../../../utils/mp/diagnostics'
import type { DiagEvent } from '../../../../utils/mp/diagnostics'
import { readSession } from '../../../utils/diagSession'
import { logInfo } from '../../../utils/logger'
import { redactFreeText } from '../../../../utils/mp/logFormat'

/**
 * **每窗口条数计数**（进程内存；窗口换掉/进程重启即归零 —— 与窗口同生命周期，不落盘）。
 * 只用于**限流**，不参与任何导出内容（所以丢了也不影响"包里有什么"）。
 */
let countedWindowId = ''
let countedInWindow = 0

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)
  const win = readSession()
  if (win?.id !== countedWindowId) {
    countedWindowId = win?.id ?? ''
    countedInWindow = 0
  }
  const body = (await readBody(event).catch(() => ({}))) as { events?: unknown }
  /**
   * **受理判定走纯函数** `acceptDiagEvents()`（`utils/mp/diagnostics.ts`）——
   * 这样"无窗口 ⇒ `ok:false`（200 而非 4xx）""单请求上限""每窗口上限"这些**都能离线单测**，
   * 端点只负责"读窗口 + 逐个落盘"这两件必须在线做的事。
   */
  const decision = acceptDiagEvents(body?.events, Boolean(win), countedInWindow)
  if (!decision.accepted.length) {
    return {
      ok: false,
      reason: decision.reasons[0] ?? 'rejected',
      accepted: 0,
      rejected: decision.rejected,
      reasons: decision.reasons,
      ...(win ? { windowId: win.id } : {}),
      note: decision.note,
    }
  }
  for (const e of decision.accepted) {
    /**
     * 🔴 **第二道脱敏**（服务端不信任客户端）：文本与 `data` 的字符串值都过 `redactFreeText()`，
     * 与日志/captures/诊断包**同一套判据**（凭证样式 / 已知身份 / 自述人名 / 数字兜底），不另写一份。
     */
    const safeData: DiagEvent['data'] = {}
    if (e.data) {
      for (const [k, v] of Object.entries(e.data)) safeData[redactFreeText(k)] = typeof v === 'string' ? redactFreeText(v) : v
    }
    const safe: DiagEvent = {
      id: e.id,
      at: e.at,
      level: e.level,
      cat: e.cat,
      text: redactFreeText(e.text),
      ...(Object.keys(safeData).length ? { data: safeData } : {}),
    }
    /** 一行一条事件（`data.event` 里带 `id` ⇒ 导出时按 id 与客户端内存/localStorage 去重合并） */
    logInfo('ui', 'client-event', { event: safe, windowId: win!.id })
    countedInWindow++
  }
  /**
   * 超限/被拒时**只记一条 warn**（不重复刷屏），并且它本身就是"这份包缺了事件"的**明证**（manifest 会算进去）。
   */
  if (decision.rejected > 0) {
    logInfo('ui', 'client-event-rejected', {
      windowId: win!.id,
      reasons: decision.reasons,
      rejected: decision.rejected,
      perWindowMax: DIAG_EVENT_PER_WINDOW_MAX,
      countedInWindow,
    })
  }
  return {
    ok: true,
    accepted: decision.accepted.length,
    rejected: decision.rejected,
    ...(decision.reasons.length ? { reasons: decision.reasons } : {}),
    windowId: win!.id,
    countedInWindow,
    perWindowMax: DIAG_EVENT_PER_WINDOW_MAX,
  }
})
