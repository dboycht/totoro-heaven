/**
 * 「研途健行」跑步页设置的**纯逻辑层**（2026-09-29，GitHub issue #13 + 用户四条口径）
 *
 * ## 为什么要有它
 * 用户 2026-09-29 的原话：
 * > "优化相关配速配置要求 …… **并且在奔跑页面右侧配置栏可以进行设置**"
 * > "路径长度不要进行设置，我们只是在那里指定路径而已 …… 相关的路径设置我们还是放在奔跑界面进行设置以及规定"
 *
 * 于是"跑多长 / 绕几圈 / 用什么配速"这三件事从【研途健行路径编辑器】搬到了**跑步页右侧**。
 * 它们必须和跑步引擎**同一个数**（本项目 E51 的教训：文案里的数字必须与旁边控件同一个 computed），
 * 所以范围、默认值、归一化、格式化、localStorage 键**全部收口在本模块**（零依赖、可离线单测），
 * Nuxt 状态那层薄壳在 `composables/useYtuRunPrefs.ts`。
 *
 * ## 两条容易搞混的"里程口径"（**别合并**）
 *   · 本模块的 `YTU_TARGET_KM_*`：**研途健行任务的目标里程**（默认取任务 `mileage`，如 2.40 km），
 *     决定"本地生成多长的轨迹"；
 *   · `utils/mp/freeRun.ts` 的 `FREE_RUN_KM_*`：**自由跑**的目标距离（默认 5 km，0.5~42.2）。
 * 两者归属不同跑法、默认值不同，**不要**互相复用（会同时改坏两个跑法）。
 */

/** 研途健行目标里程下限（公里）：比"一圈"还小也允许（热身/短任务），但不允许 0 */
export const YTU_TARGET_KM_MIN = 0.1
/** 研途健行目标里程上限（公里）：与自由跑一致（全程马拉松 42.195 → 42.2） */
export const YTU_TARGET_KM_MAX = 42.2
/** **没有任务里程可用**时的兜底目标（公里）——正常路径下用不到（任务一定会下发 mileage） */
export const YTU_TARGET_KM_FALLBACK = 3

/** 输入步进（公里）：研途健行任务的里程是两位小数（实测 2.40），所以步进取 0.01 */
export const YTU_TARGET_KM_STEP = 0.01

/** 「记忆上次设定」的两个 localStorage 键（**单一来源**：只有本模块声明它们） */
export const YTU_TARGET_KM_KEY = 'mp_ytu_target_km'
export const YTU_LAPS_KEY = 'mp_ytu_laps'

/**
 * 把任意输入**归一化**成合法的研途健行目标里程（唯一入口）。
 *
 * 判据（可执行）：
 *   · 空串 / 空白 / `null` / `undefined` / `NaN` / 非数字 → **回落默认值**（不是 0、也不是下限）；
 *   · 数值先夹紧到 `[0.1, 42.2]`，再保留 **2 位小数**（任务里程实测就是两位：2.40）；
 *   · 返回的永远是有限数，调用方可以无条件拿去生成轨迹。
 *
 * ⚠️ 与 `clampFreeRunKm` 的差别只有"默认值"与"小数位"：自由跑是用户凭空设的整公里数（5.0），
 *    研途健行是**服务端下发的任务里程**（2.40）——保留两位小数才能"与任务一致"（用户会拿它核对）。
 */
export function clampYtuTargetKm(raw: unknown, fallback = YTU_TARGET_KM_FALLBACK): number {
  const fb = Number.isFinite(Number(fallback)) && Number(fallback) > 0 ? Number(fallback) : YTU_TARGET_KM_FALLBACK
  const blank =
    raw === null ||
    raw === undefined ||
    (typeof raw !== 'number' && String(raw).trim() === '') ||
    (typeof raw === 'number' && !Number.isFinite(raw))
  if (blank) return round2(Math.min(YTU_TARGET_KM_MAX, Math.max(YTU_TARGET_KM_MIN, fb)))
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n)) return round2(Math.min(YTU_TARGET_KM_MAX, Math.max(YTU_TARGET_KM_MIN, fb)))
  return round2(Math.min(YTU_TARGET_KM_MAX, Math.max(YTU_TARGET_KM_MIN, n)))
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** 目标里程展示文本：`2.4` → `2.40`、`5` → `5.00`（界面上统一两位小数，与任务里程同形） */
export function formatYtuTargetKm(km: number, fallback = YTU_TARGET_KM_FALLBACK): string {
  return clampYtuTargetKm(km, fallback).toFixed(2)
}

/** 读 localStorage 原始字符串 → 合法目标里程（坏数据回落 `fallback`，绝不抛） */
export function parseStoredYtuTargetKm(raw: string | null | undefined, fallback = YTU_TARGET_KM_FALLBACK): number {
  if (raw === null || raw === undefined || String(raw).trim() === '') return clampYtuTargetKm(null, fallback)
  return clampYtuTargetKm(String(raw).trim(), fallback)
}

