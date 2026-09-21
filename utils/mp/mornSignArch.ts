/**
 * 早操签到「记录」的入参构造与归一化（纯函数，可离线单测）—— 2026-09-21 新增
 *
 * **为什么之前读不出数据**：端点 `getMornSignArchDetail` 早就登记了，但 wrapper 只传了 `stuNumber`
 * （缺 `termId` 与 `monthId`）⇒ 服务端把它当成"没指定学期/月份"⇒ 回空数组。界面里也没有任何消费者。
 *
 * **权威依据**（厂商小程序 `app-service.js` 的 `getMorningData`）：
 * ```js
 * var t = this.data.morningDate.split("-")[1];   // monthId = 两位月份，如 "09"
 * u.request({ url: "/wxxcx/platform/mornSign/getMornSignArchDetail", method: "POST",
 *   data: { termId: this.data.termId, stuNumber: this.data.userInfo.snCode, monthId: t } })
 * // 返回顶层：scoreList / completedTimes / incompleteTimes / requireNumber / ifDayHasComSign
 * ```
 * 注意两点：① 字段名是 **`stuNumber`**（不是 snCode）；② **body 里不带 token**（鉴权走 `Authorization` 头）。
 *
 * ⚠️ **诚实标注**：`status` 的取值语义（0/1/2 各代表什么）**未在厂商源码里读到明确映射**，
 * 这里按"0=未签到、1=已签到、2=已签到（异常/补签）"的**推断**展示，并把原始状态一并显示出来，
 * 免得把推断当事实（真要定论得抓一次真实数据对比）。
 */

/** 签到记录接口的请求体（字段名必须与厂商一致：`stuNumber` / `monthId`） */
export interface MornSignArchParams {
  termId: string
  stuNumber: string
  monthId: string
}

/** 一条签到记录（`scoreList` 的元素；只取我们要展示的字段，原始对象一并留着排错） */
export interface MornSignArchRecord {
  date: string
  status: number
  statusText: string
  raw: Record<string, unknown>
}

export interface MornSignArchResult {
  /** 本月已签到次数（服务端下发） */
  completed: number
  /** 本月未签到次数（服务端下发） */
  incomplete: number
  /** 本月要求次数（服务端下发） */
  required: number
  /** 今天是否已签到（服务端下发 `ifDayHasComSign === "1"`） */
  todaySigned: boolean
  records: MornSignArchRecord[]
}

/** 当前月份 → 两位字符串（厂商是从 `morningDate.split("-")[1]` 取的） */
export const twoDigitMonth = (d: Date = new Date()): string => String(d.getMonth() + 1).padStart(2, '0')

/**
 * 构造请求体。判据：**`monthId` 必须是两位字符串**（"9" 与 "09" 在服务端可能不是一回事），
 * 且**学号字段名必须是 `stuNumber`**（照厂商源码，别想当然写 snCode）。
 */
export function buildMornSignArchParams(input: { snCode: string; termId: string; month: string }): MornSignArchParams {
  const month = String(input.month).trim()
  return {
    termId: String(input.termId).trim(),
    stuNumber: String(input.snCode).trim(),
    monthId: month.length === 1 ? `0${month}` : month,
  }
}

/** 最近 N 个月的可选项（最新在前），供界面切月份 */
export function recentMonthOptions(now: Date = new Date(), back = 5): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  for (let i = 0; i < back; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push({ value: twoDigitMonth(d), label: `${d.getFullYear()} 年 ${twoDigitMonth(d)} 月` })
  }
  return out
}

/** 状态文案（**推断**，见文件头注释；未知数值原样显示） */
export const mornSignStatusText = (status: number): string => {
  if (status === 0) return '未签到'
  if (status === 1) return '已签到'
  if (status === 2) return '已签到（异常/补签）'
  return `状态 ${status}`
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 归一化服务端返回。判据：**任何字段缺失/类型不对都不能抛**（页面要能渲染"暂无记录"而不是整页崩）。
 */
export function normalizeMornSignArch(data: unknown): MornSignArchResult {
  const d = (data ?? {}) as Record<string, unknown>
  const list = Array.isArray(d.scoreList) ? d.scoreList : []
  const records: MornSignArchRecord[] = list
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((x) => {
      const status = num(x.status)
      return {
        date: String(x.date ?? ''),
        status,
        statusText: mornSignStatusText(status),
        raw: x,
      }
    })
    .filter((r) => Boolean(r.date))
    .sort((a, b) => (a.date < b.date ? 1 : -1)) // 新的在前
  return {
    completed: num(d.completedTimes),
    incomplete: num(d.incompleteTimes),
    required: num(d.requireNumber),
    todaySigned: String(d.ifDayHasComSign ?? '') === '1',
    records,
  }
}
