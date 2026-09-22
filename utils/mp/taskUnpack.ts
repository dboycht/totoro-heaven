/**
 * `getSunrunPaper` 响应 → **任务本体**（纯函数，零依赖，有单测）—— 2026-09-22，issue #12 的**正解**
 *
 * ## 现象（研究生院「研途健行」用户的**真实诊断包**）
 * 端点规格是 `getSunrunPaperResponseList#0`（`src/mp/endpoints.ts:161`）。该用户的响应里这个字段
 * **缺失/为 null**，任务本体被摊在别处 —— 顶层只剩一个 `runPointList: []`。规格"没命中"时若
 * 直接把响应当任务：线路被读成 **0 条** ⇒ 线路下拉为空、门禁说"尚未选择跑步线路"、
 * 用户在「非官方路径【测试】」页白画半天（而他那个任务有 **1 条线路**）。
 *
 * ## 取法（顺序 = 优先级，**只认"看起来像任务"的层**）
 * ① `getSunrunPaperResponseList[0]`（规格路径；正常响应走这条 ⇒ **零回归**）
 * ② `data.getSunrunPaperResponseList[0]`
 * ③ `data` 本身（信封里装着任务本体）
 * ④ `sunrunTaskList[0]`
 * ⑤ 顶层自己（供应商的"任务元素"就是这种平铺对象：无关字段一律填 `null`）
 * 都没有 ⇒ `null`（**保持现状，绝不编造**）
 *
 * ⚠️ **关键补充**（否则那 1 条线路仍然读不到）：若"第一个命中的层"**没有线路**
 *   （`runPointList` 空 / 缺字段），而另一个候选**有线路、且是同一个任务**（`taskId`/`paperId` 相同，
 *   或 `paperName` 相同）⇒ 采用后者。判据收得很窄：**只认同一条任务**，免得把 `sunrunTaskList`
 *   里**另一份试卷**的线路张冠李戴过来；而且只在这份响应**像信封**时才换层
 *   （一个真的没有线路的任务，不该被旁边碰巧像任务的字段顶掉）。
 *
 * ⚠️ 本模块只负责"任务本体在哪一层"，**不碰**开关 / 摄像头杆 —— 门禁的"未知 ≠ 关闭"一个字不改。
 * ⚠️ 判据与缓存解包**同源**：`looksLikeTask` / `looksLikeEnvelope` 一律从 `./realCache` 取，
 *    本文件**不抄第二份**。
 */
import { looksLikeEnvelope, looksLikeTask } from './realCache'
import type { MpSunrunTask } from '../../src/mp/types'

type Rec = Record<string, unknown>

const isObj = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** 规格路径的层名（**唯一字面量**：选主、`degraded` 判据、日志都由它比出来） */
const SPEC_SOURCE = 'getSunrunPaperResponseList[0]'

/** 该层声明的线路条数；**-1 = 这一层根本没有 `runPointList` 字段**（与"有字段但是空数组"区分开） */
export function lineCountOf(v: unknown): number {
  if (!isObj(v)) return -1
  return Array.isArray(v.runPointList) ? v.runPointList.length : -1
}

/**
 * 两边是不是**同一条任务**：双方都有 id（`taskId` / `paperId`）⇒ 以 id 为准；
 * 否则比 `paperName`（都为空白 ⇒ 判否，**不猜**）。
 */
function sameTask(a: Rec, b: Rec): boolean {
  const aId = idOf(a)
  const bId = idOf(b)
  if (aId && bId) return aId === bId
  const an = nameOf(a)
  const bn = nameOf(b)
  return Boolean(an) && an === bn
}

/** 这条记录有没有"能用来认身份"的字段（id 或 `paperName`） */
function hasIdentity(v: Rec): boolean {
  return Boolean(idOf(v) || nameOf(v))
}

