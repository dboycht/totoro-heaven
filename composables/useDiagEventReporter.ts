/**
 * 「客户端事件上报」：把界面上发生的每一步**双写**到服务端（2026-09-23 新增）
 *
 * ## 为什么要有它（用户原话）
 * 「诊断系统捕获的数据量不全，**用户刷新一下界面我们就丢失数据捕获**」
 * —— 记录窗口 / 服务端日志 / 响应原文本来就在服务端（刷新不丢），**只有"客户端操作时间线"原先在页面内存里**
 * （虽然有 localStorage 兜底，但那只是"下次打开还能看见"，**不进诊断包**、也不受记录窗口约束）。
 * 现在每条事件**同时**上报一份到 `POST /api/local/diagnostics/event`（落进服务端日志 ⇒ 导出包里就有）。
 *
 * ## 设计要点（逐条对应要求）
 * - **不许阻塞/影响 UI**：全部 fire-and-forget（`fetch(...).catch(() => {})`），**没有 await**；
 * - **小批量合并**：入队后 1.2 秒 flush 一次（`DIAG_EVENT_FLUSH_MS`），一条也不丢（队列上限兜底）；
 * - **页面关闭前尽力 flush**：`visibilitychange(hidden)` 与 `beforeunload` 里同步发一次
 *   （用 `keepalive: true` 让浏览器尽力把它发出去；**不保证**送达 —— 所以还有 localStorage 兜底）；
 * - **localStorage 兜底**：每条事件**同时**写一份到 `mp_diag_events_v1` ⇒ 连"还没上报就刷新"的那 1~2 秒也不丢，
 *   导出时作为**第三个来源**参与按 id 去重合并；
 * - **失败只吞掉或 warn**：端点不可用（dev 没起、HMR 中）时静默；只有"HTTP 明确失败"才记一条 warn，
 *   而且**用原生 fetch 记**（不能再走 `logs.log`，否则形成"上报失败 → 再入队 → 再失败"的自激循环）。
 */
import type { DiagEvent, DiagEventSource } from '~/utils/mp/diagnostics'
import { DIAG_EVENT_BATCH_MAX, DIAG_EVENT_PATH, DIAG_HEARTBEAT_INTERVAL_MS, DIAG_HEARTBEAT_PATH } from '~/utils/mp/diagnostics'

/** localStorage 键：客户端事件的**离线兜底**（导出时作为第三来源） */
export const EVENTS_STORAGE_KEY = 'mp_diag_events_v1'
/** 兜底最多留多少条（与环形缓冲同量级；够覆盖"上传还没成功就刷新"的窗口） */
export const EVENTS_STORAGE_MAX = 500
/** 小批量合并的 flush 间隔（毫秒） */
const FLUSH_MS = 1200
/** 队列上限（超过就丢掉最旧的并计数，绝不无限增长） */
const QUEUE_MAX = 500

/** 进程内队列 + 定时器（单例；与 `useEventLog` 的环形缓冲分开，职责不同） */
let queue: DiagEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let droppedFromQueue = 0
let installed = false

/** 生成稳定 id（**去重的唯一依据**）：`c<36 进制时间>-<随机>`，只含白名单字符 */
export function newEventId(now: number = Date.now()): string {
  const r = Math.random().toString(36).slice(2, 8)
  return `c${now.toString(36)}-${r}`
}

/** 读离线兜底（导出时用；坏数据一律忽略） */
export function readStoredEvents(): DiagEvent[] {
  if (!import.meta.client) return []
  try {
    const raw = localStorage.getItem(EVENTS_STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter((e): e is DiagEvent => Boolean(e && typeof e === 'object' && typeof (e as DiagEvent).id === 'string'))
  } catch {
    return []
  }
}

/** 写离线兜底（**fire-and-forget 的本地部分**：失败只忽略，绝不影响 UI） */
function appendStored(e: DiagEvent): void {
  if (!import.meta.client) return
  try {
    const arr = readStoredEvents()
    arr.push(e)
    localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(arr.slice(-EVENTS_STORAGE_MAX)))
  } catch {
    /* 配额/隐私模式：忽略（服务端那一路仍在） */
  }
}

/** 清空离线兜底（退出登录/清空本机数据时用，与其它本机数据同等对待） */
export function clearStoredEvents(): void {
  if (!import.meta.client) return
  try {
    localStorage.removeItem(EVENTS_STORAGE_KEY)
  } catch {
    /* 忽略 */
  }
}

