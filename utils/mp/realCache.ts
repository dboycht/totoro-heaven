/**
 * 「上次读取的会话」本地缓存的**纯数据层**（2026-09-18）
 *
 * 缓存里**只放两样东西**：任务（用来显示"本机存有上次读取的会话：<任务名>"）+ 当时选中的线路。
 *
 * ⚠️ 为什么**不存账号 / 开关 / 摄像头杆**（2026-09-18 用户确认）：
 *   「恢复上次会话」现在的语义是 **用本机 token 重新读取一遍**，压根不 apply 缓存里的旧值，
 *   存了也不会被读 ⇒ 那几个字段会变成"只写不读"的死数据（比不存更容易让人误解）。
 *   历史：1.1.4~1.1.9 只存 `{at, task, lineId}`；本轮曾短暂补存过 profile/switches/cameraFlag，
 *   简化后**已裁掉**，回到最小集合。
 *
 * 解析/归一化放在这里的意义：**纯函数、可离线单测**（老缓存、缺字段、类型不对都要安全降级），
 * 不依赖 `localStorage` 与 Vue 状态。
 */
import type { MpSunrunTask } from '~/src/mp/types'

/** 缓存负载（最小集合） */
export interface RealCachePayload {
  /** 写入时间（毫秒时间戳） */
  at: number
  task: MpSunrunTask
  /** 当时选中的线路 id（恢复时沿用，避免选线被重置） */
  lineId: string
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * 把任意历史数据归一化成 `RealCachePayload`：
 *   · 必须有 `task`（且是普通对象）——没有就返回 `null`（= 没有可用缓存）；
 *   · `at` 非有限数字归 0；`lineId` 非字符串归空串；
 *   · 老缓存里多余的字段（如曾经存过的 profile/switches）**直接忽略**，不报错。
 */
export function normalizeCachePayload(raw: unknown): RealCachePayload | null {
  if (!isObj(raw)) return null
  const task = raw.task
  if (!isObj(task)) return null
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0
  const lineId = typeof raw.lineId === 'string' ? raw.lineId : ''
  return { at, task: task as unknown as MpSunrunTask, lineId }
}

/** 序列化（写缓存用）——只写最小集合，绝不把整个 state 摊进去 */
export function serializeCachePayload(p: { at: number; task: MpSunrunTask; lineId: string }): string {
  const payload: RealCachePayload = { at: p.at, task: p.task, lineId: p.lineId }
  return JSON.stringify(payload)
}
