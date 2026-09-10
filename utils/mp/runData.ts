/**
 * 提交数据构造与自洽性校验
 *
 * 背景：小程序服务端会（可能）校验「里程 × 时长 × 配速 × 步数」是否互相算得通，
 *       并且客户端本身有「瞬时速度 > 12 m/s 视为飞点」的同类规则。
 *       这里集中做数字格式化 + 自洽校验，避免提交出算术上不可能的数据。
 *
 * 逆向依据：`_mp-analyze/小程序逆向分析.md` 第 5.2 节（速度阈值）与第 5.4 节（cheatScore）
 */

import { pathLengthMeters, type LatLng } from './routeSimilarity'

/** 秒 → HH:mm:ss */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`
}

/** HH:mm:ss → 秒（非法返回 0） */
export function parseDuration(text: string): number {
  const parts = String(text || '').split(':').map((x) => Number(x) || 0)
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  return 0
}

/** 秒/公里 → 配速字符串 5'30" */
export function formatPace(secPerKm: number): string {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return `0'00"`
  const total = Math.round(secPerKm)
  const min = Math.floor(total / 60)
  const sec = total % 60
  return `${min}'${String(sec).padStart(2, '0')}"`
}

/** 配速字符串 → 秒/公里 */
export function parsePace(text: string): number {
  const m = /^(\d+)'(\d{1,2})"?$/.exec(String(text || '').trim())
  if (!m) return 0
  return Number(m[1]) * 60 + Number(m[2])
}

export interface RunStatsInput {
  /** 里程（公里） */
  distanceKm: number
  /** 时长（秒） */
  durationSeconds: number
  /** 步数（不给则按 1200 步/公里估算，对齐原版公式） */
  steps?: number
  /** 体重（kg），不给则不估算卡路里 */
  weightKg?: number
  /** runType：0 阳光跑 / 1 自由跑（提交口径） */
  runType?: number
}

export interface RunStats {
  km: string
  usedTime: string
  avgSpeed: string
  steps: string
  kcal?: string
  /** 校验是否通过 */
  ok: boolean
  /** 校验发现的问题 */
  problems: string[]
}

/** 步数估算：约 1200 步/公里（对齐原版数据生成公式） */
export const estimateSteps = (distanceKm: number, jitterRatio = 0.04): number => {
  const base = distanceKm * 1200
  // 用确定性抖动（不含随机源），保证同一输入结果稳定
  const factor = 1 + (Math.sin(distanceKm * 12.9898) * 43758.5453) % jitterRatio
  return Math.max(0, Math.round(base * factor))
}

/** 卡路里估算：跑步 MET≈8.0，kcal = MET × 体重(kg) × 小时数 */
export const estimateKcal = (weightKg: number, durationSeconds: number, met = 8): number =>
  Math.max(0, Math.round(met * weightKg * (durationSeconds / 3600)))

/**
 * 构造并校验提交数据
 * @param input 里程 / 时长 / 步数等
 */
export function buildRunStats(input: RunStatsInput): RunStats {
  const problems: string[] = []
  const { distanceKm, durationSeconds } = input

  if (!(distanceKm > 0)) problems.push('里程必须大于 0')
  if (!(durationSeconds > 0)) problems.push('时长必须大于 0')

  const avgSpeedSecPerKm = distanceKm > 0 ? durationSeconds / distanceKm : 0
  const avgSpeedMps = durationSeconds > 0 ? (distanceKm * 1000) / durationSeconds : 0

  // 客户端同类规则：瞬时速度 > 12 m/s 视为飞点；这里用平均值做粗筛
  if (avgSpeedMps > 12) problems.push(`平均速度 ${avgSpeedMps.toFixed(2)} m/s 超过 12 m/s（会被判飞点）`)
  if (avgSpeedMps > 0 && avgSpeedMps < 0.5) problems.push(`平均速度 ${avgSpeedMps.toFixed(2)} m/s 过低，疑似静止`)
  if (avgSpeedSecPerKm > 0 && (avgSpeedSecPerKm < 120 || avgSpeedSecPerKm > 1200)) {
    problems.push(`配速 ${formatPace(avgSpeedSecPerKm)} 超出常见范围（2'00"~20'00"）`)
  }

  const steps = input.steps ?? estimateSteps(distanceKm)

  return {
    km: Number(distanceKm).toFixed(2),
    usedTime: formatDuration(durationSeconds),
    avgSpeed: formatPace(avgSpeedSecPerKm),
    steps: String(steps),
    kcal: input.weightKg ? String(estimateKcal(input.weightKg, durationSeconds)) : undefined,
    ok: problems.length === 0,
    problems,
  }
}

/** 轨迹逐点速度检查（返回异常点索引） */
export function findSpeedOutliers(points: LatLng[], timestampsMs: number[], maxMps = 12): number[] {
  const bad: number[] = []
  if (points.length < 2) return bad
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const dt = (timestampsMs[i]! - timestampsMs[i - 1]!) / 1000
    if (dt <= 0) continue
    const d = pathLengthMeters([a, b])
    if (d / dt > maxMps) bad.push(i)
  }
  return bad
}

/**
 * 时间字段构造
 * 小程序源码按 `split('T')` 取段：evaluateDate=第0段、startTime/endTime=第1段。
 * ⚠️ 真实格式（是否带时区、是否 T 分隔）需真包验证（TODO(verify)）。
 */
export interface TimeFields {
  evaluateDate: string
  startTime: string
  endTime: string
  /** 内部使用的完整时间戳 */
  createTimeISO: string
  endTimeISO: string
}

export function buildTimeFields(startMs: number, endMs: number): TimeFields {
  const pad = (n: number) => String(n).padStart(2, '0')
  const fmtDate = (ms: number) => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const fmtTime = (ms: number) => {
    const d = new Date(ms)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }
  const iso = (ms: number) => {
    const d = new Date(ms)
    return `${fmtDate(ms)}T${fmtTime(ms)}`
  }
  return {
    evaluateDate: fmtDate(startMs),
    startTime: fmtTime(startMs),
    endTime: fmtTime(endMs),
    createTimeISO: iso(startMs),
    endTimeISO: iso(endMs),
  }
}
