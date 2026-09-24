/**
 * 「任务到底要求什么」的**探测（纯逻辑层，可离线单测）** —— 2026-09-21 新增
 *
 * ## 为什么要有它（issue #12 暴露的判据缺陷）
 * 现在有两处判据会**自己造出一个服务端并未提出的要求**：
 *
 * 1. **拟合度**：`utils/mp/taskRules.ts` 里写的是 `Number(task.fitDegree ?? 0.6)` ——
 *    服务端**没下发** `fitDegree` 时我们默认按 `0.6` 判 ⇒ 自检表里会出现一条"拟合度不达标"的
 *    硬性失败（甚至拦住提交）。但"没下发"的正确含义是**本任务不判拟合度**（界面上的 0.60 可能只是
 *    任务卡片的展示值）。
 * 2. **线路**：`components/RunWorkspace.vue` 的下拉 = 任务 `runPointList` ∩ 本机描过的跑道。
 *    当**任务本身没有线路**（`runPointList` 缺失或为空）时，这个交集必然为空，界面会归因为
 *    "你还没描跑道"并**在门禁里阻断开跑** —— 可任务其实**不指定路线**（自由路线任务）。
 *
 * 因此把"任务要求什么"收口成本模块的**两个纯函数**，界面/门禁/自检/诊断导出都从这里取判据：
 * - `fitRequirementOf(task)`   → 是否真的要求拟合度、阈值多少、依据是什么
 * - `routeRequirementOf(task)` → 任务是指定线路（`line`）还是不指定（`free`）
 *
 * ⚠️ **诚实标注**：本模块只做"**服务端下发的字段**怎么读"的判断，**不臆测服务端在判定时是否真的忽略它们**。
 *    也就是说 `kind: 'free'` 表示"任务没下发线路"（客观事实），不表示"服务端保证不判路线"（无法从数据证明）。
 *    界面文案也必须照此措辞（"服务端未下发线路"，而不是"服务端不判路线"）。
 */

/** 拟合度要求的探测结果 */
export interface FitRequirement {
  /** 服务端是否**真的**提出了拟合度要求 */
  required: boolean
  /** 要求时的阈值（原值，不做 0~1 / 0~100 量纲换算）；不要求时为 null */
  threshold: number | null
  /** 原样保留服务端下发的值（诊断导出用，便于核对） */
  raw: unknown
  /** 给人看的一句依据（界面/自检表直接复用，避免各处各写一套说法） */
  reason: string
}

/**
 * 拟合度：**只有服务端下发了有限且 > 0 的数值时才算要求**。
 * 判据（可执行）：`fitDegree` 缺失 / null / 空串 / 非数字 / ≤ 0 ⇒ `required: false`。
 * 这么定的理由：`0.6` 是"没字段时"的历史兜底值，它把一个**不存在的要求**变成了硬性门槛；
 * 而 `0` 表示"阈值为 0"，等价于不拦（此时也不需要自检表报红）。
 */
export function fitRequirementOf(task: unknown): FitRequirement {
  const raw = (task ?? {}) as Record<string, unknown>
  const v = raw.fitDegree
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    return { required: false, threshold: null, raw: v, reason: '服务端未下发拟合度阈值（本任务不判拟合度）' }
  }
  const n = Number(v)
  if (!Number.isFinite(n)) {
    return { required: false, threshold: null, raw: v, reason: `拟合度阈值不是有效数字（原值 ${JSON.stringify(v)}），按不判处理` }
  }
  if (n <= 0) {
    return { required: false, threshold: null, raw: v, reason: `拟合度阈值为 ${n}（等于不设要求）` }
  }
  return { required: true, threshold: n, raw: v, reason: `服务端要求拟合度 ≥ ${n}` }
}

/** 线路要求的探测结果 */
export interface RouteRequirement {
  /** `line` = 任务指定了线路（要按线路几何跑）；`free` = 任务未下发任何线路（自由路线任务） */
  kind: 'line' | 'free'
  /** 任务下发的线路条数（0 = 未下发） */
  lineCount: number
  /** 给人看的一句依据 */
  reason: string
}

/**
 * 线路：**`runPointList` 缺失或为空 = 任务未下发线路**（自由路线任务）。
 *
 * 与"有线路但你还没描跑道"必须**分开归因**（这正是 issue #12 里被混在一起的那一步）：
 * - `kind: 'line'` + 本机没描过 ⇒ 提示去「跑道编辑」描一条（现状，正确）；
 * - `kind: 'free'` ⇒ **不该阻断开跑**，也不该说"你没描跑道"；应说明"本任务未下发线路"，
 *   轨迹用本机已有的跑道几何生成，提交时只带任务号、不带线路标识。
 */
export function routeRequirementOf(task: unknown): RouteRequirement {
  const raw = (task ?? {}) as Record<string, unknown>
  const lines = Array.isArray(raw.runPointList) ? raw.runPointList : []
  const lineCount = lines.length
  if (lineCount === 0) {
    return {
      kind: 'free',
      lineCount: 0,
      reason: '服务端未下发线路列表（runPointList 为空）—— 本任务不指定路线',
    }
  }
  return { kind: 'line', lineCount, reason: `服务端下发了 ${lineCount} 条线路` }
}

/**
 * 把两个探测结果压成一行，供**日志/诊断导出**用（出问题时一眼看懂我们读到了什么）。
 * 形如：`route=line(2) fit=required(0.6)` / `route=free(0) fit=none`
 */
export function taskShapeLine(task: unknown): string {
  const r = routeRequirementOf(task)
  const f = fitRequirementOf(task)
  return `route=${r.kind}(${r.lineCount}) fit=${f.required ? `required(${f.threshold})` : 'none'}`
}

/**
 * 🆕 2026-09-23（pre3 实测事故，**唯一一处任务号兜底链**）：**任务号到底取哪个字段**。
 *
 * ## 为什么必须有它（用户现场）
 * 研究生院「研途健行」那份任务响应里**顶层没有 `taskId` 字段** ✗（实测顶层键是
 * `id` / `paperId` / `paperName` / `mileage` / `runPointList` …）—— 而"自由路线任务"提交时
 * `paperId` 正是**唯一的成绩归属标识**（线路为空、报文里 `lineId` 必须是空串）。
 * 老代码只写 `task.taskId` ⇒ 取到空串 ⇒ 提交前的上下文校验判"没有可提交的线路/任务号" ⇒
 * **`getRunBegin` 一个都没发出去**（日志实证：三个写请求各 0 条）。用户以为"走到最后一步却提交不了"。
 *
 * ## 判据（可执行）
 * 按顺序取 **`taskId` → `paperId` → `id`**，**空串一律当作"没给"继续往后兜**（`??` 不跳空串，所以用"取到非空"的写法）；
 * 三个都拿不到 ⇒ 返回空串（调用方据此拦"没有任务号就没法归属成绩"，并**指路**让用户回工作台重新读取）。
 * ⚠️ 顺序是有意的：`taskId` 是本项目内部口径（如果厂商给了就用它），`paperId`/`id` 才是他这份响应里的实际字段。
 */
export function taskPaperIdOf(task: unknown): string {
  const raw = (task ?? {}) as Record<string, unknown>
  for (const key of ['taskId', 'paperId', 'id'] as const) {
    const v = raw[key]
    const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''
    if (s) return s
  }
  return ''
}
