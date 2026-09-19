/**
 * 早操签到「提交」的**纯逻辑层**（2026-09-19）
 *
 * ## 这个模块为什么存在 / 边界在哪
 * ⚠️ **这是一条显式的越线实现，由用户明确要求**（2026-09-19）：
 *   厂商的签到靠"定位落在点位范围内 + **扫到点位上贴的二维码**"来证明"人到了现场"。
 *   而 `qrCode` 是**服务端下发的期望值**，小程序拿"扫码结果"与它做**本地字符串比对**
 *   （见 `_mp-analyze/第三方9_17-早签模块分析.md` §5.2）—— 也就是说，**提交时把下发值填进去，
 *   与"人真扫到"在服务端看来完全相同**。本模块实现的正是这条路径。
 *
 * 因此本模块的定位是"**用户自己按按钮的一次性提交**"，并配套三条硬约束（都在调用方落实）：
 *   ① **不自动**：没有定时器、没有后台任务、没有队列 —— 只有用户点击才会走；
 *   ② **不重试**：提交失败就失败，绝不自动重发（写操作非幂等）；
 *   ③ **只在窗口内允许**：窗口取自服务端返回（`startTime`/`endTime`，**不硬编码**）。
 *
 * 本文件只做"拼字段 / 判窗口 / 判结果"三件纯事，**不发起任何请求**（发请求在 `utils/mp/mornSignSubmit.ts`）。
 */
import type { MpMornSignPoint, MpMornSignTask } from '~/src/mp/types'

/** 提交载荷（16 字段，逐字段对齐厂商真包口径） */
export interface MornSignSubmitPayload {
  taskId: string
  iLocalSubmit: '0'
  /** 提交时刻 `YYYY-MM-DD HH:mm:ss`（**必须上海时区**，服务端按这个 + 自己的时钟判窗口） */
  signDate: string
  stuNumber: string
  token: string
  phoneNumber: string
  /** ⚠️ 服务端下发的**期望二维码值**（不是"人真扫到"的值 —— 见文件头说明） */
  qrCode: string
  headImage: string
  baseStation: string
  longitude: string
  latitude: string
  phoneInfo: string
  mac: string
  pointId: string
  appVersion: string
  signType: string
}

/**
 * 把任意时刻格式化成**上海时区**的 `YYYY-MM-DD HH:mm:ss`。
 *
 * ⚠️ 必须显式指定时区（借鉴第三方 `formatShanghaiDateTime`）：`signDate` 是服务端判窗口的依据之一，
 *    若程序跑在非中国时区的机器上，用本机时间会直接错开几小时。纯本地实现、不依赖 Intl 的时区数据库可靠性。
 */
export function formatShanghaiDateTime(ms: number = Date.now()): string {
  const shifted = new Date(ms + 8 * 3600 * 1000) // UTC+8
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`
  )
}

/** `HH:mm` 或 `HH:mm:ss` → 自当日 0 点起的分钟数（非法返回 null） */
export function parseClockMinutes(text: string | undefined | null): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(text ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null
  return h * 60 + min
}

export interface MornSignWindowState {
  /** 窗口是否可解析 */
  known: boolean
  /** 当前是否在窗口内 */
  inside: boolean
  /** 距窗口开始还剩多少分钟（已开始为 0） */
  minutesUntilStart: number
  /** 距窗口结束还剩多少分钟（已结束为 0） */
  minutesUntilEnd: number
  /** 给用户的一句话 */
  reason: string
}

/**
 * 判断"现在能否签到"。**窗口完全取自服务端返回的 `startTime`/`endTime`**（不硬编码 ——
 * 不同校区/年级的窗口可能不同，已实测"同账号连读两次一致、服务端按 token 认人"）。
 *
 * `nowMs` 可注入，便于单测；判断用**上海时区的当日分钟数**，与本机时区无关。
 */
export function evaluateMornSignWindow(task: MpMornSignTask | null, nowMs: number = Date.now()): MornSignWindowState {
  const start = parseClockMinutes(task?.startTime)
  const end = parseClockMinutes(task?.endTime)
  if (start === null || end === null || end <= start) {
    return {
      known: false,
      inside: false,
      minutesUntilStart: 0,
      minutesUntilEnd: 0,
      reason: '读不到签到时段（服务端未下发 startTime/endTime）—— 无法判断现在能否签到',
    }
  }
  const shifted = new Date(nowMs + 8 * 3600 * 1000)
  const nowMin = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  const inside = nowMin >= start && nowMin <= end
  const minutesUntilStart = nowMin < start ? start - nowMin : 0
  const minutesUntilEnd = nowMin <= end ? end - nowMin : 0
  const hhmm = (mins: number) =>
    `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
  const reason = inside
    ? `现在在签到时段内（${hhmm(start)}–${hhmm(end)}），距结束还剩 ${minutesUntilEnd} 分钟`
    : nowMin < start
      ? `还没到签到时段（${hhmm(start)} 开始，还有 ${minutesUntilStart} 分钟）`
      : `已过签到时段（${hhmm(end)} 结束）——服务端会拒收`
  return { known: true, inside, minutesUntilStart, minutesUntilEnd, reason }
}

