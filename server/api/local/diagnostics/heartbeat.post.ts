/**
 * `POST /api/local/diagnostics/heartbeat` —— **心跳快照**（2026-09-23 新增，用户要求 1️⃣）
 *
 * ## 为什么要有它（用户总要求："每一个重要的地方都要记录"）
 * 事件流只记"**发生了一件事**"；而用户可能**页面崩了 / 断电 / 直接关掉程序** ——
 * 那时日志里最后一条事件之前的**状态**（读到什么任务、选了哪条路径、门禁怎么判、库里有几条几何）
 * 就完全看不到了。心跳把这些**当前内存态摘要**定期（30~60 秒）+ **每次关键操作后**落一份
 * ⇒ 我们**仍能看到"最后一刻的状态"**。
 *
 * ## 与事件端点的关系
 * 两者**同源同脱敏**（都过 `redactFreeText()`），但**分开**：心跳是"此刻是什么样"、语义与限流口径不同
 * （心跳被限流是正常的，不该让人以为"丢了操作"）。心跳**只接受一份摘要对象**（不是数组）：
 * `{ at, page, ...状态摘要 }` —— 字段**深白名单 + 扁平标量**（与事件同一套 `data` 判据）。
 *
 * ## 与事件端点一致的约定
 * - `assertLocalRequest(event)`；**没有活动窗口 ⇒ 200 + `ok:false` + `no-window`**（不抛 4xx）；
 * - **每窗口上限** `DIAG_HEARTBEAT_PER_WINDOW_MAX`（超出如实拒绝并记一条 `heartbeat-rejected`）；
 * - 落盘 `logInfo('ui','client-heartbeat',{heartbeat, windowId})` ⇒ 自动受**记录窗口过滤** ⇒ 进包。
 */
import { assertLocalRequest } from '../../../utils/tokenScanState'
import { DIAG_HEARTBEAT_PER_WINDOW_MAX, checkDiagEvent } from '../../../../utils/mp/diagnostics'
import { readSession } from '../../../utils/diagSession'
import { logInfo } from '../../../utils/logger'
import { redactFreeText } from '../../../../utils/mp/logFormat'

/** 每窗口心跳计数（进程内存；与窗口同生命周期，只用于限流） */
let hbWindowId = ''
let hbCounted = 0

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)
  const win = readSession()
  if (win?.id !== hbWindowId) {
    hbWindowId = win?.id ?? ''
    hbCounted = 0
  }
  if (!win) {
    return { ok: false, reason: 'no-window', accepted: 0, note: '本次运行没有活动中的记录窗口（先点「开始记录」再复现问题）' }
  }
  const body = (await readBody(event).catch(() => ({}))) as { heartbeat?: unknown }
  /**
   * 🔒 **复用事件的白名单**（`checkDiagEvent`）：心跳**自带 id**（客户端生成）⇒ 直接借它的校验，
   * `cat` 固定写 `'heartbeat'`、`text` 固定写一句人话、状态摘要整个塞进 `data`。
   * 这样"字段白名单 / 扁平标量 / 长度上限"**只有一份实现**，不另写。
   */
  const hb = body?.heartbeat as Record<string, unknown> | undefined
  const checked = checkDiagEvent({
    id: hb?.id,
    at: hb?.at,
    level: 'info',
    cat: 'heartbeat',
    text: '心跳快照（当前内存态摘要）',
    data: hb?.data,
  })
  if (!checked) {
    return { ok: false, reason: 'bad-payload', accepted: 0, windowId: win.id, note: '心跳摘要不符合字段白名单（{id, at, data:{扁平标量}}）' }
  }
  if (hbCounted >= DIAG_HEARTBEAT_PER_WINDOW_MAX) {
    logInfo('ui', 'heartbeat-rejected', { windowId: win.id, reason: 'over-window-max', perWindowMax: DIAG_HEARTBEAT_PER_WINDOW_MAX, countedInWindow: hbCounted })
    return { ok: false, reason: 'over-window-max', accepted: 0, rejected: 1, windowId: win.id, countedInWindow: hbCounted, perWindowMax: DIAG_HEARTBEAT_PER_WINDOW_MAX }
  }
  /** 第二道脱敏（服务端不信任客户端）：键名与字符串值都过 `redactFreeText()`（与日志/captures 同一套） */
  const safeData: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(checked.data ?? {})) safeData[redactFreeText(k)] = typeof v === 'string' ? redactFreeText(v) : v
  logInfo('ui', 'client-heartbeat', {
    heartbeat: { id: checked.id, at: checked.at, ...(Object.keys(safeData).length ? { data: safeData } : {}) },
    windowId: win.id,
  })
  hbCounted++
  return { ok: true, accepted: 1, rejected: 0, windowId: win.id, countedInWindow: hbCounted, perWindowMax: DIAG_HEARTBEAT_PER_WINDOW_MAX }
})