/** 真的发一次（**fire-and-forget**；`keepalive` 用于页面卸载时的尽力送达） */
function send(batch: DiagEvent[], keepalive = false): void {
  if (!import.meta.client || batch.length === 0) return
  try {
    void fetch(DIAG_EVENT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive,
    })
      .then((res) => {
        if (!res.ok) {
          /**
           * ⚠️ 这里**只用原生 console**，**不再走 `logs.log`** ——
           * 否则"上报失败 → 又记一条事件 → 又上报失败"会自激刷爆（设计红线）。
           */
          if (import.meta.dev) console.warn('[diag] 事件上报失败（不影响界面）', res.status)
        }
      })
      .catch(() => {
        /* 端点没起/HMR 中：静默（localStorage 兜底还在） */
      })
  } catch {
    /* 同步异常（极少）：忽略 */
  }
}

/** 立即 flush（幂等；`visibilitychange`/`beforeunload` 与定时器都调它） */
export function flushDiagEvents(keepalive = false): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (queue.length === 0) return
  /** 按单请求上限切片（服务端也会兜一层；这里先切好，避免一票被整批拒） */
  const batches: DiagEvent[][] = []
  for (let i = 0; i < queue.length; i += DIAG_EVENT_BATCH_MAX) batches.push(queue.slice(i, i + DIAG_EVENT_BATCH_MAX))
  queue = []
  for (const b of batches) send(b, keepalive)
}

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushDiagEvents()
  }, FLUSH_MS)
}

/**
 * 上报一条客户端事件（**入队 + 落 localStorage + 安排 flush**；这是外部唯一入口）。
 * @param e 已带 `id`/`at`/`level`/`cat`/`text`（`data` 可选，**扁平短值**）
 */
export function reportDiagEvent(e: DiagEvent): void {
  if (!import.meta.client) return
  appendStored(e)
  queue.push(e)
  if (queue.length > QUEUE_MAX) {
    droppedFromQueue += queue.length - QUEUE_MAX
    queue = queue.slice(-QUEUE_MAX)
  }
  installLifecycleHooks()
  scheduleFlush()
}

/** 页面隐藏/卸载时尽力把队列发出去（**不保证**送达 ⇒ 所以还有 localStorage 兜底） */
function installLifecycleHooks(): void {
  if (installed || !import.meta.client) return
  installed = true
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushDiagEvents(true)
    })
    window.addEventListener('beforeunload', () => flushDiagEvents(true))
    window.addEventListener('pagehide', () => flushDiagEvents(true))
  } catch {
    /* 环境不支持就算了（定时器那条路仍在） */
  }
}

/** 事件队列的当前状态（**只给界面/测试看**，不参与导出内容） */
export function diagEventQueueState(): { queued: number; dropped: number } {
  return { queued: queue.length, dropped: droppedFromQueue }
}

/**
 * 🆕 用户要求 1️⃣：**客户端异常也要进包**。
 *
 * 装两类全局钩子（**只在客户端、只装一次**）：
 *   · `window.onerror` —— 未捕获的同步错误（含文件/行号/列号与截断后的栈）；
 *   · `window.onunhandledrejection` —— 未处理的 Promise 拒绝（含 `reason` 摘要）。
 * 目的：用户说"就是不能跑"时，我们**能看到他页面上到底报了什么**（这次反复排查很可能有没看到的客户端错误）。
 *
 * ⚠️ 一律**不再抛**（不能把用户的页面搞坏）；`text`/`data` 都走长度上限（`checkDiagEvent` 还会再兜一层）。
 */
export function installClientErrorHooks(extra?: { source?: string }): void {
  if (!import.meta.client) return
  try {
    window.addEventListener(
      'error',
      (ev: ErrorEvent) => {
        const msg = String(ev?.message ?? '未知错误')
        const where = ev?.filename ? `${String(ev.filename).split('/').pop()}:${ev.lineno ?? 0}:${ev.colno ?? 0}` : ''
        const stack = ev?.error instanceof Error ? String(ev.error.stack ?? '') : ''
        /**
         * ⚠️ **跨源脚本**抛出的错误会被浏览器改写成 `"Script error."` 且**不给 `error`/栈**（安全策略，实测）。
         * 这种情况**如实标注**（别让人以为"没有栈 = 代码没问题"）；组件内异常由 Vue 钩子给出真正的栈。
         */
        const sanitized = /^Script error\.?$/i.test(msg) || (!stack && !where)
        reportDiagEvent({
          id: newEventId(),
          at: new Date().toISOString(),
          level: 'error',
          cat: 'client-error',
          text: `页面未捕获错误：${msg}${where ? ` @ ${where}` : ''}${sanitized ? '（浏览器隐去了细节：多为跨源脚本异常）' : ''}`,
          data: {
            kind: 'onerror',
            ...(where ? { where } : {}),
            ...(stack ? { stack: stack.slice(0, 400) } : {}),
            ...(sanitized ? { sanitizedByBrowser: true } : {}),
            ...(extra?.source ? { source: extra.source } : {}),
          },
        })
      },
      true,
    )
    window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      const r = ev?.reason
      const msg = r instanceof Error ? String(r.message) : typeof r === 'string' ? r : JSON.stringify(r)?.slice(0, 200) ?? '未知拒绝'
      const stack = r instanceof Error ? String(r.stack ?? '').slice(0, 400) : ''
      reportDiagEvent({
        id: newEventId(),
        at: new Date().toISOString(),
        level: 'error',
        cat: 'client-error',
        text: `未处理的 Promise 拒绝：${msg}`,
        data: { kind: 'unhandledrejection', ...(stack ? { stack } : {}), ...(extra?.source ? { source: extra.source } : {}) },
      })
    })
  } catch {
    /* 环境不支持就算了 */
  }
}

