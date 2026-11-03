/**
 * **本地质量闸：拟合度**（2026-11-03，用户要求）
 *
 * ## 用户口径（原话）
 * > "添加相关本地判定，当拟合度小于 0.6 时提示**本地校验不通过，要求重新生成**"
 *
 * ## 这道闸是什么、不是什么（口径必须写清，免得后人误读成"替服务端判分"）
 *   · **是**：对我们**本机生成的那条轨迹**的质量闸 —— 拟合度是我们自己算的（官方路线 5 m 采样 / 25 m 命中），
 *     它低说明**这条轨迹偏离官方线路太远**（多半是几何用错了：拿别的跑道、或真实路径与线路差得远）。
 *     与其把一条自己都觉得不对的轨迹发上去，不如**先重做**。
 *   · **不是**：不是在替服务端判定"这次成绩有效/无效"。服务端是否强制拟合度**已有反例**
 *     （issue #12：有学校的任务卡片写着 0.60，而拟合度 0 的成绩照样判过）——
 *     所以文案一律写成「**本地校验不通过**」，并明说"服务端是否判定合格由服务端决定"。
 *
 * ## 判据（可执行）
 *   ① **本任务未下发线路**（`routeRequirementOf(task).kind === 'free'`）⇒ **整项不适用**：
 *      没有可对照的路线，自算必然接近 0 ⇒ **绝不能拦**（否则"研途健行"这类任务永远提交不了）。
 *   ② 其余情况：门槛 = `max(本地地板 0.6, 服务端下发的阈值)`（服务端阈值更严时以它为准；没下发就用 0.6）；
 *      `fitDegree >= 门槛` ⇒ 通过。
 *   ③ 拟合度读不出（`NaN`/`undefined`）⇒ **不拦**（`applies: false`）：证据不足时不做否定判断。
 */
import { fitRequirementOf, routeRequirementOf } from './taskShape'

/**
 * **本地拟合度地板**（用户 2026-11-03 指定：小于 0.6 就要求重新生成）。
 * ⚠️ 与"服务端下发的阈值"是两回事：这里是我们对自己生成质量的要求，不是服务端的判定标准。
 */
export const LOCAL_FIT_FLOOR = 0.6

export interface LocalFitGateResult {
  /** 这道闸**是否适用**（未下发线路 / 拟合度读不出 ⇒ 不适用） */
  applies: boolean
  /** `true` = 通过（或本就不适用） */
  ok: boolean
  /** 实际使用的门槛（不适用时为 `null`） */
  threshold: number | null
  /** 门槛来源：本地地板 / 服务端阈值（服务端更严时）/ 不适用 */
  source: 'local' | 'task' | 'none'
  /**
   * 🆕 2026-11-03（用户反馈"文字注解有歧义"）：**标题行**（一句短的，含判定词与数值）。
   * 界面把它当标题渲染；`message` 里**不再重复**这句话 —— 原先两处都写"本地校验不通过"，
   * 同一句在卡片上出现两遍，看着像两条不同的错误。
   */
  headline: string
  /** 正文（说清为什么 + 该怎么办；**不重复标题里的话**） */
  message: string
  /** 不适用时说明原因（空串 = 适用） */
  skipReason: string
}

/**
 * 评估**本地拟合度质量闸**（纯函数，唯一判据 —— 界面与将来的提交门禁都调它）。
 *
 * 判据见文件头；`fitDegree` 用**已结算那次的实际值**（`run.result.fitDegree`），
 * ⚠️ **不要**拿"跑到一半的可见点"去算（那时只有几个点，拟合度天然接近 0，会假红）。
 */
export function evaluateLocalFitGate(input: { fitDegree: number | string | null | undefined; task: unknown }): LocalFitGateResult {
  /**
   * ⚠️ **空值必须当"没有"**：`Number(null) === 0`、`Number('') === 0` —— 直接 `Number.isFinite(Number(v))`
   * 会把"还没结算 / 字段缺失"读成 **0.00 的拟合度**，于是本地闸立刻判"不通过"（假红，且用户没法解释）。
   * 同一条判据在 `realPath.ts` 的坐标解析上也踩过一次（那边会把缺坐标读成 (0,0)）。
   */
  const rawIn = input.fitDegree
  const skip = (skipReason: string): LocalFitGateResult => ({
    applies: false,
    ok: true,
    threshold: null,
    source: 'none',
    headline: '',
    message: '',
    skipReason,
  })
  if (rawIn === null || rawIn === undefined || (typeof rawIn === 'string' && rawIn.trim() === '')) {
    return skip('这次还没有拟合度读数（未结算或数据不完整）⇒ 不做本地判定')
  }
  const raw = Number(rawIn)
  if (!Number.isFinite(raw)) return skip('这次还没有拟合度读数（未结算或数据不完整）⇒ 不做本地判定')
  /** ① 未下发线路：没有可对照的路线 ⇒ 不适用（否则这类任务永远提交不了） */
  if (routeRequirementOf(input.task).kind === 'free') {
    return skip('本任务未下发线路（不指定路线）⇒ 没有可对照的路线，拟合度不适用本地判定')
  }
  /** ② 门槛 = max(本地地板, 服务端阈值) */
  const fit = fitRequirementOf(input.task)
  const taskThreshold = fit.required && typeof fit.threshold === 'number' ? fit.threshold : null
  const threshold = taskThreshold === null ? LOCAL_FIT_FLOOR : Math.max(LOCAL_FIT_FLOOR, taskThreshold)
  const source: LocalFitGateResult['source'] = taskThreshold !== null && taskThreshold > LOCAL_FIT_FLOOR ? 'task' : 'local'
  const ok = raw >= threshold
  if (ok) {
    return {
      applies: true,
      ok: true,
      threshold,
      source,
      headline: `本地校验通过：拟合度 ${raw.toFixed(2)} ≥ 门槛 ${threshold.toFixed(2)}`,
      message: '',
      skipReason: '',
    }
  }
  const why =
    source === 'task'
      ? `这条轨迹偏离官方线路太远（门槛取服务端的 ${threshold.toFixed(2)}，比本地地板 0.60 更严）`
      : `这条轨迹偏离官方线路太远（本地门槛 ${threshold.toFixed(2)}）`
  return {
    applies: true,
    ok: false,
    threshold,
    source,
    /**
     * ⚠️ 2026-11-03（用户反馈"文字注解有歧义"）：**标题只写判定词 + 两个数**，
     * 正文**不再重复**"本地校验不通过"那一句 —— 原先标题与正文各写一遍，
     * 卡片上看起来像两条不同的错误（实测截图里就是这样）。
     */
    headline: `本地校验不通过：拟合度 ${raw.toFixed(2)} < ${threshold.toFixed(2)}`,
    message:
      `${why}。请「重新生成」一条再提交 —— 换一条更贴合的预设 / 回「跑道编辑」按卫星图重描，或换掉这条真实路径。`,
    skipReason: '',
  }
}

/**
 * 界面上那句"为什么不给提交"的补充说明（**必须与服务端口径分开说**）。
 * 单列一个函数，是为了让"本地闸"与"服务端判定"这两件事在文案上永远不混。
 */
export function localFitServerNote(): string {
  return '这是本机对"自己生成的轨迹"的质量要求，不是在替服务端判定成绩 —— 服务端是否判合格仍由服务端决定（已有学校实测放过低拟合度的成绩）。'
}
