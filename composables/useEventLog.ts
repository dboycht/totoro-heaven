/**
 * 前端「事件日志」：记录界面上每一步做了什么，方便事后查（用户 2026-09-15 要求）
 *
 * - 单例 ref（SPA 无 SSR，避免 useState 在事件回调里取不到 Nuxt 实例的问题）
 * - 环形缓冲（最近 `LOG_RING_MAX` 条）+ localStorage 持久化（刷新不丢）
 * - **所有 data 先过 redactObject 脱敏**：token/学号/姓名永不进日志
 *
 * 用法：
 *   import { logEvent } from '~/composables/useEventLog'
 *   logEvent('info', 'submit', '开跑成功', { scantronId, km })
 */
import { LOG_RING_MAX, countByLevel, entriesToText, pushRing, redactObject } from '~/utils/mp/logFormat'
import type { LogEntry, LogLevel } from '~/utils/mp/logFormat'
import { buildHeartbeatData, newEventId, reportDiagEvent } from '~/composables/useDiagEventReporter'
import { useRealState } from '~/composables/real/state'
import { useMpReal } from '~/composables/useMpReal'

const STORAGE_KEY = 'totoro_event_logs_v1'

/** 单例：整个 App 共用一份 */
const entries = ref<LogEntry[]>([])
let loaded = false

/**
 * 🆕 2026-09-23（用户要求：诊断"一份包就能定位问题"）：
 * 环形缓冲里每条都带一个**稳定 id**（`DiagEvent.id`），并在记日志时**同时**上报服务端一份。
 *
 * 为什么要稳定 id：导出时要把「页面内存 / localStorage 兜底 / 服务端日志」三份**按 id 去重**合并，
 * 没有 id 就只能按"时间+文本"猜（同一毫秒的两条会被误当重复）。
 * 上报是 **fire-and-forget**（见 `useDiagEventReporter`），**绝不影响界面**。
 */
const withId = (e: LogEntry): LogEntry => ({ ...e, id: e.id ?? newEventId() })

function persist(): void {
  if (!import.meta.client) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.value))
  } catch {
    /* 配额/隐私模式：忽略 */
  }
}

function loadOnce(): void {
  if (!import.meta.client || loaded) return
  loaded = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const arr = JSON.parse(raw) as LogEntry[]
    if (Array.isArray(arr)) entries.value = arr.slice(-LOG_RING_MAX)
  } catch {
    /* 损坏的日志直接忽略 */
  }
}

export function useEventLog() {
  loadOnce()

  const log = (level: LogLevel, cat: string, msg: string, data?: Record<string, unknown>): void => {
    const entry = withId({ t: new Date().toISOString(), level, cat, msg, data: redactObject(data) })
    entries.value = pushRing(entries.value, entry)
    persist()
    /**
     * 🆕 **双写服务端**（用户抱怨"刷新一下就丢"）：同一条事件也上报一份（落服务端日志 ⇒ 导出包里就有）。
     * 只挑**扁平标量**进 `data`（契约层的白名单会再筛一遍）；上报失败只吞掉/警告，**不影响界面**。
     */
    reportDiagEvent({
      id: String(entry.id ?? ''),
      at: entry.t,
      level: entry.level,
      cat: entry.cat,
      text: entry.msg,
      ...(flattenForReport(entry.data) ? { data: flattenForReport(entry.data)! } : {}),
    })
  }

  const clear = (): void => {
    entries.value = []
    persist()
  }

  return {
    entries,
    log,
    clear,
    counts: computed(() => countByLevel(entries.value)),
    asText: (onlyFiltered?: LogEntry[]) => entriesToText(onlyFiltered ?? entries.value),
  }
}

/** 便捷函数：任何地方都能直接记一条（自动脱敏） */
export function logEvent(level: LogLevel, cat: string, msg: string, data?: Record<string, unknown>): void {
  useEventLog().log(level, cat, msg, data)
}

/**
 * 把事件 `data` 收成**扁平标量**（上报白名单要的形状）：
 * 嵌套对象/数组**转成短 JSON 字符串**（而不是原样透传 —— 服务端只收扁平标量），超长由契约层截断。
 * 没有可上报的键 ⇒ 返回 `undefined`（不硬塞空对象）。
 */
function flattenForReport(data: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> | undefined {
  if (!data) return undefined
  const out: Record<string, string | number | boolean | null> = {}
  let n = 0
  for (const [k, v] of Object.entries(data)) {
    if (n >= 12) break
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v
    else if (typeof v === 'string') out[k] = v
    else {
      try {
        out[k] = JSON.stringify(v)?.slice(0, 200) ?? null
      } catch {
        /* 循环引用等：跳过这个键 */
        continue
      }
    }
    n++
  }
  return n > 0 ? out : undefined
}

export const logInfo = (cat: string, msg: string, data?: Record<string, unknown>) => logEvent('info', cat, msg, data)
export const logWarn = (cat: string, msg: string, data?: Record<string, unknown>) => logEvent('warn', cat, msg, data)
export const logError = (cat: string, msg: string, data?: Record<string, unknown>) => logEvent('error', cat, msg, data)

/**
 * 🆕 2026-09-23（复验 B2 修）：**心跳的"现算摘要"全局提供者**。
 *
 * ## 为什么放在这里（而不是诊断卡片里）
 * 复验实测：卡片只在点「开始记录」时装心跳，且**切页/卸载后没人重装** ⇒ 刷新后心跳停摆、
 * 包里看不到"结算/提交之后"的状态（正是最要紧的那段）。
 * 这里用的是**单例状态**（`useRealState()` / `useMpReal()` 都是 SPA 单例，不依赖任何组件实例）
 * ⇒ 诊断页刷新后仍可用、**离开诊断页去别的页面也照常上报**。
 *
 * ⚠️ 每次调用**现算**（不是缓存快照）⇒ 定时器拿到的是"此刻"的任务/线路/门禁/页面；
 * 形状与脱敏口径全在 `buildHeartbeatData()`（扁平标量白名单，服务端还会再掩一道）。
 */
export function liveHeartbeatData(): Record<string, string | number | boolean | null> {
  const real = useRealState()
  /**
   * ⚠️ `useMpReal()` 在这里是**函数体内**才调用（不是模块顶层）⇒ 即使 `useEventLog` 与 `real/submit`
   * 之间存在模块循环，运行时也不会撞上"未初始化"（函数体执行时模块早已求值完）。
   */
  const realData = useMpReal()
  const rawTask = real.task.value && typeof real.task.value === 'object' ? (real.task.value as Record<string, unknown>) : null
  const runPoints = rawTask && Array.isArray(rawTask.runPointList) ? (rawTask.runPointList as unknown[]).length : 0
  const gate = realData.gateStatus.value
  return buildHeartbeatData({
    page: typeof window !== 'undefined' ? window.location.pathname : '',
    task: rawTask
      ? {
          paperId: String(rawTask.taskId ?? rawTask.paperId ?? ''),
          paperName: String(rawTask.paperName ?? ''),
          km: Number(rawTask.mileage ?? 0),
          runPointListCount: runPoints,
        }
      : null,
    line: { selectedId: String(realData.selectedLine.value?.pointId ?? ''), required: runPoints > 0 },
    gate: { allow: gate?.allow ?? null, warnings: [], blockedBy: String(gate?.blockedBy ?? '') },
    status: { realStatus: String(real.status.value ?? ''), restoredAt: Number(real.loadedAt.value ?? 0) },
  })
}
