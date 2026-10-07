/**
 * 「待补交的轨迹明细」——**成绩已提交成功、但轨迹明细还没发出去**时的那笔欠账。
 *
 * ## 为什么要有它（2026-10-07 实测事故）
 * 用户的真实提交：`sunRunExercises` **提交成功**（20:53:41，耗时 13.8 s），
 * 而紧随其后的 `sunRunExercisesDetail`（轨迹明细）**一个请求都没发出去** ——
 * 日志里该端点出现次数 = **0**。原因是**切标签页后 Edge 冻结/丢弃了页面**：
 * 成绩响应刚回来、还没走到"发明细"那一步，JS 上下文就没了。
 * 后果与 **E33** 同族：**云端成绩有效、但没有轨迹**（详情页地图空白）。
 * ⚠️ 旧实现**完全不落盘** ⇒ 页面一死，"这笔还欠一条轨迹"这件事就没人知道了（界面也不会提示）。
 *
 * ## 口径
 * 1. 成绩成功、**在发明细之前**就把这笔欠账（**含轨迹点本体**）落盘 —— 明细成功后清掉；
 * 2. 落盘的是**点本体 + 时间口径**（不存种子）：补交时能**逐点重现同一笔**，不依赖"再生成一次是否等价"；
 * 3. **补交由用户点一次发一次**（不自动重试、不设定时器），与早操签到同一套纪律；
 * 4. 坏数据一律安全降级（绝不抛），超量/畸形点列拒绝落盘（宁可少存，也不要把 localStorage 撑爆）。
 */

/** localStorage 键：待补交的轨迹明细（明细成功后删除；同一时刻只保留**最近一笔**） */
export const PENDING_DETAIL_KEY = 'mp_pending_detail'

/** 点列上限（保护 localStorage：正常一笔 3.2 km ≈ 1100 点；超过这个数一定是坏数据） */
export const PENDING_DETAIL_MAX_POINTS = 20000

export interface PendingDetailPoint {
  latitude: number
  longitude: number
}

export interface PendingDetail {
  /** 服务端场次号（补交时唯一要带对的东西） */
  scantronId: string
  /** 任务号（成绩归属；自由跑为空串） */
  taskId: string
  /** 官方线路 id（自由跑/未下发线路为空串） */
  lineId: string
  /** 0 阳光跑 / 1 自由跑 */
  runType: number
  /** 里程（km） */
  km: number
  /** 计划时长（秒）—— 明细里每个点的 `time` 由它和 `startMs` 算出 */
  durationSeconds: number
  /** 起跑时刻（毫秒） */
  startMs: number
  /** 提交时刻（毫秒） */
  endMs: number
  /** 那次真正要发的轨迹点（**逐点重现**靠它） */
  points: PendingDetailPoint[]
  /** 落盘时刻 */
  at: number
  /** 已经补交过几次（如实显示，别假装没试过） */
  attempts: number
  /** 上次补交失败的原话（空串=还没试过/上次成功） */
  lastError: string
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 点列归一化：坐标必须是有限数；**空/超量/畸形一律返回 null**（调用方据此拒绝落盘） */
export function normalizePendingPoints(raw: unknown): PendingDetailPoint[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PENDING_DETAIL_MAX_POINTS) return null
  const out: PendingDetailPoint[] = []
  for (const p of raw) {
    if (!isObj(p)) return null
    const latitude = num(p.latitude)
    const longitude = num(p.longitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    out.push({ latitude, longitude })
  }
  return out
}

/** 从 localStorage 读到的原始文本解析成待补交记录；**任何坏数据一律 null（绝不抛）** */
export function parsePendingDetail(raw: unknown): PendingDetail | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const o = JSON.parse(raw) as unknown
    if (!isObj(o)) return null
    const scantronId = str(o.scantronId)
    if (!scantronId) return null
    const points = normalizePendingPoints(o.points)
    if (!points) return null
    const startMs = num(o.startMs)
    const durationSeconds = num(o.durationSeconds)
    const km = num(o.km)
    if (!Number.isFinite(startMs) || !Number.isFinite(durationSeconds) || !Number.isFinite(km)) return null
    if (durationSeconds <= 0 || km <= 0) return null
    return {
      scantronId,
      taskId: str(o.taskId),
      lineId: str(o.lineId),
      runType: num(o.runType) === 1 ? 1 : 0,
      km,
      durationSeconds,
      startMs,
      endMs: Number.isFinite(num(o.endMs)) ? num(o.endMs) : startMs + durationSeconds * 1000,
      points,
      at: Number.isFinite(num(o.at)) ? num(o.at) : 0,
      attempts: Number.isFinite(num(o.attempts)) && num(o.attempts) > 0 ? Math.floor(num(o.attempts)) : 0,
      lastError: str(o.lastError),
    }
  } catch {
    return null
  }
}

export function serializePendingDetail(d: PendingDetail): string {
  return JSON.stringify(d)
}

const two = (n: number) => String(n).padStart(2, '0')
/** 落盘时刻 → `MM-DD HH:mm`（只给界面看，别拿它当判据） */
export function pendingDetailWhen(d: PendingDetail): string {
  const t = new Date(d.at || d.startMs)
  return `${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}`
}
/** 计划时长 → `HH:mm:ss`（与报文口径一致） */
export function pendingDetailUsedTime(d: PendingDetail): string {
  const s = Math.max(0, Math.round(d.durationSeconds))
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
}

/**
 * 界面/日志用的人话摘要（**不含 markdown 标记**：用户可见文本有守卫）。
 * 必须带上**场次号**与"点了才发"的性质，别让用户以为它会自己好。
 */
export function pendingDetailSummary(d: PendingDetail): string {
  const tried = d.attempts > 0 ? `（已补交 ${d.attempts} 次，上次失败：${d.lastError || '未给出原因'}）` : ''
  return (
    `有一笔成绩的轨迹没交上：场次 ${d.scantronId}，${d.km.toFixed(2)} km / ${pendingDetailUsedTime(d)}，` +
    `记录于 ${pendingDetailWhen(d)}。${tried}` +
    '这就是"云端成绩有效、但详情页没有轨迹"的那种情况 —— 补交就是把那次生成的轨迹明细再发一次' +
    '（每点带时间、与当时的里程/时段一致）；只在你点的时候发一次，不自动重试。'
  )
}

/** 提交过程清单里那一行（短） */
export function pendingDetailProgressNote(d: PendingDetail): string {
  return `已记下"待补交轨迹"（场次 ${d.scantronId}）：成绩之后会立刻发明细，若这中间页面被杀，下次启动仍能补交`
}
