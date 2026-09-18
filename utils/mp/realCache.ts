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
