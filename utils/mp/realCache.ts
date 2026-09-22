/**
 * 「上次读取的会话」本地缓存的**纯数据层**（2026-09-18）
 *
 * 缓存里放三样东西：
 *   ① `task`   —— 用来显示"本机存有上次读取的会话：<任务名>"；
 *   ② `lineId` —— 当时选中的线路（恢复后沿用，避免选线被重置）；
 *   ③ `token`  —— **会话 token 本身**，让「恢复」真的能"重建会话"（用户 2026-09-18 确认的方案）。
 *
 * ⚠️ 为什么必须存 token（三轮迭代后的结论）：
 *   不存的话，「恢复」只剩一个"检查有没有 token"的触发器 —— `localStorage['mp_session']`
 *   一旦被清（退出登录 / 清浏览器数据 / 换浏览器），恢复就**永远救不回来**，
 *   用户实测就是被这一点卡住（"为什么无法恢复？"）。
 *   安全性说明：token 本来就已经**明文**存在同一个 `localStorage` 的 `mp_session` 里，
 *   这里只是多存一份同机同浏览器的副本，**不增加暴露面**；退出登录 / 清空本机数据时
 *   **两份一起清**（`clearSession` + `clearCachedTask` 都在 `clearAllLocalData` 里）。
 *
 * 解析/归一化放在这里的意义：**纯函数、可离线单测**（老缓存、缺字段、类型不对都要安全降级），
 * 不依赖 `localStorage` 与 Vue 状态。
 */
import type { MpSunrunTask } from '~/src/mp/types'

