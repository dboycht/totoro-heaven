/**
 * 「上次读取的会话」本地缓存的**纯数据层**（2026-09-18 新增）
 *
 * 为什么单独抽出来：缓存里现在要存**账号 + 任务 + 开关**（而不再只有任务），
 * 解析/归一化必须能离线单测（历史缓存、字段缺失、类型不对都要安全降级）。
 *
 * 历史沿革：
 *   · 1.1.4~1.1.9：缓存只有 `{ at, task, lineId }` ⇒ 点「恢复上次任务」后
 *     **账号面板与一票否决项永远是"未读取"**（用户 2026-09-18 实测反馈）。
 *   · 现在：补存 `profile` / `switches` / `cameraFlag`，并在恢复时**优先用 token 重新读取**。
 */
import type { MpRealProfile, MpSunrunTask } from '~/src/mp/types'

/** 缓存负载（**向后兼容**：老缓存没有下面后三个字段） */
export interface RealCachePayload {
  /** 写入时间（毫秒时间戳） */
  at: number
  task: MpSunrunTask
  /** 当时选中的线路 id */
  lineId: string
  /** 学生档案（老缓存没有 ⇒ undefined） */
  profile?: MpRealProfile
  /** 人脸 / 抽查开关（老缓存没有 ⇒ undefined） */
  switches?: Record<string, string>
  /** 摄像头杆 flag（按线路；老缓存没有 ⇒ undefined） */
  cameraFlag?: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * 把任意历史数据归一化成 `RealCachePayload`（纯函数）：
 *   · 必须有 `task`（且看起来是个对象）——没有就返回 `null`（= 没有可用缓存）；
 *   · `profile` 只有"像档案"（有 snCode）时才收，避免把垃圾数据写进界面状态；
 *   · `switches` 只收"值是字符串/数字的普通对象"；`cameraFlag` 只收布尔。
 */
export function normalizeCachePayload(raw: unknown): RealCachePayload | null {
  if (!isObj(raw)) return null
  const task = raw.task
  if (!isObj(task)) return null

  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0
  const lineId = typeof raw.lineId === 'string' ? raw.lineId : ''

  const out: RealCachePayload = { at, task: task as unknown as MpSunrunTask, lineId }

  const p = raw.profile
  if (isObj(p) && typeof p.snCode === 'string' && p.snCode) {
    out.profile = p as unknown as MpRealProfile
  }

  const sw = raw.switches
  if (isObj(sw)) {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(sw)) {
      if (typeof v === 'string') clean[k] = v
      else if (typeof v === 'number' && Number.isFinite(v)) clean[k] = String(v)
    }
    if (Object.keys(clean).length) out.switches = clean
  }

  if (typeof raw.cameraFlag === 'boolean') out.cameraFlag = raw.cameraFlag

  return out
}

/** 序列化（写缓存用；只写需要的字段，避免把整个 state 摊进去） */
export function serializeCachePayload(p: {
  at: number
  task: MpSunrunTask
  lineId: string
  profile?: MpRealProfile | null
  switches?: Record<string, string> | null
  cameraFlag?: boolean | null
}): string {
  const payload: RealCachePayload = {
    at: p.at,
    task: p.task,
    lineId: p.lineId,
    ...(p.profile ? { profile: p.profile } : {}),
    ...(p.switches ? { switches: p.switches } : {}),
    ...(typeof p.cameraFlag === 'boolean' ? { cameraFlag: p.cameraFlag } : {}),
  }
  return JSON.stringify(payload)
}
