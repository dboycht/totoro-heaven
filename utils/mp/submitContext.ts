/**
 * 「这次提交到底能不能发」的**前置上下文校验**（纯逻辑层，可离线单测）—— 2026-09-23 新增（pre3 事故）
 *
 * ## 为什么要抽成纯函数
 * 用户实测（研究生院「研途健行」2.4 km，自由路线任务）：门禁已经按 pre3 放行（`allow=true`），
 * 但提交前的**另一处**内联校验判了"没有可提交的线路/任务号"⇒ **`getRunBegin` 一个都没发出去**
 * （日志实证：`getRunBegin` / `sunRunExercises` / `sunRunExercisesDetail` 各 0 条）⇒
 * 用户"走到最后一步却提交不了"。内联在 composable 里 ⇒ **没法离线单测**，于是同一条判据被写歪了也没人发现。
 * 现在判据收口到本模块（`composables/real/submit.ts` 只调用它），`tests/mp/submitContext.test.ts` 钉住两个方向。
 *
 * ## 判据（可执行；顺序即优先级）
 * 0. **自由跑**（`runType === 1`）⇒ 厂商口径不打卡、不取线路、不带任务号 ⇒ 只要有会话+档案就放行；
 * 1. **没有会话或档案** ⇒ 拦（报文没有 token ⇒ 必然失败），提示**指路**去工作台；
 * 2. **没有任务** ⇒ 拦（阳光跑的成绩归属靠任务号），提示**指路**；
 * 3. **任务号取不到**（`taskPaperIdOf()` 三者皆空）⇒ 拦（报文里既不会有 lineId 也不会有 paperId，成绩无从归属），提示**指路**；
 * 4. **任务下发了线路**（`lineRequired !== false`）**但没选线路** ⇒ 拦（**老行为零回归**）；
 * 5. **任务未下发线路**（自由路线任务）+ 有任务 + 有任务号 ⇒ **放行**（线路为空是必然的，不许再拦 ✗）。
 *
 * ⚠️ 口径边界：本模块**只判"能不能发"**，不构造任何报文 —— `lineId` 是否空串、`paperId` 用哪个字段，
 * 由 `utils/mp/submitPayload.ts` 那唯一一处构造器决定（判据与构造器分开，谁都不许另写一份）。
 */
import { taskPaperIdOf } from './taskShape'

/** 拦截原因代号（诊断上报 / 断言用） */
export type SubmitContextReason = 'ok' | 'no-session' | 'no-task' | 'no-task-id' | 'no-line'

export interface SubmitContextInput {
  /** 会话 token（`session.value?.token`） */
  token?: string | null
  /** 档案是否已读到（`Boolean(profile.value)`） */
  hasProfile?: boolean
  /** `0` 阳光跑 / `1` 自由跑 */
  runType?: 0 | 1
  /** 当前任务（真实任务对象，**可能是厂商原样对象：顶层没有 `taskId`**） */
  task?: unknown
  /** 任务是否要求指定线路（`routeRequirementOf(task).kind === 'line'` 的结果） */
  lineRequired?: boolean
  /** 调用方选中的线路（自由路线任务恒为 null/undefined） */
  line?: unknown
  /** 调用方已经算好的任务号（缺省/空串时由 `taskPaperIdOf(task)` 兜底） */
  paperId?: string | null
}

export interface SubmitContextResult {
  ok: boolean
  /** `ok:false` 时的原因代号 */
  reasonCode: SubmitContextReason
  /** 给人看的一句话；`ok:true` 时为空串 */
  message: string
  /** **最终采用的任务号**（`taskId`/`paperId`/`id` 兜底链的结果；自由路线任务提交时靠它归属成绩） */
  paperId: string
}

/** 一句话指路（所有缺上下文的提示都必须带上它，别只说"缺少…"让用户发懵） */
const HOW_TO_FIX = '请先回「工作台」点「一键获取 token」并「读取真实账号与任务」，再回跑步页提交。'

export function evaluateSubmitContext(input: SubmitContextInput): SubmitContextResult {
  const paperId = String(input.paperId || taskPaperIdOf(input.task) || '')
  const freeRun = input.runType === 1

  // ① 会话 + 档案（两种跑法都要）：没有 token 报文必然被服务端拒
  if (!input.token || !input.hasProfile) {
    return { ok: false, reasonCode: 'no-session', message: `还没读到真实会话/档案：${HOW_TO_FIX}`, paperId }
  }
  // ② 自由跑：厂商在该模式下不取线路、不带任务号 ⇒ 到这里就放行
  if (freeRun) return { ok: true, reasonCode: 'ok', message: '', paperId }

  // ③ 任务本身（阳光跑的约束与任务号都从它来）
  if (!input.task) {
    return { ok: false, reasonCode: 'no-task', message: `还没读到任务：${HOW_TO_FIX}`, paperId }
  }
  /**
   * ④ 任务号兜底链全空 **且没有线路可以提供 taskId** ⇒ 报文里既无 lineId 也无 paperId，成绩无从归属
   *    （**这是真必须拦的一条**）。⚠️ 判据里带 `!input.line`：**有线路时**报文构造器取的是
   *    `line.taskId`（`utils/mp/submitPayload.ts`），此时任务对象没有任务号是**老行为允许**的 ⇒
   *    不许在这里多拦（线条目任务零回归）。
   */
  if (!paperId && !input.line) {
    return {
      ok: false,
      reasonCode: 'no-task-id',
      message: `这个任务没有任务号（taskId / paperId / id 都是空的）：${HOW_TO_FIX}`,
      paperId,
    }
  }
  // ⑤ 任务**下发了线路**却还没选 ⇒ 老行为：拦（零回归）
  if (input.lineRequired !== false && !input.line) {
    return {
      ok: false,
      reasonCode: 'no-line',
      message: '本任务指定了线路，但你还没选：请在跑步页「线路」下拉里选一条再提交（本机路线库里没描过的线路不会出现在下拉里）。',
      paperId,
    }
  }
  // ⑥ 自由路线任务（未下发线路）+ 有任务 + 有任务号 ⇒ **放行**（线路为空是必然的）
  return { ok: true, reasonCode: 'ok', message: '', paperId }
}