/**
 * 上报一条**被拦下的请求**（用户要求 2️⃣）：把"提交从未发出"从**推断**变成**包里明写的事实**。
 *
 * @param text 人话（如 `真实提交被拦：开关未读取`）
 * @param data **判定所需**的字段摘要（开关值/线路要求/是否夜间/now 与时区偏移…）
 *             —— ⚠️ **不许**塞 token / 学号 / 姓名原文（调用方负责；`checkDiagEvent` 与端点还会再掩一道）
 */
export function reportBlocked(reason: string, text: string, data?: Record<string, string | number | boolean | null>): void {
  reportDiagEvent({
    id: newEventId(),
    at: new Date().toISOString(),
    level: 'gate',
    cat: 'blocked',
    text: `真实提交被拦：${text}`,
    data: { reasonCode: reason, ...(data ?? {}) },
  })
}

/** 给导出用：把浏览器侧两个来源（内存 + localStorage）都拿出来（**去重交给契约层的纯函数**） */
export function collectClientEventSources(inMemory: DiagEvent[]): { source: DiagEventSource; events: DiagEvent[] }[] {
  return [
    { source: 'localStorage', events: readStoredEvents() },
    { source: 'client', events: inMemory },
  ]
}

// ---------------------------------------------------------------------------
// 🆕 2026-09-23（用户要求 1️⃣）**心跳快照**：把"此刻的内存态摘要"定期 + 关键操作后上报一份
// ---------------------------------------------------------------------------

/** 心跳的节流状态（进程内；只在客户端用） */
let lastHeartbeatAt = 0
let hbTimer: ReturnType<typeof setInterval> | null = null
let hbSent = 0
let hbRejected = 0

/**
 * 采集一份"当前内存态摘要"（**由调用方给数据**，本函数只负责形状与脱敏；纯、可测）。
 *
 * 形状（用户要求逐项对应）：
 * `{ page, task:{paperId,paperName,km,runPointListCount}, line:{selectedId,required},
 *    localPath:{chosenId,shapeText,lapM}, gate:{allow,warnings[],blockedBy},
 *    lib:{entries,total}, status:{realStatus,restoredAt} }`
 *
 * ⚠️ **只收扁平标量**（与服务端 `checkDiagEvent` 的白名单一致）：嵌套数组（如 `gate.warnings`）
 * 转成**定长字符串**（`json` 化后截断），避免"整个对象原样透传"。
 */
export function buildHeartbeatData(input: {
  page: string
  task?: { paperId?: string; paperName?: string; km?: number; runPointListCount?: number } | null
  line?: { selectedId?: string; required?: boolean } | null
  localPath?: { chosenId?: string; shapeText?: string; lapM?: number } | null
  gate?: { allow?: boolean | null; warnings?: string[]; blockedBy?: string } | null
  lib?: { entries?: number; total?: number } | null
  status?: { realStatus?: string; restoredAt?: number } | null
}): Record<string, string | number | boolean | null> {
  const clamp = (s: unknown, n = 200): string => {
    const t = String(s ?? '')
    return t.length > n ? `${t.slice(0, n)}…[截断，原 ${t.length} 字符]` : t
  }
  const out: Record<string, string | number | boolean | null> = { page: clamp(input.page, 80) }
  const t = input.task
  if (t) {
    out['task.paperId'] = clamp(t.paperId, 80)
    out['task.paperName'] = clamp(t.paperName, 120)
    out['task.km'] = typeof t.km === 'number' && Number.isFinite(t.km) ? t.km : null
    out['task.runPointListCount'] = typeof t.runPointListCount === 'number' ? t.runPointListCount : 0
  }
  const l = input.line
  if (l) {
    out['line.selectedId'] = clamp(l.selectedId, 80)
    out['line.required'] = Boolean(l.required)
  }
  const p = input.localPath
  if (p) {
    out['localPath.chosenId'] = clamp(p.chosenId, 80)
    out['localPath.shapeText'] = clamp(p.shapeText, 120)
    out['localPath.lapM'] = typeof p.lapM === 'number' && Number.isFinite(p.lapM) ? Math.round(p.lapM) : null
  }
  const g = input.gate
  if (g) {
    out['gate.allow'] = g.allow === null || g.allow === undefined ? null : Boolean(g.allow)
    out['gate.blockedBy'] = clamp(g.blockedBy, 60)
    /** 警告清单：**JSON 化成定长字符串**（扁平标量白名单里放不下数组） */
    out['gate.warnings'] = clamp(Array.isArray(g.warnings) ? JSON.stringify(g.warnings.slice(0, 8)) : '', 200)
  }
  const lib = input.lib
  if (lib) {
    out['lib.entries'] = typeof lib.entries === 'number' ? lib.entries : 0
    out['lib.total'] = typeof lib.total === 'number' ? lib.total : 0
  }
  const st = input.status
  if (st) {
    out['status.realStatus'] = clamp(st.realStatus, 40)
    out['status.restoredAt'] = typeof st.restoredAt === 'number' ? st.restoredAt : 0
  }
  return out
}