function idOf(o: Rec): string {
  for (const k of ['taskId', 'paperId']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function nameOf(o: Rec): string {
  return typeof o.paperName === 'string' ? o.paperName.trim() : ''
}

/** 解包结果 */
export interface PaperTaskResolution {
  /** 任务本体（找不到 = `null`；**绝不编造**） */
  task: MpSunrunTask | null
  /** 取自哪一层（写日志/诊断用）：`getSunrunPaperResponseList[0]` / `data` / `sunrunTaskList[0]` / `self` / `none` */
  source: string
  /** 所选层的线路条数（`-1` = 该层没有 `runPointList` 字段） */
  lineCount: number
  /** 是否用了**规格以外**的路径（= 解包退化 ⇒ 调用方**必须留痕**） */
  degraded: boolean
  /** 因"同一条任务、但有线路"而改用的那一层（没有 ⇒ 空串）——日志里一眼看出为什么换层 */
  adoptedFrom: string
  /** 被检查过的候选层（诊断用：便于核对"我们试过哪几层"） */
  candidates: string[]
}

/**
 * 从 `getSunrunPaper` 的**原始响应**里取出任务本体。
 * @param raw 原始响应（`MpCall.raw`）；直接传"任务本体"本身也可以（走 ⑤，此时 `source === 'self'`）
 */
export function resolvePaperTask(raw: unknown): PaperTaskResolution {
  const none: PaperTaskResolution = {
    task: null,
    source: 'none',
    lineCount: -1,
    degraded: true,
    adoptedFrom: '',
    candidates: [],
  }
  if (!isObj(raw)) return none

  const candidates: { source: string; value: Rec }[] = []
  /** ⚠️ 只用同源判据收候选（`looksLikeTask` 已把 `null` 视为"没有这个字段"，见那边的注释） */
  const push = (source: string, v: unknown) => {
    if (looksLikeTask(v)) candidates.push({ source, value: v as Rec })
  }

  const spec = raw.getSunrunPaperResponseList
  if (Array.isArray(spec) && spec[0] !== undefined) push(SPEC_SOURCE, spec[0])
  if (isObj(raw.data)) {
    const inner = raw.data.getSunrunPaperResponseList
    if (Array.isArray(inner) && inner[0] !== undefined) push('data.getSunrunPaperResponseList[0]', inner[0])
    push('data', raw.data)
  }
  const tasks = raw.sunrunTaskList
  if (Array.isArray(tasks) && tasks[0] !== undefined) push('sunrunTaskList[0]', tasks[0])
  const self = looksLikeTask(raw) ? raw : null
  if (self) push('self', self)

  const names = candidates.map((c) => c.source)
  if (!candidates.length) return { ...none, candidates: names }

  /**
   * **身份判据**（收窄"张冠李戴"的唯一办法）：这次请求要的是"哪一条任务"？
   * 以**顶层自己**的身份为准（它就是这次请求的对象）；顶层没有身份字段时，退回"第一个有身份的候选"。
   * ⇒ 身份**不一致**的候选（例如 `sunrunTaskList[0]` 里装着**另一份试卷**）直接丢掉。
   */
  const identity = self && hasIdentity(self) ? self : (candidates.find((c) => hasIdentity(c.value))?.value ?? null)
  const sameAsIdentity = (v: Rec): boolean => !identity || !hasIdentity(v) || sameTask(v, identity)
  const kept = candidates.filter((c) => c.source === SPEC_SOURCE || sameAsIdentity(c.value))

  /** 选"主"：① 规格路径优先（正常响应就是它 ⇒ 零回归）；② 顶层自己**有线路**时用它；③ 否则按顺序第一个 */
  const primary = candidates.find((c) => c.source === SPEC_SOURCE) ?? (self && lineCountOf(self) > 0 ? { source: 'self', value: self } : kept[0]!)

  let chosen = primary
  let adoptedFrom = ''
  if (lineCountOf(primary.value) <= 0 && (looksLikeEnvelope(raw) || looksLikeEnvelope(primary.value))) {
    const better = kept.find((c) => c !== primary && lineCountOf(c.value) > 0 && sameTask(c.value, primary.value))
    if (better) {
      chosen = better
      adoptedFrom = better.source
    }
  }

  return {
    task: chosen.value as unknown as MpSunrunTask,
    source: chosen.source,
    lineCount: lineCountOf(chosen.value),
    degraded: chosen.source !== SPEC_SOURCE || Boolean(adoptedFrom),
    adoptedFrom,
    candidates: names,
  }
}
