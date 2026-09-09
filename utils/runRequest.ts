import { gaussian } from './generateRoute'

const pad2 = (a: number | string) => (Number(a) >= 0 && Number(a) <= 9 ? `0${Number(a).toString()}` : String(a))

export const formatHHmmss = (totalSeconds: number) => {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
}

const timeOnly = (date: Date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`

export const formatDateTime = (date: Date, withTime = true) => {
  const y = date.getFullYear()
  const mo = pad2(date.getMonth() + 1)
  const d = pad2(date.getDate())
  if (!withTime) return `${y}-${mo}-${d}`
  return `${y}-${mo}-${d} ${timeOnly(date)}`
}

export const durationBetween = (start: Date, end: Date) => {
  const diff = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000))
  return {
    hours: Math.floor(diff / 3600),
    minutes: Math.floor((diff % 3600) / 60),
    seconds: diff % 60,
  }
}

/** sha256 的 hex，取前 32 位（原版 mac 字段生成方式） */
export const sha256short = async (input: string): Promise<string> => {
  const t = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(t))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 32)
}

export interface RunRequestInput {
  distance: number
  routeId: string
  taskId: string
  token: string
  schoolId?: string
  stuNumber: string
  phoneNumber?: string
  minTime: number // 分钟
  maxTime: number // 分钟
  /** 补跑日期（yyyy-MM-dd），为空则按当天 */
  targetDate?: string
}

/** 构造阳光跑提交请求 + 计算的结束时间（原版 ha 函数） */
export const buildRunRequest = async ({
  distance,
  routeId,
  taskId,
  token,
  stuNumber,
  // minTime/maxTime 来自试卷，单位为分钟
  minTime,
  maxTime,
  targetDate,
}: RunRequestInput) => {
  const { minSecond, maxSecond } = { minSecond: Number(minTime) * 60, maxSecond: Number(maxTime) * 60 }
  // 与原版 generateSunRunExercisesReq 完全一致：
  // 均值 = minSecond + maxSecond/2；σ = (maxSecond - 均值) / 3
  const mean = minSecond + maxSecond / 2
  const std = Math.max(0, (maxSecond - mean) / 3)
  const durationSeconds = Math.floor(gaussian(mean, std))
  // 补跑支持：指定 targetDate 时，起跑时间锚定到该日（保留当天时刻，跨日到次日也属正常）
  const now = new Date()
  let start: Date
  if (targetDate) {
    start = new Date(`${targetDate}T${timeOnly(now)}+08:00`)
  } else {
    start = new Date()
  }
  const end = new Date(Number(start) + durationSeconds * 1000)
  const avgSpeed = (Number(distance) / (durationSeconds / 3600)).toFixed(2)
  const dur = durationBetween(start, end)
  const mac = await sha256short(stuNumber || '')

  return {
    req: {
      LocalSubmitReason: '',
      avgSpeed,
      baseStation: '',
      endTime: timeOnly(end),
      evaluateDate: formatDateTime(end),
      fitDegree: '1',
      flag: '1',
      headImage: '',
      ifLocalSubmit: '0',
      km: distance,
      mac,
      phoneInfo: '$CN11/iPhone15,4/17.4.1',
      phoneNumber: '',
      pointList: '',
      routeId,
      runType: '0', // 阳光跑
      sensorString: '',
      startTime: timeOnly(start),
      steps: `${1000 + Math.floor(Math.random() * 1000)}`,
      stuNumber,
      taskId,
      token,
      usedTime: formatHHmmss(dur.hours * 3600 + dur.minutes * 60 + dur.seconds),
      version: '1.2.14',
      warnFlag: '0',
      warnType: '',
      faceData: '',
    },
    endTime: end,
  }
}