/**
 * 把任意输入归一化成人填的**圈数 / 趟数**。
 *
 * 判据（照 `normalizeFreePathTrips` 的既有口径，保持一致）：
 *   · `null` / `undefined` / 空白串 = **没填** ⇒ 返回 `null`（调用方按"沿用自动值"处理）；
 *   · 非法（0 / 负数 / 非数字）= **填错了** ⇒ 也返回 `null`（界面据此提示"已按自动值"）；
 *   · 合法 ⇒ 夹到 `[1, 999]` 的整数（上限只为防手滑输入天文数字，日常用不到）。
 *
 * ⚠️ "没填"与"填错"在**本函数里同义**（都返回 `null`），但界面要分开说 ——
 *    这与 `pathShape.isBlankOverride` 的分工一致（那边由调用方再判一次）。
 */
export function normalizeYtuLaps(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'number' && String(raw).trim() === '') return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(999, Math.max(1, Math.round(n)))
}

/** 读 localStorage 原始字符串 → 合法圈数（没填/坏数据一律 `null` = 没填） */
export function parseStoredYtuLaps(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  return normalizeYtuLaps(String(raw).trim())
}

/**
 * **结算卡与预览用的"本次将生成"三件套**（界面只渲染它的结果，不自己算）。
 *
 * ⚠️ 三个数字**必须同源**：`durationSeconds = round(km × paceSecPerKm)`、`speedKmh = 3600 / paceSecPerKm`。
 *    各处自己算一遍就会出现"预览说 26 分钟、结算说 21 分钟"这种自相矛盾（用户 issue #13 里
 *    抱怨的正是"右下角的配速无效" ⇒ 结算卡那行原来是拿"时长 ÷ 里程"反算的，与本次实际配速不同源）。
 */
export interface YtuRunPreview {
  /** 本次目标里程（公里，两位小数） */
  km: number
  /** 本次实际配速（秒/公里） */
  paceSecPerKm: number
  /** 配速展示文本（`10'58"`） */
  paceText: string
  /** 预计时长（秒）= `round(km × pace)` */
  durationSeconds: number
  /** 平均速度（km/h，一位小数）= `3600 / pace` */
  speedKmh: number
}

/** 秒/公里 → `M'SS"`（与 `utils/mp/runData.ts` 的 `formatPace` 逐字同形，但本模块零依赖、不反向 import） */
function paceTextOf(secPerKm: number): string {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return `0'00"`
  const total = Math.round(secPerKm)
  const min = Math.floor(total / 60)
  const sec = total % 60
  return `${min}'${String(sec).padStart(2, '0')}"`
}

/** 组装"本次将生成"的预览数字（入参非法时按 0 处理，绝不抛、绝不 NaN） */
export function ytuRunPreview(targetKm: number, paceSecPerKm: number, fallbackKm = YTU_TARGET_KM_FALLBACK): YtuRunPreview {
  const km = clampYtuTargetKm(targetKm, fallbackKm)
  const pace = Number(paceSecPerKm)
  const safePace = Number.isFinite(pace) && pace > 0 ? pace : 0
  return {
    km,
    paceSecPerKm: safePace,
    paceText: paceTextOf(safePace),
    durationSeconds: safePace > 0 ? Math.round(km * safePace) : 0,
    speedKmh: safePace > 0 ? Math.round((3600 / safePace) * 10) / 10 : 0,
  }
}

/**
 * 任务的**允许配速区间**给人看的一句话（没有下发的窗口不编数字）。
 *
 * 用户 2026-09-29 提出的口径（原话）："上级要求的不仅有时间要求还有配速要求，
 * 我们先将配速要求转化为时间要求，然后取两个区间的交集，以交集为中心进行波动"。
 * 🔄 2026-11-24（用户口径"窗口限制一般是时间"）：上下限改成**以时长窗为准**（速度窗只兜底），
 * 这里如实报出**实际生效的区间**（配速 + 对应速度 + 对应时长），让用户一眼看懂"为什么是这个配速"。
 */
export function paceWindowText(input: {
  lo: number
  hi: number
  hasSpeedWindow: boolean
  hasTimeWindow: boolean
  conflict?: boolean
}): string {
  if (input.conflict) return '任务参数自相矛盾（速度窗与时长窗无交集）：本次按时长窗生成，建议把任务参数发给开发者核对'
  const hasSpan = Number.isFinite(input.hi) && Number.isFinite(input.lo) && input.hi > input.lo
  if (!hasSpan) {
    if (Number.isFinite(input.hi) && Number.isFinite(input.lo) && input.hi === input.lo) {
      return `任务只允许一个配速：${paceTextOf(input.lo)} /km（速度 ${speedTextOf(input.lo)}）`
    }
    return '本任务没有下发配速/时长要求（不由我们编一个区间）'
  }
  /** 实际生效的是哪一个窗（2026-11-24：有时长窗就是它，否则才是速度窗） */
  const source = input.hasTimeWindow ? '按时间要求换算' : '按速度要求换算'
  return `任务允许区间（${source}）：${paceTextOf(input.lo)} ~ ${paceTextOf(input.hi)} /km（速度 ${speedTextOf(input.lo)} ~ ${speedTextOf(input.hi)}）`
}

const speedTextOf = (secPerKm: number) =>
  Number.isFinite(secPerKm) && secPerKm > 0 ? `${(Math.round((3600 / secPerKm) * 10) / 10).toFixed(1)} km/h` : '—'