/**
 * 组装 16 字段（缺任一"四要素"直接抛错，避免发出残缺请求）。
 *
 * ⚠️ 2026-09-19 审计 R16：**不再接收 `task` 参数** —— 原签名里有个 `task` 却从不使用
 *    （16 字段里只有 `taskId` 来自点位；`signType` 恒为厂商真包里的 `'0'`），
 *    留着会让调用方误以为"任务会影响报文"，测试还得专门传个假 task 来证明它被忽略。
 */
export function buildMornSignPayload(input: {
  point: MpMornSignPoint
  snCode: string
  token: string
  nowMs?: number
  /** 浏览器/系统 UA（上游用它填 phoneInfo；缺省给一个 Windows 串） */
  phoneInfo?: string
}): MornSignSubmitPayload {
  const { point, snCode, token } = input
  if (!point.taskId || !point.latitude || !point.longitude || !point.qrCode) {
    throw new Error('当前签到点位资料不完整（缺 taskId/坐标/qrCode），无法提交')
  }
  if (!snCode) throw new Error('缺少学号（snCode）')
  if (!token) throw new Error('缺少 token')
  return {
    taskId: point.taskId,
    iLocalSubmit: '0',
    signDate: formatShanghaiDateTime(input.nowMs),
    stuNumber: snCode,
    token,
    phoneNumber: '',
    qrCode: String(point.qrCode),
    headImage: '',
    baseStation: '',
    longitude: String(point.longitude),
    latitude: String(point.latitude),
    phoneInfo: String(input.phoneInfo || 'microsoft&microsoft&Windows 11 x64').slice(0, 512),
    mac: '',
    pointId: point.pointId,
    appVersion: '1.0.0',
    // 厂商真包里恒为 '0'（第三方亦如此；**不**用服务端返回的 signType —— 那会导致字段形状不同）
    signType: '0',
  }
}

/** 提交结果（只保留"判定 + 原文"两样，便于界面如实展示） */
export interface MornSignSubmitOutcome {
  /** 服务端是否接受（`code === '0'`） */
  accepted: boolean
  /** 服务端消息（成功时通常为空） */
  message: string
  /** 原始响应文本（界面折叠展示，便于对账） */
  raw: string
}

/** 判定 `morningExercises` 的响应：**成功只看 `code === '0'`**（实测窗口外为 `code:'1'` + 明确的 message） */
export function judgeMornSignSubmit(rawText: string): MornSignSubmitOutcome {
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(rawText) as Record<string, unknown>
  } catch {
    parsed = null
  }
  if (!parsed) return { accepted: false, message: '响应不是 JSON（可能被网关拦截）', raw: rawText.slice(0, 800) }
  const code = String(parsed.code ?? '')
  const message = String(parsed.message ?? parsed.msg ?? '')
  return { accepted: code === '0', message, raw: rawText.slice(0, 800) }
}
