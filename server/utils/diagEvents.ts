/**
 * 从**服务端日志**里反解"客户端事件"（2026-09-23 新增）
 *
 * ## 为什么需要它
 * 客户端事件是**双写**的：一份在浏览器（内存 + localStorage 兜底）、一份由 `POST /api/local/diagnostics/event`
 * 落进**服务端日志**。导出时要把服务端那一份**按记录窗口**捞回来，与客户端三来源按 `id` 去重合并 ——
 * 这样"**刷新前**发生的操作"依然在包里（那正是用户抱怨丢数据的那一段）。
 *
 * ## 解析口径（**只有这一处**，别在别处再写一遍）
 * 事件行的形状由端点决定：`{ cat:'ui', msg:'client-event', data:{ event: DiagEvent, windowId } }`。
 * 判据：`cat === 'ui'` 且 `msg === 'client-event'` 且 `data.event` 看起来像事件（有 id/at/level/cat/text）。
 * **行坏了只跳过并计数**（与日志其它处理一致：绝不因为一行坏 JSON 让导出失败）。
 */
import { checkDiagEvent } from '../../utils/mp/diagnostics'
import type { DiagEvent } from '../../utils/mp/diagnostics'
import { diagLogsLinesInWindow, recentLogFiles } from './diagLogs'
import { DIAG_LOG_DAYS } from '../../utils/mp/diagnostics'

/** 事件日志行的标记（与 `event.post.ts` 里 `logInfo('ui', 'client-event', …)` 逐字对应） */
export const EVENT_LOG_CAT = 'ui'
export const EVENT_LOG_MSG = 'client-event'
const EVENT_REJECT_MSG = 'client-event-rejected'
/** 🆕 心跳日志行的标记（与 `heartbeat.post.ts` 里 `logInfo('ui', 'client-heartbeat', …)` 逐字对应） */
const HEARTBEAT_MSG = 'client-heartbeat'
const HEARTBEAT_REJECT_MSG = 'heartbeat-rejected'

/**
 * 🆕 2026-09-23（用户要求 1️⃣）把**心跳快照**从日志里反解成"时间线事件"。
 *
 * 为什么也要进时间线：心跳是**状态摘要**（"最后一刻是什么样"），维护者筛时间线时应当能一眼看到
 * "崩溃前最后一份心跳长什么样"；只放在日志里就得自己去翻 JSON。
 * 形状：`{id, at, level:'info', cat:'heartbeat', text:'心跳快照（当前内存态摘要）', data:摘要}`
 * （`data` 的键就是 `task.km` / `gate.allow` 这种**扁平带点键**，与上报时一致）。
 */
export function heartbeatFromLine(obj: Record<string, unknown>): DiagEvent | null {
  const at = String(obj.t ?? '')
  const d = (obj.data ?? {}) as Record<string, unknown>
  const hb = (d.heartbeat ?? {}) as Record<string, unknown>
  const id = String(hb.id ?? '')
  if (!id || !Number.isFinite(Date.parse(at))) return null
  const data: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries((hb.data ?? {}) as Record<string, unknown>)) {
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') data[k] = v as string | number | boolean | null
  }
  return { id, at, level: 'info', cat: 'heartbeat', text: '心跳快照（当前内存态摘要）', ...(Object.keys(data).length ? { data } : {}) }
}

/** 解析结果：**服务端那一份事件** + 被限流拒绝的计数（如实进 manifest） */
export interface ServerEventsResult {
  events: DiagEvent[]
  /** 日志里出现过几条"超限被拒"的记录（`rejected` 求和） */
  rejectedByServer: number
  /** 扫过的事件行数（含坏行） */
  scanned: number
  /** 坏行/不合格的条数（跳过并计数，不抛错） */
  skipped: number
  /** 🆕 心跳快照（已反解成时间线事件；来源标 `server`） */
  heartbeats: DiagEvent[]
  /** 🆕 被**每窗口上限**拒掉的心跳条数（>0 ⇒ "最后一刻的状态"可能缺） */
  heartbeatsRejected: number
}

/**
 * 取"窗口内"的服务端事件。
 *
 * @param window 记录窗口的时间区间（`null` ⇒ 不过滤，按最近 `days` 天；与日志同一套兜底）
 */
export function serverEventsInWindow(
  window: { startedAtMs: number; endedAtMs: number } | null,
  days: number = DIAG_LOG_DAYS,
  now: Date = new Date(),
): ServerEventsResult {
  const out: ServerEventsResult = { events: [], rejectedByServer: 0, scanned: 0, skipped: 0, heartbeats: [], heartbeatsRejected: 0 }
  try {
    for (const f of recentLogFiles(days, undefined, undefined, now)) {
      /** 复用"按窗口筛日志行"的判据（左边界容差、右边界严格，与时间线同一口径） */
      const scope = diagLogsLinesInWindow(f.text, window)
      for (const line of scope.text.split('\n')) {
        if (!line.trim()) continue
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line) as Record<string, unknown>
        } catch {
          out.skipped++
          continue
        }
        const msg = String(obj.msg ?? '')
        if (msg === EVENT_REJECT_MSG) {
          out.scanned++
          const d = (obj.data ?? {}) as Record<string, unknown>
          const n = Number(d.rejected ?? 0)
          if (Number.isFinite(n) && n > 0) out.rejectedByServer += n
          continue
        }
        /** 🆕 心跳被限流拒了几条（>0 ⇒ "最后一刻的状态"可能缺，如实记账） */
        if (msg === HEARTBEAT_REJECT_MSG) {
          out.scanned++
          const d = (obj.data ?? {}) as Record<string, unknown>
          const n = Number(d.rejected ?? 0)
          out.heartbeatsRejected += Number.isFinite(n) && n > 0 ? n : 1
          continue
        }
        /** 🆕 心跳快照 ⇒ 反解成时间线事件（`cat:'heartbeat'`） */
        if (msg === HEARTBEAT_MSG) {
          out.scanned++
          const hb = heartbeatFromLine(obj)
          if (hb) out.heartbeats.push(hb)
          else out.skipped++
          continue
        }
        if (String(obj.cat ?? '') !== EVENT_LOG_CAT || msg !== EVENT_LOG_MSG) continue
        out.scanned++
        const d = (obj.data ?? {}) as Record<string, unknown>
        /** ⚠️ 服务端落盘时事件在 `data.event` 里；再走一遍**同一份白名单**（既做类型收敛，也防日志被手改） */
        const parsed = checkDiagEvent(d.event)
        if (!parsed) {
          out.skipped++
          continue
        }
        out.events.push({ ...parsed, source: 'server' })
      }
    }
  } catch {
    /* 目录不存在/读不了 ⇒ 视作"没有服务端事件"（导出照样要能用） */
  }
  return out
}
