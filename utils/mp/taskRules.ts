/**
 * 任务约束自检（提交前的「能不能判合格」闸门）—— 纯函数，零依赖，有单测
 *
 * 用途：
 *   1. **提交前自检**：本地先算一遍，避免提交必然不合格的成绩（省一次真实上报）；
 *   2. **demo 展示**：把「合格/不合格 + 原因」逐条列出来，等 9-14 拿到真实约束值后直接可用。
 *
 * ⚠️ 口径诚实说明：任务约束字段名是 **2026-09-11 实测从 `camera/currentTimeMillis` 响应尾部拿到**的，
 *    但**取值与单位尚未实测**（`_mp-analyze/开跑前实测结论.md` §3）。因此本模块把规则分成三类：
 *      - `hard`     ：本地能确定判的（里程、拟合度阈值）→ **参与 pass 判定**
 *      - `inferred` ：单位/语义靠推断的（配速、时长、生效时段）→ 只提示，**不阻断**
 *      - `info`     ：纯展示
 *    9-14 读过一次真实 `getSunrunPaper` 后，把推断项按实测改准即可。
 */
import type { MpSunrunTask } from '../../src/mp/types'

export type TaskRuleConfidence = 'hard' | 'inferred' | 'info'

export interface TaskRuleItem {
  key: string
  label: string
  /** `undefined` = 口径未定或字段缺失，无法判定 */
  ok: boolean | undefined
  detail: string
  confidence: TaskRuleConfidence
  /** 口径备注（推断项写明依据） */
  note?: string
}

export interface TaskCheckInput {
  task: MpSunrunTask
  /** 实际里程（公里） */
  km: number
  /** 实际时长（秒） */
  durationSeconds: number
  /** 自算拟合度（0~1） */
  fitDegree: number
  /** 当前时刻（默认 now，测试可注入） */
  now?: Date
}

export interface TaskCheckResult {
  /** 全部 `hard` 规则通过（`inferred` 项不阻断） */
  pass: boolean
  items: TaskRuleItem[]
  /** `hard` 规则未通过的原因 */
  problems: string[]
}

/** HH:mm:ss → 秒（非法返回 undefined） */
export function parseClock(text: string | undefined): number | undefined {
  if (!text) return undefined
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text).trim())
  if (!m) return undefined
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)
}

/**
 * 把服务端的「速度/配速」取值统一换算成 **秒/公里**（口径推断，见文件头）。
 * - 数字 > 30  → 视为配速（秒/公里）
 * - 数字 ≤ 30  → 视为速度（米/秒）→ 1000 / v
 * - `5'30"` 形态 → 直接解析
 */
export function toPaceSecPerKm(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^\d+'\d{1,2}"?$/.test(trimmed)) {
      const [min, sec] = trimmed.replace('"', '').split("'")
      return Number(min) * 60 + Number(sec)
    }
    const asNumber = Number(trimmed)
    if (!Number.isFinite(asNumber)) return undefined
    return toPaceSecPerKm(asNumber)
  }
  if (!Number.isFinite(value) || value <= 0) return undefined
  return value > 30 ? value : 1000 / value
}

/** 把服务端的「时长」取值统一换算成 **秒**（口径推断：≤120 视为分钟） */
export function toDurationSeconds(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const asNumber = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(asNumber) || asNumber <= 0) return undefined
  return asNumber <= 120 ? asNumber * 60 : asNumber
}

const hhmmss = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/** 秒/公里 → `M'SS"` */
const paceText = (secPerKm: number): string => {
  const total = Math.round(secPerKm)
  return `${Math.floor(total / 60)}'${String(total % 60).padStart(2, '0')}"`
}

/**
 * 逐条评估一次跑步是否满足任务约束。
 * `pass` 只看 `hard` 项：里程达标 + 拟合度达标。
 */