/**
 * 上报一份心跳（**fire-and-forget**；节流：`DIAG_HEARTBEAT_INTERVAL_MS` 内只发一次，除非 `force`）。
 *
 * @param data  `buildHeartbeatData()` 的产物
 * @param force 关键操作（读取任务/选路径/开跑/结算/提交/导出）后传 `true` ⇒ 立即补发一份
 */
export function sendHeartbeat(data: Record<string, string | number | boolean | null>, force = false): void {
  if (!import.meta.client) return
  const now = Date.now()
  if (!force && now - lastHeartbeatAt < DIAG_HEARTBEAT_INTERVAL_MS) return
  lastHeartbeatAt = now
  hbSent++
  try {
    void fetch(DIAG_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ heartbeat: { id: newEventId(now), at: new Date(now).toISOString(), data } }),
    })
      .then((res) => {
        if (res.ok) return
        hbRejected++
        /** ⚠️ 只用原生 console（**不走 logs.log** ⇒ 不形成"上报失败→再记事件→再失败"的自激） */
        if (import.meta.dev) console.warn('[diag] 心跳上报被拒（不影响界面）', res.status)
      })
      .catch(() => {
        /* 端点没起/HMR 中：静默 */
      })
  } catch {
    /* 忽略 */
  }
}

/** 装上"定期心跳"（幂等；只在客户端；`provider` 每次现算摘要 ⇒ 拿到的永远是最新状态） */
export function installHeartbeat(provider: () => Record<string, string | number | boolean | null>): void {
  if (!import.meta.client || hbTimer !== null) return
  try {
    /** 先立刻来一份（页面刚打开就有"最后一刻的状态"基线） */
    sendHeartbeat(provider(), true)
    hbTimer = setInterval(() => {
      try {
        sendHeartbeat(provider(), false)
      } catch {
        /* 采集失败不影响页面 */
      }
    }, DIAG_HEARTBEAT_INTERVAL_MS)
    /** 页面隐藏/关闭前补一份（尽力而为；`localStorage` 那份事件兜底仍在） */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        try {
          sendHeartbeat(provider(), true)
        } catch {
          /* 忽略 */
        }
      }
    })
  } catch {
    /* 环境不支持就算了 */
  }
}

/** 心跳发送/被拒计数（**只给界面/测试看**，不参与导出内容） */
export function heartbeatState(): { sent: number; rejected: number; lastAt: number } {
  return { sent: hbSent, rejected: hbRejected, lastAt: lastHeartbeatAt }
}

/**
 * 🆕 2026-09-23（复验 B2 修）：**停掉心跳**（幂等）。
 *
 * 什么时候调：**结束记录 / 只结束记录 / 开始新记录** —— 语义是"心跳跟着**记录窗口**走，不跟着页面走"。
 * ⚠️ 故意**不**在界面组件卸载时调：用户复现问题的路径要跨页（工作台 → 跑步 → 结算 → 提交），
 * 组件卸载时把心跳停掉，恰好丢掉"结算/提交之后那一段"最要紧的状态（实测就是这么丢的）。
 */
export function stopHeartbeat(): void {
  if (hbTimer !== null) {
    clearInterval(hbTimer)
    hbTimer = null
  }
  /** 复位"上次发送时刻"⇒ 下一轮开始记录时能**立刻**发一份基线（否则会被节流挡掉） */
  lastHeartbeatAt = 0
}

/** 🆕 心跳定时器是否在跑（界面/验收用；`installHeartbeat()` 幂等的判据就是它） */
export function heartbeatIsRunning(): boolean {
  return hbTimer !== null
}