/** 缓存负载 */
export interface RealCachePayload {
  /** 写入时间（毫秒时间戳） */
  at: number
  task: MpSunrunTask
  /** 当时选中的线路 id（恢复时沿用） */
  lineId: string
  /** 会话 token（**可缺**：1.1.4~1.1.9 的老缓存没有这一项） */
  token: string
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * 把任意历史数据归一化成 `RealCachePayload`：
 *   · 必须有 `task`（且是普通对象）——没有就返回 `null`（= 没有可用缓存）；
 *   · `at` 非有限数字归 0；`lineId` / `token` 非字符串归空串（老缓存没有 token ⇒ 空串，
 *     此时「恢复」会提示去取 token，而不是假装修好了）；
 *   · 未知的多余字段**直接忽略**，不报错（前向兼容）。
 */
export function normalizeCachePayload(raw: unknown): RealCachePayload | null {
  if (!isObj(raw)) return null
  const task = raw.task
  if (!isObj(task)) return null
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0
  const lineId = typeof raw.lineId === 'string' ? raw.lineId : ''
  const token = typeof raw.token === 'string' ? raw.token : ''
  return { at, task: task as unknown as MpSunrunTask, lineId, token }
}

/** 序列化（写缓存用）——只写这四个字段，绝不把整个 state 摊进去 */
export function serializeCachePayload(p: { at: number; task: MpSunrunTask; lineId: string; token: string }): string {
  const payload: RealCachePayload = { at: p.at, task: p.task, lineId: p.lineId, token: p.token }
  return JSON.stringify(payload)
}

/**
 * 一个对象"看起来像不像任务本体"。
 *
 * 判据（可执行）：出现下列**任务自身**的字段就当任务本体 ——
 *   · `runPointList`：线路表（**可能是空数组**，"任务确实没下发线路"也是有效信息）；
 *   · `paperName` / `taskId` / `mileage` / `fitDegree` / `minSpeed` / `maxSpeed` / `startDate` / `endDate`。
 *
 * ⚠️ 2026-09-22 实测修正：**不能**把 `sunrunTaskList` 也算进来。它是**信封**上挂着任务列表的字段名，
 * 一旦算进来，`{code, data:{…}, sunrunTaskList:[…]}` 这个信封自己就会被当成任务本体
 * （实测：`looksLikeTask(envelope)` 返回 true ⇒ 函数在第一层就收手，钻进 `data` 的逻辑永远走不到，
 * 于是又回到"`runPointList` 读成 0 条"的老 bug —— 正是这一轮要修的东西）。
 *
 * ⚠️ 2026-09-22 二次修正：**`null` 视为"没有这个字段"**。
 * 供应商的信封是"平铺大杂烩"（`_mp-analyze/capture/har-dump/12_POST_currentTimeMillis.txt` 实测）：
 * `{status,msg,data:null,obj:null,body:…,resultMap:null,paperName:null,runPointList:null,…}` ——
 * 与本次请求无关的字段**一律填 `null`**。若把 `null` 当成"有字段"，那么**失败响应**
 * （`{status:"01", code:"1", runPointList:null, paperName:null}`）也会被当成"任务本体"，
 * 于是到处都能"读到一个什么都为空的任务"（把失败掩盖成成功）。判据：**只有真正的值才算数**。
 */
export function looksLikeTask(v: unknown): boolean {
  if (!isObj(v)) return false
  const keys = ['runPointList', 'paperName', 'taskId', 'mileage', 'fitDegree', 'minSpeed', 'maxSpeed', 'startDate', 'endDate']
  return keys.some((k) => {
    const value = (v as Record<string, unknown>)[k]
    return value !== undefined && value !== null
  })
}

/**
 * 一眼看出"这是个 API 响应信封"（而不是任务本体）。
 *
 * 判据：有 `data` / `obj` / `body` 里任意一个**承载负载的字段**，并且带上了信封特征
 * （业务码 `status` / `code`，或消息 `msg` / `message`，或 `header`）。
 * 用途：有的响应**恰好**把任务字段摊在信封顶层（`{code, runPointList:[…], data:{…}}`），
 * 此时必须**优先钻进负载字段**，别把信封当成任务本体。
 */
export function looksLikeEnvelope(v: unknown): boolean {
  if (!isObj(v)) return false
  const o = v as Record<string, unknown>
  const hasPayloadField = ['data', 'obj', 'body'].some((k) => isObj(o[k]))
  if (!hasPayloadField) return false
  return ['status', 'code', 'msg', 'message', 'header'].some((k) => o[k] !== undefined)
}

/** 按序尝试解一层的字段名（**顺序即优先级**，见 `resolveCacheTask` 的说明） */
const TASK_UNWRAP_KEYS = ['task', 'data', 'obj', 'body'] as const

/**
 * 🔴 2026-09-22（真实用户诊断包暴露的**我们自己的** bug）：从一个"可能被包了好几层"的负载里取出**任务本体**。
 *
 * ## 故障现象（研究生院「研途健行」用户的诊断包）
 * ```
 * snapshot.task.raw.runPointList       = 0 条        ← 我们读到的
 * snapshot.task.raw.data.runPointList  = 1 条        ← 真正的线路在这里
 * snapshot.task.summary.shapeLine      = "route=free(0) fit=required(0.6)"   ← 基于**错数据**得出的结论
 * snapshot.task.lines                  = 0 条
 * ```
 * 也就是说：诊断快照把 **API 响应信封**（`{code, data:{…}, sunrunTaskList:[…]}`）当成了任务本体，
 * 于是"任务里到底有没有线路"这个 issue #12 的核心证据被读成"没有" —— **把维护者（也包括我）带偏了**。
 *
 * ## 为什么会有信封混进来
 * `sunrunPaper` 端点的负载规格是 `getSunrunPaperResponseList#0`（见 `src/mp/endpoints.ts`）；
 * 若响应里没有这个字段，`unwrapMpResponse()` 返回 `undefined`，而该端点仍可能被判 ok，
 * 于是 `task.value` 实际拿到的是**低一层/高一层的信封**，缓存里存的就是它（`data.ts:171/206`）。
 *
 * ## 这个函数怎么取（顺序即优先级）
 * 1. 当前对象**像任务**（`looksLikeTask`）且**不像信封**（`looksLikeEnvelope`）⇒ 收下；
 * 2. 依次试 `task` → `data` → `obj` → `body`（`task` 在前：兼容"缓存包装 `{…, task}`"；
 *    `data` 在后：兼容"响应信封 `{code, data}`"）；
 * 3. 兜底：**任意数组**（信封里常见的 `sunrunTaskList`，或别的字段名装的任务列表）；
 * 4. 最后：任意子对象（容错，避免"任务藏在没见过的字段名里"被读成 null）。
 *
 * 返回 `source` 说明**路径**（如 `'task'` / `'task.data'` / `'sunrunTaskList[0]'`），供 manifest 与排障引用。
 * 纯函数、零依赖、有单测（`tests/mp/realCache.test.ts`）。
 */
export function resolveCacheTask(raw: unknown): { task: Record<string, unknown> | null; source: string } {
  if (raw === null || raw === undefined) return { task: null, source: 'none' }
  const seen = new Set<unknown>()
  /** "当前对象是不是任务本体"与"要不要往下钻"分开判，避免信封被误收（见 `looksLikeTask` 的注） */
  const acceptHere = (o: Record<string, unknown>): boolean => looksLikeTask(o) && !looksLikeEnvelope(o)
  const walk = (v: unknown, path: string, depth: number): { task: Record<string, unknown> | null; source: string } | null => {
    if (v === null || typeof v !== 'object' || depth > 4 || seen.has(v)) return null
    seen.add(v)
    if (Array.isArray(v)) {
      // 数组：取第一个"看起来像任务"的元素（信封里的 `sunrunTaskList[0]`）
      for (let i = 0; i < v.length && i < 8; i++) {
        if (!isObj(v[i]) || !looksLikeTask(v[i])) continue
        return { task: v[i] as Record<string, unknown>, source: `${path}[${i}]` }
      }
      return null
    }
    const o = v as Record<string, unknown>
    if (acceptHere(o)) return { task: o, source: path }
    for (const key of TASK_UNWRAP_KEYS) {
      const child = o[key]
      if (child === undefined || child === null) continue
      const r = walk(child, path ? `${path}.${key}` : key, depth + 1)
      if (r) return r
    }
    // 兜底顺序：**先数组**（任务列表更明确），再任意子对象
    for (const key of Object.keys(o)) {
      if (!Array.isArray(o[key])) continue
      const r = walk(o[key], path ? `${path}.${key}` : key, depth + 1)
      if (r) return r
    }
    for (const key of Object.keys(o)) {
      const child = o[key]
      if (!isObj(child)) continue
      const r = walk(child, path ? `${path}.${key}` : key, depth + 1)
      if (r) return r
    }
    return null
  }
  return walk(raw, '', 0) ?? { task: null, source: 'none' }
}

/**
 * 🆕 2026-09-22：**缓存负载 → 任务本体**的便捷封装（诊断快照用它）。
 *
 * 与 `normalizeCachePayload()` 的区别：后者要求严格形状（`{at, task:{…}}`，是**恢复会话**的入口），
 * 本函数则面向"**这份数据可能被包了几层**"的排障场景，宁可多试几层也不要把"有线路"读成"没线路"。
 */
export function extractTaskFromCachePayload(raw: unknown): { task: Record<string, unknown> | null; source: string } {
  const r = resolveCacheTask(raw)
  return { task: r.task, source: r.source ? `cache.${r.source}` : 'none' }
}

// ---------- 🆕 2026-09-22（真实用户实测）：刷新后**自动从本机缓存恢复**的两个纯函数 ----------
/**
 * **要不要自动从本机缓存恢复任务**（"刷新后整页变哑"的修法；判据收进纯函数便于单测）。
 *
 * 背景（研究生院用户实测）：刷新浏览器 ⇒ `useState` 内存里的 task/profile 全丢
 * ⇒ 跑步页只剩一句"请先读取真实账号和任务"，用户以为程序坏了（他反复撞上）。
 *
 * 三条判据（**缺一不可**）：
 *   ① `hasTaskInMemory === false` —— 内存里已有任务时什么都不做（不覆盖、不打扰）；
 *   ② `demoMode === false` —— 演示数据是用户的**显式选择**，自动恢复不许把它顶掉；
 *   ③ `hasCache === true` —— 本机确实存着"上次读取的任务"。
 */
export function shouldAutoRestoreFromCache(input: {
  hasTaskInMemory: boolean
  demoMode: boolean
  hasCache: boolean
}): boolean {
  return !input.hasTaskInMemory && !input.demoMode && input.hasCache
}

/** 自动恢复时要写回内存的那几个值（由 `restorePatchOf` 从缓存负载算出来，**纯数据**） */
export interface CacheRestorePatch {
  /** 上次读取到的任务本体（**非空**：能拿到补丁就说明缓存里有可用任务） */
  task: MpSunrunTask
  /** 上次读取的时刻（缓存没写/非法 ⇒ 0；界面显示"最近一次读取于 …"用它） */
  loadedAt: number
  /** 当时选中的线路 id（恢复后沿用；空串 = 没有特别指定） */
  lineId: string
  /** 缓存里的 token（**可空**：老缓存没有 token ⇒ 空串，界面据此提示"要真提交得先重新读取"） */
  token: string
}

/**
 * 把**缓存里的原始负载**压成"要写回内存的补丁"（纯函数，零依赖，有单测）。
 *
 * ⚠️ 两个坑都在这里挡住：
 *   ① 形状不严（不是 `{at, task:{…}}`）⇒ `normalizeCachePayload` 返回 null ⇒ **本函数也返回 null**
 *      （宁可不自动恢复、让用户显式点「读取」，也不要把一坨看不懂的东西塞进内存）；
 *   ② **任务本体可能被包在信封里**（`{code, data:{…}}`）—— 2026-09-22 诊断包暴露的坑
 *      （`raw.runPointList` 0 条、`raw.data.runPointList` 1 条）⇒ 用 `resolveCacheTask` 先取本体，
 *      取不到本体就**不恢复**。
 */
export function restorePatchOf(raw: unknown): CacheRestorePatch | null {
  const p = normalizeCachePayload(raw)
  if (!p) return null
  const body = resolveCacheTask(p.task).task
  if (!body) return null
  return {
    task: body as unknown as MpSunrunTask,
    loadedAt: Number.isFinite(p.at) && p.at > 0 ? p.at : 0,
    lineId: String(p.lineId ?? ''),
    token: String(p.token ?? ''),
  }
}

/**
 * token 的**展示用掩码**（界面绝不显示完整 token）。
 *   · 长 token（> 14 位，真实 token 远长于此）⇒ 头 6 + 尾 6，例 `abcdefghijklmnop` → `abcdef…klmnop`；
 *   · **短串一律给固定掩码**（2026-09-18 审计 L1）：此前对 ≤6 位的串会原样显示两遍
 *     （`'abc'` → `'abc…abc'`、`'abcdef'` → `'abcdef…'` 之类），直接违反本函数的契约。
 */
export function maskToken(token: string): string {
  const t = String(token || '')
  if (!t) return ''
  if (t.length <= 14) return '*'.repeat(Math.min(8, t.length))
  return `${t.slice(0, 6)}…${t.slice(-6)}`
}