export function evaluateRunAgainstTask(input: TaskCheckInput): TaskCheckResult {
  const { task, km, durationSeconds, fitDegree } = input
  const now = input.now ?? new Date()
  const items: TaskRuleItem[] = []
  const problems: string[] = []

  // 1) 里程（hard）
  const requiredKm = Number(task.mileage) || 0
  const kmOk = requiredKm <= 0 ? true : km >= requiredKm
  items.push({
    key: 'mileage',
    label: '里程达标',
    ok: kmOk,
    detail: `${km.toFixed(2)} km / 要求 ${requiredKm} km`,
    confidence: 'hard',
  })
  if (!kmOk) problems.push(`里程不足：${km.toFixed(2)} < ${requiredKm} km`)

  // 2) 拟合度阈值（hard；服务端执行的阈值，源码默认 0.6）
  const threshold = Number(task.fitDegree ?? 0.6)
  const fitOk = fitDegree >= threshold
  items.push({
    key: 'fitDegree',
    label: '拟合度达标',
    ok: fitOk,
    detail: `${fitDegree.toFixed(2)} / 阈值 ${threshold}`,
    confidence: 'hard',
    note: '阈值由服务端执行；客户端自算仅作预判',
  })
  if (!fitOk) problems.push(`拟合度不足：${fitDegree.toFixed(2)} < ${threshold}`)

  // 3) 配速区间（inferred：单位未实测）
  const pace = km > 0 ? durationSeconds / km : 0
  const minPace = toPaceSecPerKm(task.minSpeed)
  const maxPace = toPaceSecPerKm(task.maxSpeed)
  if (minPace === undefined && maxPace === undefined) {
    items.push({
      key: 'pace',
      label: '配速区间',
      ok: undefined,
      detail: '任务未下发 minSpeed/maxSpeed',
      confidence: 'info',
    })
  } else {
    const lower = Math.min(minPace ?? 0, maxPace ?? Number.POSITIVE_INFINITY)
    const upper = Math.max(minPace ?? 0, maxPace ?? Number.POSITIVE_INFINITY)
    const ok = pace >= lower && pace <= upper
    items.push({
      key: 'pace',
      label: '配速区间',
      ok,
      detail: `实际 ${paceText(pace)} / 要求 ${paceText(lower)} ~ ${paceText(upper)}`,
      confidence: 'inferred',
      note: 'minSpeed/maxSpeed 的单位与语义未实测（推断为配速上下限，未标准化前后已按小/大取值）',
    })
  }

  // 4) 时长区间（inferred：≤120 视为分钟）
  const minSeconds = toDurationSeconds(task.minTime)
  const maxSeconds = toDurationSeconds(task.maxTime)
  if (minSeconds === undefined && maxSeconds === undefined) {
    items.push({
      key: 'duration',
      label: '时长区间',
      ok: undefined,
      detail: '任务未下发 minTime/maxTime',
      confidence: 'info',
    })
  } else {
    const lower = Math.min(minSeconds ?? 0, maxSeconds ?? Number.POSITIVE_INFINITY)
    const upper = Math.max(minSeconds ?? 0, maxSeconds ?? Number.POSITIVE_INFINITY)
    const ok = durationSeconds >= lower && durationSeconds <= upper
    items.push({
      key: 'duration',
      label: '时长区间',
      ok,
      detail: `实际 ${hhmmss(durationSeconds)} / 要求 ${hhmmss(lower)} ~ ${hhmmss(upper)}`,
      confidence: 'inferred',
      note: 'minTime/maxTime 单位未实测（≤120 时按分钟解释）',
    })
  }

  // 5) 生效时段（inferred：服务端是否强校验未实测）
  const windows = (task.runTimeRuleList ?? [])
    .map((rule) => ({ start: parseClock(rule.startTime), end: parseClock(rule.endTime) }))
    .filter((w) => w.start !== undefined && w.end !== undefined)
  const fallbackStart = parseClock(task.startTime)
  const fallbackEnd = parseClock(task.endTime)
  if (windows.length === 0 && fallbackStart !== undefined && fallbackEnd !== undefined) {
    windows.push({ start: fallbackStart, end: fallbackEnd })
  }
  if (windows.length === 0) {
    items.push({
      key: 'window',
      label: '生效时段',
      ok: undefined,
      detail: '任务未下发时段规则',
      confidence: 'info',
    })
  } else {
    const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
    const inWindow = windows.some((w) => nowSeconds >= w.start! && nowSeconds <= w.end!)
    items.push({
      key: 'window',
      label: '生效时段',
      ok: inWindow,
      detail: `当前 ${hhmmss(nowSeconds)} / 允许 ${windows.map((w) => `${hhmmss(w.start!)}-${hhmmss(w.end!)}`).join('、')}`,
      confidence: 'inferred',
      note: '服务端是否强校验时段未实测',
    })
  }

  return { pass: items.filter((i) => i.confidence === 'hard').every((i) => i.ok !== false), items, problems }
}

/** 任务有效期文案（如 `2026-09-14 ~ 2027-01-10`） */
export function formatTaskPeriod(task: MpSunrunTask): string {
  const start = task.startDate || '—'
  const end = task.endDate || '—'
  return `${start} ~ ${end}`
}
