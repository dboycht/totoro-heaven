/**
 * 自由跑「自设距离」的**纯逻辑层**（2026-09-20，1.1.12 需求①）
 *
 * 背景：在此之前自由跑的里程是写死的常量（`FREE_RUN_CAP_KM = 5`），用户无法指定。
 * 现在由用户设定，但**取值范围与归一化必须有唯一入口** —— 否则会出现
 * "输入框里写着 999、报文里是 5"这类两处口径不一致（本项目 E51 的同类坑：
 * 文案里的数字必须与旁边控件同一个 computed）。
 *
 * 为什么范围上限是 42.2 km：全程马拉松 42.195 km 是该项目最高的常见整数场景，
 * 再往上（百公里）与"校园跑步辅助"的定位不符，且生成点数会大到没有意义。
 * 下限 0.5 km：低于这个值连"跑一圈"都不到，轨迹生成器也没有意义。
 *
 * 依赖方向：本文件**零依赖**（可离线单测），不碰 localStorage、不碰 Nuxt 状态 ——
 * 存取的薄壳在 `composables/demo/state.ts`（键名常量在这里，保持单一来源）。
 */

/** 自由跑目标距离下限（公里） */
export const FREE_RUN_KM_MIN = 0.5
/** 自由跑目标距离上限（公里）：全程马拉松 42.195 → 取一位小数 42.2 */
export const FREE_RUN_KM_MAX = 42.2
/** 默认目标距离（公里）：与旧版写死的上限一致，老用户升级后看到的就是原来的 5 km */
export const FREE_RUN_KM_DEFAULT = 5
/** 输入步进（公里） */
export const FREE_RUN_KM_STEP = 0.1
/** 快捷档位（公里）——按"操场常见跑量 + 半马"取，不是任意数字 */
export const FREE_RUN_KM_PRESETS = [3, 5, 10, 21.1] as const

/** 记忆上次所选距离用的 localStorage 键（**单一来源**：只有本模块声明它） */
export const FREE_RUN_KM_KEY = 'mp_free_run_km'

/**
 * 「本机已知该校未开通自由跑」的 localStorage 键（2026-09-21，用户要求"入口标灰"）。
 *
 * 背景（实测）：自由跑的真实提交由**服务端**按学校/账号判定；未开通时 `getRunBegin` 直接回
 * `暂无自由跑任务,请选择阳光跑!`（报文与官方小程序逐字一致、没有 paperId 可补）。
 * 既然**本地无法预先探测**，退而求其次：**记住上一次被拒**，下次开跑前就把入口标灰并说明原因，
 * 同时给一个"仍要试一次（清除标记）"的出口 —— 既不挡开通了的学校，也不让未开通的人白点。
 */
export const FREE_RUN_UNSUPPORTED_KEY = 'mp_freerun_unsupported'

/** 服务端的回复是不是"该校/该账号没有自由跑任务"（判据集中在这里，别在业务代码里散落正则） */
export const isFreeRunUnsupportedMessage = (msg: unknown): boolean => /自由跑任务/.test(String(msg ?? ''))

/**
 * 把任意输入**归一化**成合法的自由跑目标距离（唯一入口）。
 *
 * 判据（可执行）：
 *   · 空串 / 空白 / `null` / `undefined` / `NaN` / 非数字 → **回落默认值**（不是 0，也不是下限）；
 *   · 数值先按区间夹紧（0.5 ~ 42.2），再保留 **1 位小数**（`5.04` → `5.0`，`21.19` → `21.2`）；
 *   · 返回的永远是有限数，调用方可以无条件拿去生成轨迹。
 *
 * ⚠️ 为什么空输入回落"默认值"而不是"下限"：用户在输入框里清空准备重输时，
 *    中间态会经过空串；若回落 0.5，会把上一次的有效值悄悄改成 0.5 并落盘（用户体验上像"乱跳"）。
 */
export function clampFreeRunKm(raw: unknown): number {
  if (raw === null || raw === undefined) return FREE_RUN_KM_DEFAULT
  /**
   * ⚠️ 非数字一律先 `String()` 再 trim，**trim 后为空即视为"没填"** →
   *    这样 `''`、`'   '`、`[]`（`String([]) === ''`）都回落默认值，
   *    而不会像 `Number([])` 那样悄悄变成 0（= 被夹成下限 0.5，看着像"数字乱跳"）。
   */
  const text = typeof raw === 'number' ? '' : String(raw).trim()
  if (typeof raw !== 'number' && text === '') return FREE_RUN_KM_DEFAULT
  const n = typeof raw === 'number' ? raw : Number(text)
  if (!Number.isFinite(n)) return FREE_RUN_KM_DEFAULT
  const clamped = Math.min(FREE_RUN_KM_MAX, Math.max(FREE_RUN_KM_MIN, n))
  return Math.round(clamped * 10) / 10
}

/** 读 localStorage 原始字符串 → 合法距离（坏数据/旧数据一律回落默认值，绝不抛） */
export function parseStoredFreeRunKm(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || String(raw).trim() === '') return FREE_RUN_KM_DEFAULT
  return clampFreeRunKm(String(raw).trim())
}

/** 距离展示用文本：`5` → `5.0`，`21.1` → `21.1`（界面上统一一位小数） */
export function formatFreeRunKm(km: number): string {
  return (Math.round(clampFreeRunKm(km) * 10) / 10).toFixed(1)
}

/**
 * 按"所选车道的一圈多长（米）"估算跑多少圈（一位小数）。
 * 数据不足（没有描过跑道 / 周长非法）时返回 `null` —— **界面据此不显示**，而不是显示 0 圈或 NaN。
 */
export function estimateLaps(targetKm: number, lapLengthM: number): number | null {
  const lap = Number(lapLengthM)
  // ⚠️ 必须同时排除 `Infinity`：`Infinity > 0` 为真，但 5000/Infinity = 0 圈 —— 那是假数据，
  //    界面应显示"算不出圈数"而不是"约 0 圈"（本项目 E51：文案里的数字必须与控件同源、且真实）
  if (!Number.isFinite(lap) || lap <= 0) return null
  const km = clampFreeRunKm(targetKm)
  return Math.round(((km * 1000) / lap) * 10) / 10
}

/** 估算"要跑多久"（秒）——按给定配速（秒/公里）算，用于界面提示；配速非法时返回 null */
export function estimateFreeRunSeconds(targetKm: number, paceSecPerKm: number): number | null {
  const pace = Number(paceSecPerKm)
  if (!Number.isFinite(pace) || pace <= 0) return null
  return Math.round(clampFreeRunKm(targetKm) * pace)
}
