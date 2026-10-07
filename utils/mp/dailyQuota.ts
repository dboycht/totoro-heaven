/**
 * 「今日该任务次数已达上限」——服务端在 `getRunBegin` 阶段的**每日配额**拒绝。
 *
 * ## 实测（2026-10-07）
 * 同一任务当天已经真实提交成功过一笔后，再按「真实提交」时厂商回
 * `status:"01" code:"1" msg:"该任务次数今日已达上限!"`。
 * 这是**服务端按"任务 + 当天"的配额**判定 ——
 * 不是本机操作错、不是报文格式问题、也没有参数可补，而且**当天内再试还是会被拒**。
 *
 * ## 口径（与「自由跑未开通」`freeRun.ts` 保持同一套形状）
 * 1. 把服务端原话**翻译成人话**（不要说成"开跑失败"，那会让人以为是本程序的错）；
 * 2. **记住今天**（`{date, paperId, message}`，跨天自动失效 ⇒ 不依赖任何清理逻辑）；
 * 3. 下次开跑前就把入口**标灰并说明原因**，同时留一个「仍要试一次」的出口
 *    （配额也可能被服务端放宽，不能把用户永久挡在门外）。
 *
 * ⚠️ 本文件是**纯逻辑层**（`utils/mp/**`）：不许碰 localStorage / Nuxt。读写盘由
 *    `composables/real/state.ts` 那层薄壳负责，这里只做"解析 + 判定 + 文案"。
 */

/** localStorage 键：今日已满的标记（跨天失效，所以不需要跟着"退出登录/清空数据"清） */
export const DAILY_QUOTA_KEY = 'mp_daily_quota_reached'

export interface DailyQuotaMark {
  /** 本地日期键 `YYYY-MM-DD`（判"是不是今天"） */
  date: string
  /** 该配额属于哪个任务（任务号；空串 = 当时没拿到任务号，按"任意任务"处理） */
  paperId: string
  /** 服务端原话（界面要原样带出来，便于用户核对与反馈） */
  message: string
}

/**
 * 本地日期键（**按本机时区**）。
 * 判据：配额是"当天"的概念 ⇒ **不能用 UTC 切日** —— 东八区的 08:xx 在 UTC 还是前一天，
 * 用 UTC 会让"今天已满"标记在每天早上 8 点前提前失效（或晚失效）。
 */
export function localDateKey(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * 服务端的回复是不是"今日次数已满"。
 * 判据 = **同时**命中"配额主体"（次数 / 名额）与"到达上限"（上限 / 已满 / 用完 / 用尽 / 已达），
 * 避免把别的失败文案误判（例如"次数不足""请重新登录"）。
 * 已知实测原话：`该任务次数今日已达上限!`
 */
export const isDailyQuotaReachedMessage = (msg: unknown): boolean => {
  const s = String(msg ?? '')
  if (!s) return false
  return /(次数|名额)/.test(s) && /(上限|已满|用完|用尽|已达)/.test(s)
}

/**
 * 翻译成人话（**必须带服务端原话**，用户要拿它去核对/反馈）。
 * ⚠️ 用户可见文本：不得含 markdown 标记（有专门的守卫在跑）。
 */
export function dailyQuotaNotice(msg: unknown): string {
  const raw = String(msg ?? '').trim() || '该任务次数今日已达上限！'
  return (
    `今天这个任务的次数已经用完了 —— 服务端原话：${raw}` +
    '（这是学校/任务的每日次数配额，不是本程序的错误，也不是报文格式问题）' +
    '今天再提交同一个任务仍会被拒；等过了今天（或按学校规则）再试。本地模拟与预览不受影响。'
  )
}

/** 提交过程清单里那一步的说明（与上面的人话分开写：清单里要短） */
export function dailyQuotaProgressNote(msg: unknown): string {
  const raw = String(msg ?? '').trim() || '该任务次数今日已达上限！'
  return `② 说明：服务端说今天这个任务的次数已用完（原话：${raw}）⇒ 不是本机操作或报文的问题，今天不必反复重试`
}

/**
 * 标记是否**此刻仍然有效**（同一天 + 同一个任务）。
 * - 跨天 ⇒ 失效（配额按天重置，但我们**不假设**服务端一定是按天：下一轮真试一次即可，所以留了「仍要试一次」出口）；
 * - 标记里没记任务号（当时没拿到）⇒ 按"当前任务"算，**不要因为缺字段就当无效**（否则会白放行、多挨一次拒）。
 */
export function isQuotaMarkActive(
  mark: DailyQuotaMark | null | undefined,
  paperId: string,
  now: Date = new Date(),
): boolean {
  if (!mark || typeof mark !== 'object') return false
  if (mark.date !== localDateKey(now)) return false
  const markTask = String(mark.paperId ?? '')
  if (!markTask) return true
  return markTask === String(paperId ?? '')
}

/** 从 localStorage 读到的原始文本解析成标记；**任何坏数据一律返回 null（绝不抛）** */
export function parseQuotaMark(raw: unknown): DailyQuotaMark | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown> | null
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    const date = typeof o.date === 'string' ? o.date : ''
    if (!date) return null
    return {
      date,
      paperId: typeof o.paperId === 'string' ? o.paperId : '',
      message: typeof o.message === 'string' ? o.message : '',
    }
  } catch {
    return null
  }
}
