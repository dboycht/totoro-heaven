/**
 * **「真实路径」的纯算法层**（2026-11-03，1.3.6 需求③）
 *
 * ## 用户口径（原话要点）
 * > "新功能在「我的场地」标签页下，为「真实路径」，登录账号后，可以使用相关内部功能来
 * >  导出**某一天真实跑的路径信息**，并可以选择「导出到本地存为路径预设」或者「导出分享给好友」两种选择，
 * >  用户在跑步界面可以选择这些路径并进行跑步，目前先做到**直接原版数据提交**，后面再慢慢补齐"
 * > 另：分享形态 = **输出一个压缩包**；提交口径 = 用这条路径当本机几何、**走现有原版流程**（报文一字不变）。
 * > 🔄 2026-11-20（用户口径）：当年加过的「测试」标注已从界面与本层说明里删掉。
 *
 * ## 这一层负责什么（都是纯函数，可离线单测）
 *   ① 把 `getSunrunArch` / `getSunrunArchDetail` 的响应**读成**记录列表与点列（坏数据安全降级）；
 *   ② 按**天**分组（用户要的是"某一天"）；
 *   ③ 从一次真实跑里**切出一圈**（真人跑 3 km 是 5~8 圈；整条当"一圈"会让跑图怪怪的）；
 *   ④ 生成**预设草稿**（存进本机路线库的形状：`freeShape` + `realPath` 元信息）；
 *   ⑤ 分享包（zip 里的那份 JSON）的**构造与解析**，以及 zip 的**读写**（store/deflate 两种都认）。
 *
 * ## 三条纪律
 *   · **只读**：本模块不联网、不写盘；取数在组合层（`composables/useRealPathExport.ts`）；
 *   · **隐私红线**：分享包里**只放路径点 + 必要元信息**，绝不放 token / 学号 / 姓名（见 `buildShareBundle`）；
 *   · **不给旧数据添乱**：预设里的 `realPath` 是可选字段，没有它的条目行为与旧版逐字一致。
 */

/** 一个坐标点（与项目其余部分同口径：`latitude`/`longitude`） */
export interface RealPathPoint {
  latitude: number
  longitude: number
}

/**
 * 一条"真实路径"的**来源元信息**（写进预设的 `realPath` 字段；界面与分享包都用它）。
 *
 * ⚠️ 这里**只放能对得上账的事实**：日期、场次号、里程、用时、拟合度、点数、导出时刻。
 *    不放学号/姓名/token（隐私红线，见模块头注释）。
 */
export interface RealPathMeta {
  /** 成绩日期（服务端 `runTime`，`YYYY-MM-DD`） */
  date: string
  /** 场次号（服务端 `scoreId`，形如 `sunrunId202611011234`） */
  scoreId: string
  /** 里程（km；读不出 ⇒ `null`） */
  km: number | null
  /** 用时原文（服务端 `usedTime`，形如 `00:20:25`；读不出 ⇒ 空串） */
  usedTime: string
  /** 拟合度（读不出 ⇒ `null`） */
  fitDegree: number | null
  /** 原始点数（🆕 2026-11-04 起轨迹**原样整条**保存，本字段就是整场的点数） */
  sourcePoints: number
  /**
   * 🆕 **一圈长度**（米；读不出闭环 ⇒ `null`）。
   * 轨迹改成**原样整条**（不切圈、不降采样）后，切圈只为了**报数**：
   * 预览按它把整条轨迹按圈着色（用户口径"仍按一圈长着色"）；`null` ⇒ 预览整条一色。
   */
  lapLengthM: number | null
  /** 导出时刻（ISO 字符串） */
  exportedAt: string
}

/**
 * 演示数据的场次号前缀（2026-11-24，演示模式补齐）。
 *
 * 判据只有一个：`scoreId` 以 `demo-` 开头。真实场次号形如 `sunrunId202611011234`，
 * 不会碰撞；演示预设只进内存（`useTrackLibrary` 落盘时按条目 id 剔除），退出演示即消失。
 */
export const DEMO_SCORE_ID_PREFIX = 'demo-'

/** 这个场次号是不是演示数据（判据唯一：前缀；空/非字符串一律 false） */
export function isDemoScoreId(raw: unknown): boolean {
  return String(raw ?? '').trim().startsWith(DEMO_SCORE_ID_PREFIX)
}

/** 成绩归档里的一条（只取本功能要用的字段；其余原样留着不猜） */export interface RealPathRecord {
  scoreId: string
  /**
   * 🆕 任务 id（服务端 `paperId`）—— 记录里**唯一**指向"哪次任务"的字段。
   * ⚠️ 归档记录**没有线路 id**（字段表见 `_mp-analyze/深挖/D-配置与归档数据模型.md` §4.1），
   *    所以"这次跑的是哪条线路"只能靠 `nearestLineByGeometry()` 用**轨迹位置**判断。
   */
  paperId: string
  /** `YYYY-MM-DD`（读不出 ⇒ 空串，界面据此归到"日期未知"） */
  date: string
  /** 时间部分（`startTmie`，`HH:mm:ss`；读不出 ⇒ 空串） */
  startTime: string
  km: number | null
  usedTime: string
  fitDegree: number | null
  /** 判定 0 无效 / 1 有效 / 2 申诉有效 / 3 补录有效（读不出 ⇒ `null`） */
  passType: number | null
}

/**
 * 宽松数字解析 → `null`（**空值必须当"没有"**）。
 *
 * ⚠️ 这里踩过一次：`Number(null) === 0`、`Number('') === 0` —— 直接 `Number.isFinite(Number(v))`
 *    会把"服务端没给坐标"读成 **(0, 0)**（几内亚湾那个点），于是轨迹里凭空多一个飞点、
 *    而且它离真实路径几千公里，拟合度/里程全被它带歪。判据：`null`/`undefined`/空白串一律 `null`。
 */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())

/**
 * **解码**一条存进路线库的 `realPath` 元信息（`normalizeLibrary` 用；坏数据 ⇒ `undefined`）。
 *
 * 判据：至少要能看出"这是哪一场"（`date` 或 `scoreId` 有一个非空），否则当作没有 ——
 * 一条只有 `{km: 3}` 的残缺元信息没有任何解释力，留着只会让界面显示一堆"未记录"。
 */
export function parseRealPathMeta(raw: unknown): RealPathMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  const date = isIsoDate(v.date) ? str(v.date) : ''
  const scoreId = str(v.scoreId)
  if (!date && !scoreId) return undefined
  return {
    date,
    scoreId,
    km: num(v.km),
    usedTime: str(v.usedTime),
    fitDegree: num(v.fitDegree),
    sourcePoints: Math.max(0, Math.round(Number(v.sourcePoints) || 0)),
    /** 🆕 2026-11-04：旧数据没有 `lapLengthM` ⇒ `null`（预览整条一色，不猜） */
    lapLengthM: num(v.lapLengthM),
    exportedAt: str(v.exportedAt),
  }
}

/** `YYYY-MM-DD` 形态（服务端 `runTime` 就是它；别的时间形态一律当"日期未知"） */
export function isIsoDate(s: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(str(s))
}

/**
 * 解析 `getSunrunArch` 的响应 → 记录列表（**只读、坏数据安全降级**）。
 *
 * 负载口径与 `composables/real/submit.ts` 的读判定**同源**：`MP_ENDPOINTS.sunrunArch.payload`
 * 解包后取 `data[]`。所以这里的入参就是**已解包的负载对象**（`{ data: [...] }`），
 * 也接受**裸数组**（少数端点/旧版会直接回数组）。
 */
export function parseArchRecords(payload: unknown): RealPathRecord[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown } | null)?.data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : []
  const out: RealPathRecord[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const scoreId = str(r.scoreId)
    if (!scoreId) continue
    out.push({
      scoreId,
      paperId: str(r.paperId),
      date: isIsoDate(r.runTime) ? str(r.runTime) : '',
      startTime: str(r.startTmie),
      km: num(r.mileage),
      usedTime: str(r.usedTime),
      fitDegree: num(r.trajectorySimilary),
      passType: num(r.scorePassType),
    })
  }
  return out
}

/** 按天分组的容器（日期倒序；"日期未知"排最后） */
export interface RealPathDay {
  date: string
  records: RealPathRecord[]
}

/**
 * 按**天**分组（用户口径："导出某一天真实跑的路径信息"）。
 * 判据：日期倒序（`''` 排最后）；同一天内按开始时间倒序（读不出的排最后）。
 */
export function groupRecordsByDay(records: RealPathRecord[]): RealPathDay[] {
  const map = new Map<string, RealPathRecord[]>()
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== 'object') continue
    const key = isIsoDate(r.date) ? r.date : ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  const days = [...map.entries()].map(([date, list]) => ({
    date,
    records: [...list].sort((a, b) => String(b.startTime).localeCompare(String(a.startTime))),
  }))
  return days.sort((a, b) => {
    if (!a.date || !b.date) return a.date ? -1 : b.date ? 1 : 0
    return b.date.localeCompare(a.date)
  })
}

/**
 * 解析 `getSunrunArchDetail` 的响应 → 点列。
 *
 * 口径：负载里 `pointList[]`（`{latitude, longitude}`）；**逐点过滤非法坐标**（NaN/缺字段/越界纬度）。
 * 返回空数组 = "这条没有轨迹"（界面据此如实说，不假装有）。
 */
export function parseArchDetailPoints(payload: unknown): RealPathPoint[] {
  const src = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { pointList?: unknown } | null)?.pointList)
      ? ((payload as { pointList: unknown[] }).pointList as unknown[])
      : []
  const out: RealPathPoint[] = []
  for (const raw of src) {
    if (!raw || typeof raw !== 'object') continue
    const p = raw as Record<string, unknown>
    const latitude = num(p.latitude)
    const longitude = num(p.longitude)
    if (latitude === null || longitude === null) continue
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue
    out.push({ latitude, longitude })
  }
  return out
}

/** 两点距离（米，haversine；与 `routeSimilarity.distanceMeters` 同口径，但本模块不引它以免多一层依赖） */
export function distanceM(p1: RealPathPoint, p2: RealPathPoint): number {
  const R = 6378137
  const rad = Math.PI / 180
  const dLat = (p2.latitude - p1.latitude) * rad
  const dLng = (p2.longitude - p1.longitude) * rad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.latitude * rad) * Math.cos(p2.latitude * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** 点列总长（米） */
export function pathLengthM(points: RealPathPoint[]): number {
  const list = Array.isArray(points) ? points : []
  let sum = 0
  for (let i = 1; i < list.length; i++) sum += distanceM(list[i - 1]!, list[i]!)
  return sum
}

/**
 * **尾部修剪**：把一条真实路径的**末尾**裁掉一段，得到"更短但仍达标"的一段
 * （2026-11-27 初版"首尾各裁"→ **2026-11-28 用户更正：只截断末尾，起点保持原样**；纯函数）。
 *
 * ## 用户原话要点
 * > 2026-11-27："在跑步界面…可以将相关的数据点进行修剪，也就是[删掉]起点和终点左右的数据点，
 * >  并确保最终形成的长度是大于课程要求的，然后再进入后面的计算，这样的话可以减少重复度；
 * >  这类计算是在计算配速之前发生的。"
 * > 2026-11-28："修改相关的截断算法，只截断末尾不截断开始。"
 *
 * ## 为什么修剪
 * 真实路径预设是**某一场真实跑的原样点列**；每次原样提交 ⇒ 里程/时长/轨迹都与归档那一场
 * 逐字相同（重复度最高）。裁掉末尾一段后终点挪开、里程变短，提交的才是"另一场"的轨迹。
 * ⚠️ 起点**故意保持原样**（用户 2026-11-28 口径）：这样轨迹开头仍与那场真跑一致，
 *    只有收尾那一段被截掉 —— 想保留"从入口进场"的那种开头观感时用它。
 *
 * ## 两条判据
 *   ① **下限**：修剪后里程 ≥ `要求里程 × (1 + 超跑系数)`，超跑系数在 0.3%~4% 内随机
 *      （与 `utils/mp/realism.ts` 的模拟路径同一区间，两端风格一致）；
 *   ② **幅度**：在"原始里程 − 下限"这段余量里随机吃掉 10%~95%（用户 2026-11-27 口径"数量随机"）。
 *
 * 余量不足（原始 ≤ 下限 + 5 m）⇒ **不修剪**，`skipped` 里写清原因（绝不凭空造一段）。
 *
 * ⚠️ 纯函数：不联网、不写盘；随机源可注入（`rng`，单测用）。
 *    调用方必须在**算配速之前**用它的点列 —— 配速 = 用时 ÷ 里程，里程变了配速才跟着变。
 */
export interface RealPathTrimPlan {
  /** 对应哪条预设（引擎据此确认不是上一轮留下的残留） */
  entryId: string
  /** 修剪后的点列（`skipped` 非空时 = 原样点列） */
  points: RealPathPoint[]
  /** 原始里程（km，3 位小数） */
  originalKm: number
  /** 修剪后里程（km，3 位小数；`skipped` 非空时 = 原始里程） */
  trimmedKm: number
  /** 首端裁掉多少米（2026-11-28 起恒为 0 —— 只裁末尾，起点原样保留） */
  trimStartM: number
  /** 尾端裁掉多少米 */
  trimEndM: number
  /** 本次抽到的超跑系数（0.003~0.04） */
  overshootRatio: number
  /** 原始点数 / 保留点数 */
  sourcePoints: number
  keptPoints: number
  /** 不修剪的原因（空串 = 真的修剪了） */
  skipped: string
}

/** 可裁比例区间（余量的 10%~95%） */
export const REAL_PATH_TRIM_RATIO: readonly [number, number] = [0.1, 0.95]
/**
 * @deprecated 2026-11-28（用户口径"只截断末尾"）：不再有首尾分配，这个常量只为兼容旧引用保留，
 * 值恒等于"全给末尾"。新代码别再用它。
 */
export const REAL_PATH_TRIM_SPLIT: readonly [number, number] = [0, 1]
/** 超跑系数区间（与 `realism.ts` 的 0.3%~4.0% 同一口径） */
export const REAL_PATH_TRIM_OVERSHOOT: readonly [number, number] = [0.003, 0.04]
/** 余量少于这么多米就不修剪（连 5 m 都裁不到，没有意义） */
export const REAL_PATH_TRIM_MIN_BUDGET_M = 5

export function planRealPathTrim(
  points: RealPathPoint[],
  opts: {
    entryId?: string
    /** 课程要求里程（km；≤ 0 = 没有要求可对照 ⇒ 不修剪） */
    requiredKm: number
    rng?: () => number
    ratioRange?: readonly [number, number]
    /** @deprecated 2026-11-28：只裁末尾，不再有首尾分配（传了也忽略） */
    splitRange?: readonly [number, number]
    overshootRange?: readonly [number, number]
  },
): RealPathTrimPlan {
  const rng = opts.rng ?? Math.random
  const entryId = String(opts.entryId ?? '')
  const list = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)))
    .map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
  const originalM = pathLengthM(list)
  const originalKm = Number((originalM / 1000).toFixed(3))
  const skip = (reason: string): RealPathTrimPlan => ({
    entryId,
    points: list,
    originalKm,
    trimmedKm: originalKm,
    trimStartM: 0,
    trimEndM: 0,
    overshootRatio: 0,
    sourcePoints: list.length,
    keptPoints: list.length,
    skipped: reason,
  })
  const requiredKm = Number(opts.requiredKm)
  if (!(requiredKm > 0)) return skip('没有要求里程可对照（自由跑 / 未读到任务里程）')
  if (list.length < 4) return skip(`点太少（${list.length} 点），不修剪`)
  const [ovLo, ovHi] = opts.overshootRange ?? REAL_PATH_TRIM_OVERSHOOT
  const overshootRatio = ovLo + rng() * (ovHi - ovLo)
  const floorM = requiredKm * (1 + overshootRatio) * 1000
  const budgetM = originalM - floorM
  if (!(budgetM > REAL_PATH_TRIM_MIN_BUDGET_M)) {
    return skip(
      budgetM > 0
        ? `当前 ${originalKm.toFixed(2)} km 只比下限 ${(floorM / 1000).toFixed(3)} km 多 ${Math.round(budgetM)} m，不够修剪`
        : `当前 ${originalKm.toFixed(2)} km 已低于下限 ${(floorM / 1000).toFixed(3)} km（要求 ${requiredKm.toFixed(2)} km × 1+${(overshootRatio * 100).toFixed(1)}%），不修剪`,
    )
  }
  const [rLo, rHi] = opts.ratioRange ?? REAL_PATH_TRIM_RATIO
  const trimM = budgetM * (rLo + rng() * (rHi - rLo))
  /**
   * 🆕 2026-11-28（用户口径"只截断末尾不截断开始"）：**整段都从末尾裁**。
   * 起点保持原点列的第 0 点 ⇒ 轨迹开头与那场真跑完全一致，只有收尾被截短。
   * ⚠️ 第三次 `rng()` 调用（旧的首尾分配）已删除 —— 随机序列少一个数，单测的固定 rng 期望值跟着改了。
   */
  const trimStartM = 0
  const trimEndM = trimM

  /** 累计弧长（`cum[i]` = 第 0 点到第 i 点的里程，米） */
  const cum: number[] = [0]
  for (let i = 1; i < list.length; i++) cum.push(cum[i - 1]! + distanceM(list[i - 1]!, list[i]!))
  /** 首端：第一个"距起点已超过裁剪量"的点 */
  let iStart = 0
  while (iStart < list.length - 1 && cum[iStart]! < trimStartM) iStart++
  /** 尾端：最后一个"距终点仍超过裁剪量"的点 */
  let iEnd = list.length - 1
  while (iEnd > 0 && originalM - cum[iEnd]! < trimEndM) iEnd--
  const kept = iEnd >= iStart ? list.slice(iStart, iEnd + 1) : []
  if (kept.length < 3) return skip('修剪后点数不足 3 个，不修剪')
  const trimmedKm = Number((pathLengthM(kept) / 1000).toFixed(3))
  /** 3 位小数四舍五入到米级，允许半点误差；真低于下限就整条不修剪（宁可不裁也不越线） */
  if (!(trimmedKm * 1000 + 0.5 >= floorM)) {
    return skip(`修剪后 ${trimmedKm.toFixed(3)} km 低于下限 ${(floorM / 1000).toFixed(3)} km，不修剪`)
  }
  return {
    entryId,
    points: kept,
    originalKm,
    trimmedKm,
    trimStartM: Number(trimStartM.toFixed(1)),
    trimEndM: Number(trimEndM.toFixed(1)),
    overshootRatio,
    sourcePoints: list.length,
    keptPoints: kept.length,
    skipped: '',
  }
}

/** 界面一句话：这次修剪了什么（不修剪时如实说明原因） */
export function realPathTrimText(plan: RealPathTrimPlan | null | undefined): string {
  if (!plan) return ''
  if (plan.skipped) return `尾部修剪：不修剪 —— ${plan.skipped}`
  return (
    `尾部修剪：${plan.originalKm.toFixed(2)} km → ${plan.trimmedKm.toFixed(2)} km` +
    `（裁掉末尾 ${Math.round(plan.trimEndM)} m，起点保留；` +
    `${plan.sourcePoints} → ${plan.keptPoints} 点），每次载入重抽`
  )
}

/* ══════════════════════════════════════════════════════════════════════════
 * 重采样（2026-11-28 用户口径）
 *
 * 用户原话："添加插值算法，在保证原版的前提下，对数据点进行重插值处理；也就是整体为连续的线，
 *  你写个算法让最终的轨迹和原版差不多，但是数据点发生变化。"
 * 追加确认：① 点间距按**本机 22 条真实路径的实测密度**（均值 3.42 m、逐段 ±30%）；
 *  ② 复现真实数据里的**偶发断点**（0~2 处、10~30 m）；③ 点**严格落在原折线上**（不加横向噪声）。
 *
 * ## 算法（线性弧长重采样，纯函数）
 *   ① 累计弧长 `cum[i]`；
 *   ② 按"目标步数 = 总长 ÷ 3.42 m"生成每段步长，逐段在 [0.7, 1.3] 倍之间随机；
 *   ③ 随机挑 0~2 段改成 10~30 m 的**断点**（模拟 GPS 丢点）；
 *   ④ **整体按比例缩放**，让所有步长之和精确等于原长 ⇒ 首尾点与原版完全重合、总长不变；
 *   ⑤ 在每个弧长位置线性插值出坐标（落点一定在原折线上，曲线形状不变）。
 *
 * ⚠️ 纯函数、随机源可注入；输出点列可以直接当本机几何（不插值、不重排、不横向抖动）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 实测：本机 22 条真实路径的点距均值（米）与逐段相对抖动（±30%） */
export const REAL_PATH_RESAMPLE_STEP_M = 3.42
export const REAL_PATH_RESAMPLE_STEP_SPREAD = 0.3
/** 断点：每场 0~2 处、每处 10~30 m（实测 22 场共 13 处 >10 m 的跳点，最大 87.8 m） */
export const REAL_PATH_RESAMPLE_GAP_MAX_COUNT = 2
export const REAL_PATH_RESAMPLE_GAP_MIN_M = 10
export const REAL_PATH_RESAMPLE_GAP_MAX_M = 30

export interface RealPathResamplePlan {
  /** 重采样后的点列（首尾与原版完全重合） */
  points: RealPathPoint[]
  /** 输入点数 / 输出点数 */
  sourcePoints: number
  sampledPoints: number
  /** 步长均值（米）与实际断点数 */
  meanStepM: number
  gapCount: number
  /** 不重采样的原因（空串 = 真的重采样了） */
  skipped: string
}

/** 弧长 `d` 处的坐标（在原点列的两点之间线性插值；`d` 会被夹到 [0, 总长]） */
function pointAtArcLength(list: RealPathPoint[], cum: number[], d: number): RealPathPoint {
  const total = cum[cum.length - 1] ?? 0
  const target = Math.min(Math.max(d, 0), total)
  let lo = 0
  let hi = list.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid]! <= target) lo = mid
    else hi = mid
  }
  const a = list[lo]!
  const b = list[hi]!
  const segLen = (cum[hi] ?? 0) - (cum[lo] ?? 0)
  const t = segLen > 0 ? (target - (cum[lo] ?? 0)) / segLen : 0
  return { latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t }
}

/**
 * **线性弧长重采样**：点换一批、线还是那条线（2026-11-28 用户口径"让轨迹和原版差不多，但数据点发生变化"）。
 *
 * 判据：
 *   · 首点 = 原点列第 0 点、尾点 = 原点列最后一点（总长精确不变）；
 *   · 每段在 `stepMean × [0.7, 1.3]` 内随机，另有 0~2 段是 10~30 m 的断点；
 *   · 点数 ≈ 总长 ÷ stepMean（3.2 km ⇒ 约 930~950 点，与真实数据 886~1183 同量级）。
 */
export function resampleRealPath(
  points: RealPathPoint[],
  opts: {
    rng?: () => number
    stepMeanM?: number
    stepSpread?: number
    gapMaxCount?: number
    gapMinM?: number
    gapMaxM?: number
  } = {},
): RealPathResamplePlan {
  const rng = opts.rng ?? Math.random
  const list = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)))
    .map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
  const skip = (reason: string): RealPathResamplePlan => ({
    points: list,
    sourcePoints: list.length,
    sampledPoints: list.length,
    meanStepM: 0,
    gapCount: 0,
    skipped: reason,
  })
  if (list.length < 3) return skip(`点太少（${list.length} 点），不重采样`)
  const cum: number[] = [0]
  for (let i = 1; i < list.length; i++) cum.push(cum[i - 1]! + distanceM(list[i - 1]!, list[i]!))
  const total = cum[cum.length - 1] ?? 0
  if (!(total > 5)) return skip('路径太短（< 5 m），不重采样')

  const stepMean = Math.max(0.5, Number(opts.stepMeanM ?? REAL_PATH_RESAMPLE_STEP_M))
  const spread = Math.min(0.9, Math.max(0, Number(opts.stepSpread ?? REAL_PATH_RESAMPLE_STEP_SPREAD)))
  const gapMaxCount = Math.max(0, Math.min(10, Math.round(Number(opts.gapMaxCount ?? REAL_PATH_RESAMPLE_GAP_MAX_COUNT))))
  const gapMin = Math.max(stepMean * 2, Number(opts.gapMinM ?? REAL_PATH_RESAMPLE_GAP_MIN_M))
  const gapMax = Math.max(gapMin, Number(opts.gapMaxM ?? REAL_PATH_RESAMPLE_GAP_MAX_M))

  /** ② 先按目标步数铺一段段步长 */
  const count = Math.max(2, Math.round(total / stepMean))
  const steps: number[] = []
  for (let i = 0; i < count; i++) steps.push(stepMean * (1 - spread + rng() * 2 * spread))

  /** ③ 随机挑 0~gapMaxCount 段改成断点（落在中间段，避免把首尾吃掉） */
  const gapCount = count > 4 ? Math.floor(rng() * (gapMaxCount + 1)) : 0
  const used = new Set<number>()
  for (let g = 0; g < gapCount; g++) {
    let idx = 1 + Math.floor(rng() * Math.max(1, count - 2))
    for (let guard = 0; guard < 8 && used.has(idx); guard++) idx = 1 + Math.floor(rng() * Math.max(1, count - 2))
    if (used.has(idx)) continue
    used.add(idx)
    steps[idx] = gapMin + rng() * (gapMax - gapMin)
  }

  /** ④ 整体按比例缩放 ⇒ 步长之和精确等于原长（首尾点不动） */
  const sum = steps.reduce((a, b) => a + b, 0) || 1
  const scale = total / sum
  /** ⑤ 逐段取样（弧长线性插值） */
  const out: RealPathPoint[] = [{ ...list[0]! }]
  let pos = 0
  for (const step of steps) {
    pos = Math.min(total, pos + step * scale)
    out.push(pointAtArcLength(list, cum, pos))
  }
  out[out.length - 1] = { ...list[list.length - 1]! }
  return {
    points: out,
    sourcePoints: list.length,
    sampledPoints: out.length,
    meanStepM: Number((total / steps.length).toFixed(2)),
    gapCount: used.size,
    skipped: '',
  }
}

/**
 * **真实路径这一跑的完整几何计划**（2026-11-27 修剪 + 2026-11-28 重采样）：
 *
 * ## 为什么顺序是"先重采样、再修剪"（2026-11-28 实测改的）
 * 重采样把点放在原折线上、相邻点走**弦**，会不可避免地把 GPS 顶点处的微小折角"抹掉"一点点长度
 * （本机 22 条实测：3.42 m 一点时短 9~30 m，约 0.3%~0.9%）。若先修剪再重采样，最终里程就会比
 * 修剪时算的小一截，可能跌破"要求 × (1+超跑系数)"这条下限（实测踩到过：3.22 → 3.20）。
 * ⇒ 改成**先重采样、再按重采样后的真实长度做尾部修剪**，下限就永远成立。
 *
 * 另：重采样后若仍低于"要求 × 1.003"（原始里程本来就只比要求多一点点），**放弃重采样、保留原点列**
 * （宁可不换点，也不让里程掉到要求以下）。
 */
export interface RealPathGeometryPlan {
  /** 对应哪条预设（引擎据此确认不是上一轮留下的残留） */
  entryId: string
  /** 最终点列（重采样 → 尾部修剪后） */
  points: RealPathPoint[]
  /**
   * 🆕 2026-11-28（用户要求"看着截断对不对"）：**重采样后、还没裁尾**的那份点列。
   * `points` 是它的前缀（只裁末尾 ⇒ 剩下的就是前 N 个点），差集就是被裁掉的尾巴。
   * 调试面板据此画三条线：原始灰线 / 最终绿线 / 被裁红线。
   */
  sampled: RealPathPoint[]
  /** 原始 / 重采样后 / 最终里程（km，3 位小数；都按各自点列实测） */
  originalKm: number
  resampledKm: number
  finalKm: number
  /** 首端恒为 0（只裁末尾）/ 尾端裁掉多少米 */
  trimStartM: number
  trimEndM: number
  overshootRatio: number
  /** 原始 / 重采样后 / 最终点数 */
  sourcePoints: number
  sampledPoints: number
  keptPoints: number
  /** 重采样里的断点数 */
  gapCount: number
  /** 重采样没做的原因（空串 = 做了） */
  resampleSkipped: string
  /** 尾部修剪没做的原因（空串 = 做了） */
  skipped: string
}

export function planRealPathGeometry(
  points: RealPathPoint[],
  opts: { entryId?: string; requiredKm: number; rng?: () => number },
): RealPathGeometryPlan {
  const rng = opts.rng ?? Math.random
  const entryId = String(opts.entryId ?? '')
  const list = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)))
    .map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
  const originalKm = Number((pathLengthM(list) / 1000).toFixed(3))
  const requiredKm = Number(opts.requiredKm)

  /**
   * ② 兜底门槛：重采样把长度吃掉一点点（弦切顶点），若已经低于"要求 × 1.003"就不换点。
   * 判据：这条只在"有要求里程"时生效；自由跑（要求 0）照常重采样。
   * 先按 3.42 m 试；不够就**改用更密的 2.05 m 再试一次**（点越密、弦切越少），仍不够才放弃。
   */
  const hardFloorM = requiredKm > 0 ? requiredKm * 1.003 * 1000 : 0
  const accept = (pts: RealPathPoint[]): boolean => hardFloorM === 0 || pathLengthM(pts) >= hardFloorM
  let resample = resampleRealPath(list, { rng })
  if (!resample.skipped && !accept(resample.points)) {
    const denser = resampleRealPath(list, { rng, stepMeanM: REAL_PATH_RESAMPLE_STEP_M * 0.6 })
    if (!denser.skipped && accept(denser.points)) resample = denser
    else {
      resample = { ...resample, points: list, sampledPoints: list.length, gapCount: 0, skipped: `重采样后里程会低于下限 ${(hardFloorM / 1000).toFixed(3)} km，保留原点列` }
    }
  }
  const sampled = resample.skipped && resample.points.length === list.length ? list : resample.points
  const resampleSkipped = resample.skipped
  const resampledKm = Number((pathLengthM(sampled) / 1000).toFixed(3))

  /** ③ 再按重采样后的真实长度做尾部修剪（下限永远成立） */
  const trim = planRealPathTrim(sampled, { entryId, requiredKm, rng })
  const finalPoints = trim.points
  return {
    entryId,
    points: finalPoints,
    sampled: [...sampled],
    originalKm,
    resampledKm,
    finalKm: Number((pathLengthM(finalPoints) / 1000).toFixed(3)),
    trimStartM: trim.trimStartM,
    trimEndM: trim.trimEndM,
    overshootRatio: trim.overshootRatio,
    sourcePoints: list.length,
    sampledPoints: resampleSkipped === resample.skipped ? resample.sampledPoints : list.length,
    keptPoints: trim.keptPoints,
    gapCount: resampleSkipped === resample.skipped ? resample.gapCount : 0,
    resampleSkipped,
    skipped: trim.skipped,
  }
}

/**
 * **截断自检**（2026-11-28 用户要求"我要看一下你这个截断的对吗"）：
 * 把"该成立的性质"变成可逐条判定的项，界面调试面板与单测共用同一份 ——
 * 不靠肉眼看图，也不靠"我觉得对"。
 *
 * 判据（每条都能给出数字）：
 *   ① 起点未动：最终点列第 0 点 = 重采样第 0 点（只裁末尾的必然结果）；
 *   ② 只裁末尾：最终点列是重采样点列的**前缀**（逐点比对），且点数 = 重采样点数 − 被裁掉的点数；
 *   ③ 长度守恒：`最终长度 + 裁掉的长度 ≈ 重采样长度`（±3 m，含按点取整）；
 *   ④ 不越下限：做了修剪 ⇒ `最终里程 ≥ 要求 × (1 + 超跑系数)`；没做修剪 ⇒ 如实说明不适用；
 *   ⑤ 重采样没有偷长度：`|重采样长度 − 原始长度|` 不超过原始的 1.5%（弦切顶点是有限度的）。
 */
export interface RealPathPlanCheck {
  label: string
  ok: boolean
  detail: string
}

export function realPathPlanChecks(
  plan: RealPathGeometryPlan | null | undefined,
  opts: { requiredKm: number; rawPoints?: RealPathPoint[] } = { requiredKm: 0 },
): RealPathPlanCheck[] {
  if (!plan) return []
  const out: RealPathPlanCheck[] = []
  const first = plan.points[0]
  const sampledFirst = plan.sampled[0]
  out.push({
    label: '起点未动',
    ok: Boolean(first && sampledFirst) && first!.latitude === sampledFirst!.latitude && first!.longitude === sampledFirst!.longitude,
    detail: first ? `最终首点 ${first.latitude.toFixed(6)}, ${first.longitude.toFixed(6)}` : '（没有点）',
  })

  /** 前缀比对：最终点列逐点等于重采样点列的前 N 个 */
  const n = plan.points.length
  const isPrefix = n <= plan.sampled.length && plan.points.every((p, i) => {
    const q = plan.sampled[i]!
    return p.latitude === q.latitude && p.longitude === q.longitude
  })
  out.push({
    label: '只裁末尾（最终点列 = 重采样点列的前缀）',
    ok: isPrefix,
    detail: `${n} / ${plan.sampled.length} 点保留，砍掉 ${plan.sampled.length - n} 点`,
  })

  const finalM = pathLengthM(plan.points)
  const sampledM = pathLengthM(plan.sampled)
  const diff = sampledM - finalM
  out.push({
    label: '长度守恒（裁掉的量 = 重采样长度 − 最终长度）',
    /** 容差 = 一个采样步长的量级：裁量按弧长算，切点按点取整（3.4~4.4 m 一步） */
    ok: Math.abs(diff - plan.trimEndM) <= 8,
    detail: `重采样 ${(sampledM / 1000).toFixed(3)} km − 最终 ${(finalM / 1000).toFixed(3)} km = ${diff.toFixed(1)} m（记录裁量 ${plan.trimEndM.toFixed(1)} m）`,
  })

  if (plan.skipped) {
    out.push({ label: '不越下限', ok: true, detail: `未修剪（不适用）—— ${plan.skipped}` })
  } else {
    const floorKm = opts.requiredKm > 0 ? opts.requiredKm * (1 + plan.overshootRatio) : 0
    out.push({
      label: '不越下限',
      ok: opts.requiredKm > 0 ? plan.finalKm + 0.0005 >= floorKm : true,
      detail: opts.requiredKm > 0 ? `最终 ${plan.finalKm.toFixed(3)} km vs 下限 ${floorKm.toFixed(3)} km` : '没有要求里程（自由跑）',
    })
  }

  if (opts.rawPoints && opts.rawPoints.length >= 2) {
    const rawM = pathLengthM(opts.rawPoints)
    out.push({
      label: '重采样没有偷长度',
      ok: rawM > 0 ? Math.abs(sampledM - rawM) <= rawM * 0.015 : true,
      detail: `原始 ${(rawM / 1000).toFixed(3)} km → 重采样 ${(sampledM / 1000).toFixed(3)} km（差 ${((sampledM - rawM) / 1000).toFixed(3)} km）`,
    })
  }
  return out
}

/**
 * **重采样前后"差多少"的量化**（2026-11-28 用户要求："将插值前和插值后的轨迹也渲染，看差别有多大"）。
 *
 * 两个维度分开量，别混为一谈：
 *   · **形状**（线）差多少：原始每个顶点到重采样折线的最大距离 —— 重采样点都落在原线上，所以它很小；
 *   · **点**差多少：重采样点到**最近的原始顶点**的距离 —— 点换了位置，所以它不小（≈半个步长）。
 * 这两个数放在一起看，就是"线几乎没变、点全换了"的量化证据。
 */
export interface RealPathDiffMetrics {
  rawCount: number
  sampledCount: number
  /** 原始/重采样各自的平均点距（米） */
  rawMeanStepM: number
  sampledMeanStepM: number
  /** 原始顶点到重采样折线的**最大**距离（米）——形状差 */
  shapeMaxM: number
  /** 重采样点到最近原始顶点的平均 / 最大距离（米）——点位移 */
  shiftMeanM: number
  shiftMaxM: number
}

export function realPathDiffMetrics(raw: RealPathPoint[], sampled: RealPathPoint[]): RealPathDiffMetrics {
  const meanStep = (list: RealPathPoint[]): number => {
    if (list.length < 2) return 0
    return pathLengthM(list) / (list.length - 1)
  }
  const rawList = (raw ?? []).filter((p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
  const sampledList = (sampled ?? []).filter((p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
  /** 形状差：原始顶点 → 重采样折线（每个原始点取到各段的最短距离，取最大） */
  let shapeMax = 0
  if (rawList.length && sampledList.length >= 2) {
    const stride = Math.max(1, Math.floor(rawList.length / 600))
    for (let i = 0; i < rawList.length; i += stride) {
      const p = rawList[i]!
      let best = Infinity
      for (let j = 1; j < sampledList.length; j++) {
        const d = pointToSegmentM(p, sampledList[j - 1]!, sampledList[j]!)
        if (d < best) best = d
        if (best === 0) break
      }
      if (best > shapeMax) shapeMax = best
    }
  }
  /** 点位移：重采样点 → 最近原始顶点 */
  let shiftSum = 0
  let shiftMax = 0
  let shiftCount = 0
  if (sampledList.length && rawList.length) {
    const stride = Math.max(1, Math.floor(sampledList.length / 600))
    for (let i = 0; i < sampledList.length; i += stride) {
      const q = sampledList[i]!
      let best = Infinity
      for (const p of rawList) {
        const d = distanceM(p, q)
        if (d < best) best = d
      }
      if (!Number.isFinite(best)) continue
      shiftSum += best
      if (best > shiftMax) shiftMax = best
      shiftCount++
    }
  }
  return {
    rawCount: rawList.length,
    sampledCount: sampledList.length,
    rawMeanStepM: Number(meanStep(rawList).toFixed(2)),
    sampledMeanStepM: Number(meanStep(sampledList).toFixed(2)),
    shapeMaxM: Number(shapeMax.toFixed(2)),
    shiftMeanM: Number((shiftCount ? shiftSum / shiftCount : 0).toFixed(2)),
    shiftMaxM: Number(shiftMax.toFixed(2)),
  }
}

/** 界面**短行**：一行报完（完整原因放悬停提示，别把界面铺满） */
export function realPathPlanShortText(plan: RealPathGeometryPlan | null | undefined): string {
  if (!plan) return ''
  const sample = plan.resampleSkipped
    ? `重采样未做（${plan.resampleSkipped.includes('下限') ? '余量不足' : '点太少'}）`
    : `重采样 ${plan.sourcePoints} → ${plan.sampledPoints} 点${plan.gapCount > 0 ? `（${plan.gapCount} 处断点）` : ''}`
  const trim = plan.skipped ? '未修剪（余量不足）' : `尾部裁 ${Math.round(plan.trimEndM)} m`
  return `${sample} · ${trim} · 结算 ${plan.finalKm.toFixed(2)} km`
}

/** 界面一句话：重采样换了几点、尾部裁了多少、结算里程多少（没做就如实说原因） */
export function realPathPlanText(plan: RealPathGeometryPlan | null | undefined): string {
  if (!plan) return ''
  const sampleText = plan.resampleSkipped
    ? `重采样：不做 —— ${plan.resampleSkipped}`
    : `重采样：${plan.sourcePoints} → ${plan.sampledPoints} 点（约 ${(plan.resampledKm * 1000 / Math.max(1, plan.sampledPoints - 1)).toFixed(1)} m 一点` +
      `${plan.gapCount > 0 ? `，${plan.gapCount} 处断点` : ''}）`
  const trimText = plan.skipped
    ? `尾部修剪：不修剪 —— ${plan.skipped}`
    : `尾部修剪：${plan.resampledKm.toFixed(2)} → ${plan.finalKm.toFixed(2)} km（裁掉末尾 ${Math.round(plan.trimEndM)} m）`
  return `${sampleText} · ${trimText} · 结算里程 ${plan.finalKm.toFixed(2)} km，每次载入重抽`
}

/**
 * **从一次真实跑里切出"一圈"**（本功能的关键一步，纯函数）。
 *
 * ## 为什么必须切
 * 真人一次跑 3 km = 5~8 圈。若把**整条**轨迹当成"一圈"存进路线库，
 * 跑图时"一圈"就变成 3 km（`lapLengthM` 报 3000 m、按圈着色只有 1 圈、换圈剖面 n=1）——
 * 那不是用户想要的"用这条路径跑"。
 *
 * ## 判据（**从任意一点起算**，不是只认 `p[0]`）
 * 对每个起点 `i`：找最小的 `j`，使 `dist(p[i], p[j]) ≤ tolM` 且 `arc(i..j) ≥ minM`；
 * 取**第一组**（`i` 最小）命中，返回 `p[i..j]`。
 *
 * ## 为什么不能用 `p[0]` 当基准（2026-11-03 实测踩到）
 * 真人开跑前常常**从场外走进来**（进场几步、站在跑道边调表）⇒ `p[0]` 根本不在跑道上，
 * 于是"回到起点 25 m 内"**永远不会命中**，函数退回整条轨迹 —— 用户看到的就是
 * "原始 1121 点 → 存成预设时用 600 点"（只是降采样，根本没切圈）。
 * 改成从任意点起算后，只要**跑道上任意一处**之后又回到附近，就能切出那一圈。
 *
 * ## 其它口径
 *   · 找不到（不是闭环 / 跑得歪）⇒ **原样返回整条**（绝不凭空造一个闭合环）；
 *   · 输入不足 3 点 ⇒ 原样返回（调用方自己判"不可用"）；
 *   · 返回的片段**首尾都在闭环附近**，因此交给 `freeShape: curve`（首尾自动闭合）语义正确。
 */
export function extractOneLap(points: RealPathPoint[], opts: { tolM?: number; minM?: number } = {}): RealPathPoint[] {
  const list = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) : []
  if (list.length < 3) return list
  const tolM = Math.max(5, Number(opts.tolM ?? 25))
  const minM = Math.max(50, Number(opts.minM ?? 200))
  /** 累计长度（用于 `minM` 判据） */
  const cum = [0]
  for (let i = 1; i < list.length; i++) cum.push(cum[i - 1]! + distanceM(list[i - 1]!, list[i]!))
  /**
   * 全量枚举是 O(n²)（1121 点 ≈ 63 万次比较，纯浮点，毫秒级）；
   * 为了让长轨迹也不卡，限制**每个起点只看最多 `SCAN_AHEAD` 个后续点**（覆盖到 ~2 圈足够）。
   */
  const SCAN_AHEAD = Math.min(list.length - 1, 1200)
  for (let i = 0; i < list.length - 2; i++) {
    const a = list[i]!
    for (let j = i + 2; j <= Math.min(list.length - 1, i + SCAN_AHEAD); j++) {
      if (cum[j]! - cum[i]! < minM) continue
      if (distanceM(a, list[j]!) <= tolM) {
        return list.slice(i, j + 1)
      }
    }
  }
  return list
}

/**
 * **按几何位置判断"这一跑属于哪条官方线路"**（2026-11-03，用户实测反馈"没识别到任务记录的线路"）。
 *
 * ## 为什么必须靠几何
 * `getSunrunArch` 的记录里**只有 `paperId`（任务 id），没有线路 id**（字段表见
 * `_mp-analyze/深挖/D-配置与归档数据模型.md` §4.1）—— 也就是说**服务端不告诉我们那次跑的是哪条线**。
 * 而任务的线路之间通常相隔很远（东操场/西操场/图书馆…）⇒ 用轨迹与各线路 `pointList` 的**最近距离**
 * 判断，既准确又不需要额外接口。
 *
 * ## 判据
 * 对每条线路算"轨迹点到该折线的**最小**距离"，取最小者；
 *   · 若最小距离 > `maxDistM`（默认 150 m）⇒ 认定为"匹配不上"，返回 `null`
 *     （宁可让用户自己选，也不硬塞一条错的地点）；
 *   · 相同距离时按传入顺序取第一条（稳定、可测）。
 * ⚠️ 纯函数、无副作用；只做"建议"，最终存到哪个地点仍由界面上的下拉决定。
 */
export function nearestLineByGeometry(
  points: RealPathPoint[],
  lines: { pointId: string; pointName?: string; pointList?: RealPathPoint[] }[],
  opts: { maxDistM?: number; stride?: number } = {},
): { pointId: string; pointName: string; distM: number } | null {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
  if (pts.length < 3) return null
  /** 点太多没必要全算（每隔 `stride` 取一个，默认让 1000 点降到 ~200 点） */
  const stride = Math.max(1, Math.round(Number(opts.stride ?? Math.ceil(pts.length / 200))))
  const sampled: RealPathPoint[] = []
  for (let i = 0; i < pts.length; i += stride) sampled.push(pts[i]!)
  if (sampled[sampled.length - 1] !== pts[pts.length - 1]) sampled.push(pts[pts.length - 1]!)
  const maxDistM = Math.max(10, Number(opts.maxDistM ?? 150))

  let best: { pointId: string; pointName: string; distM: number } | null = null
  for (const line of Array.isArray(lines) ? lines : []) {
    const poly = (Array.isArray(line?.pointList) ? line.pointList : []).filter(
      (p) => p && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)),
    ) as RealPathPoint[]
    const id = String(line?.pointId ?? '').trim()
    if (!id || poly.length < 2) continue
    /** 轨迹点到这条线路折线的**最小距离**（逐段求点到线段距离） */
    let minD = Number.POSITIVE_INFINITY
    for (const p of sampled) {
      for (let k = 1; k < poly.length; k++) {
        const d = pointToSegmentM(p, poly[k - 1]!, poly[k]!)
        if (d < minD) minD = d
      }
      if (minD <= 1) break
    }
    if (!Number.isFinite(minD)) continue
    if (!best || minD < best.distM) best = { pointId: id, pointName: String(line?.pointName ?? id), distM: minD }
  }
  if (!best || best.distM > maxDistM) return null
  return best
}

// ---------------------------------------------------------------- 地点归属判定（2026-11-10）

/** 一个可选地点（界面上的「存到哪个地点」就是这么来的） */
export interface PlaceOption {
  /** 厂商线路 pointId 或本机键（如 local:free） */
  value: string
  /** 显示名（厂商线路名 / 本机键的说明） */
  title: string
  /** 这条线路的官方点列（有才能做几何匹配；本机键通常没有） */
  pointList?: RealPathPoint[]
}

/** 一条路径**归到哪个地点**的判定结果 */
export interface PlaceResolution {
  /** 定下来的地点（null = 认不出来，要用户自己选） */
  place: PlaceOption | null
  /** 怎么定下来的：包里的地点 / 按名字对上 / 按轨迹位置对上 / 认不出 */
  via: 'bundle-id' | 'bundle-name' | 'geometry' | 'none'
  /** 人话说明（界面上如实展示「为什么归到这儿」） */
  reason: string
  /** 按几何匹配时的最近距离（米；没走几何匹配 ⇒ null） */
  distM?: number | null
}

/** 名字归一化：去括号里的备注、去空白、统一小写 */
const placeNameKey = (raw: unknown): string =>
  String(raw ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()

/**
 * **一条路径属于哪个地点**（唯一判据；导入时逐条调它）。
 *
 * 按顺序取第一个命中的（用户口径：「先看包里的地点，再看轨迹坐标」）：
 *   ① lineId **精确命中**本机可选地点 ⇒ bundle-id（最可靠：ID 不会重名）；
 *   ② lineName 与某个地点的显示名**同名**（归一化后比；唯一命中才算）⇒ bundle-name
 *      （好友那边线路 ID 可能不同，但操场名通常一致）；
 *   ③ 用**轨迹坐标**与各线路点列比最近距离（nearestLineByGeometry，>150 m 不算）⇒ geometry
 *      （旧包里没有地点信息时，这是唯一能自动归位的办法）；
 *   ④ 都不行 ⇒ none，界面据此**弹出「选择存档地点」**。
 *
 * ⚠️ 纯函数、无副作用；**不猜**地点 —— 宁可就 none 让用户选，也不要硬塞一个错的。
 */
export function resolvePlace(
  item: { lineId?: unknown; lineName?: unknown; points?: unknown },
  options: PlaceOption[],
  opts: { maxDistM?: number } = {},
): PlaceResolution {
  const list = (Array.isArray(options) ? options : []).filter((o) => o && String(o.value ?? '').trim())
  const lineId = String(item?.lineId ?? '').trim()
  const lineName = String(item?.lineName ?? '').trim()

  if (lineId) {
    const byId = list.find((o) => String(o.value) === lineId)
    if (byId) return { place: byId, via: 'bundle-id', reason: '包里写明属于「' + byId.title + '」' }
  }

  const key = placeNameKey(lineName)
  if (key) {
    /** 同名多条时**不猜**（例如两个校区都有「东操场」）—— 交给几何或用户 */
    const byName = list.filter((o) => placeNameKey(o.title) === key)
    if (byName.length === 1) {
      return { place: byName[0]!, via: 'bundle-name', reason: '按地点名「' + byName[0]!.title + '」对上' }
    }
  }

  const pts = (Array.isArray(item?.points) ? item.points : []) as RealPathPoint[]
  const geo = nearestLineByGeometry(
    pts,
    list
      .filter((o) => Array.isArray(o.pointList) && o.pointList.length >= 2)
      .map((o) => ({ pointId: String(o.value), pointName: o.title, pointList: o.pointList })),
    { maxDistM: opts.maxDistM ?? 150 },
  )
  if (geo) {
    return {
      place: list.find((o) => String(o.value) === geo.pointId) ?? null,
      via: 'geometry',
      reason: '按轨迹位置匹配到「' + geo.pointName + '」（最近约 ' + Math.round(geo.distM) + ' m）',
      distM: geo.distM,
    }
  }

  const why =
    lineName || lineId
      ? '包里写的地点「' + (lineName || lineId) + '」在本机不存在，轨迹也匹配不上任何线路'
      : '包里没有地点信息，轨迹也匹配不上任何线路'
  return { place: null, via: 'none', reason: why, distM: null }
}

/**
 * 点到**线段**的距离（米；局部等距近似，够用且便宜）。
 * 与 `routeSimilarity.pointToSegmentDistance` 同口径（那边是"度"为单位），这里出口是米。
 */
export function pointToSegmentM(p: RealPathPoint, a: RealPathPoint, b: RealPathPoint): number {
  const mLat = 111320
  const mLng = 111320 * Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180)
  const px = p.longitude * mLng
  const py = p.latitude * mLat
  const ax = a.longitude * mLng
  const ay = a.latitude * mLat
  const bx = b.longitude * mLng
  const by = b.latitude * mLat
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  const qx = ax + t * dx
  const qy = ay + t * dy
  return Math.hypot(px - qx, py - qy)
}

/**
 * **等距降采样**（`maxPoints` 上限）：`points.length ≤ maxPoints` 时**原样返回**；否则按步长抽，**首末必留**。
 * ⚠️ 2026-11-04 起**产品代码不再使用它**（用户口径：真实路径**原样整条**保存/上传，不切圈不降采样）；
 *    函数与单测保留 —— 万一以后要给超长轨迹做个"体量保护"，判据已经钉在这里。
 */
export function downsamplePath(points: RealPathPoint[], maxPoints = 600): RealPathPoint[] {
  const list = Array.isArray(points) ? points : []
  const max = Math.max(8, Math.round(Number(maxPoints) || 600))
  if (list.length <= max) return list
  const step = (list.length - 1) / (max - 1)
  const out: RealPathPoint[] = []
  for (let i = 0; i < max; i++) out.push(list[Math.round(i * step)]!)
  /** 首末必须精确是原来的首末（四舍五入可能落到次末点） */
  out[0] = list[0]!
  out[out.length - 1] = list[list.length - 1]!
  return out
}

/**
 * 拟一个**默认的预设名**（用户可改）：`东操场 · 真实路径 2026-11-01 · 0812`。
 * 🆕 2026-11-04（用户口径"默认名携带路径名称"）：`lineName` 非空时**前缀地点名**（如「天目湖-东操场」）；
 * 空白/缺省 = 不带（与旧版逐字一致）。
 * ⚠️ 名字的**唯一性不在这里判**（那是 `autoPresetName` / `findNameConflict` 的事），
 *    本函数只负责"给一个像样的起点"。
 */
export function defaultRealPathName(
  meta: Pick<RealPathMeta, 'date' | 'usedTime'> & { startTime?: string },
  lineName = '',
): string {
  const d = isIsoDate(meta.date) ? meta.date : '日期未知'
  const t = String(meta.startTime ?? '').replace(/:/g, '').slice(0, 4)
  const base = t ? `真实路径 ${d} · ${t}` : `真实路径 ${d}`
  const loc = String(lineName ?? '').trim()
  return loc ? `${loc} · ${base}` : base
}

/** 随机后缀的字符集（只用小写字母 + 数字：好念、好打进搜索框、不会有大小写歧义） */
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 造一段**短随机后缀**（默认 4 位，如 `2b9c`）—— 用户口径："生成的路径名称后加上一段随机字符防止相同导致异常"。
 *
 * 为什么需要：同一场成绩在不同机器上导出、或同一天跑两场、或好友把包发回来再导，
 * 默认名会**逐字相同**；而本项目"预设名称全库不可重复"是硬判据 ⇒ 后到的那个会被直接拒收。
 * 加上随机后缀，同名概率降到 36^4 ≈ 1/168 万，正常使用不会再撞。
 *
 * @param rand 注入随机源（单测用；默认 `Math.random`）
 */
export function randomNameSuffix(len = 4, rand: () => number = Math.random): string {
  /** 非法长度（0/负数/NaN）⇒ 回默认 4；上限 12（再长就不是"短后缀"了） */
  const wanted = Math.trunc(Number(len))
  const n = Number.isFinite(wanted) && wanted >= 1 ? Math.min(12, wanted) : 4
  let out = ''
  for (let i = 0; i < n; i++) {
    const r = Number(rand())
    const idx = Math.trunc((Number.isFinite(r) ? Math.abs(r) % 1 : 0) * SUFFIX_ALPHABET.length)
    out += SUFFIX_ALPHABET[Math.min(idx, SUFFIX_ALPHABET.length - 1)]
  }
  return out
}

/**
 * 给一个名字**追加随机后缀**（用户口径：只加在**自动生成**的名字上，手打的保留原样）。
 *
 * 判据：`withRandomSuffix('东操场 · 真实路径 2026-09-17 · 1910', () => 0)` → `'… · 1910-2b9c'` 形状
 *      （后缀与主干之间用 `-` 连接，读起来像版本号/批号，不干扰主干的可读性）。
 * ⚠️ 限长由 `sanitizeLineName()` 在落库那一步统一处理；这里只保证"后缀在最尾部、不会被自己挤掉"。
 */
export function withRandomSuffix(name: string, rand: () => number = Math.random): string {
  const base = String(name ?? '').trim()
  if (!base) return base
  const suffix = randomNameSuffix(4, rand)
  /** 已经带过后缀形状（`-xxxx`，4 位小写字母数字）就别再叠一层 */
  if (/-[a-z0-9]{4}$/.test(base)) return base
  return `${base}-${suffix}`
}

/**
 * 清洗 zip **包内条目名**（批量导出的每条路径一个 JSON）。
 *
 * 判据（与 `server/api/local/real-path/share.post.ts` 同一口径，那边也调它）：
 *   · 去掉 `/`、`\`、控制字符与 Windows 保留字符（`createZip` 只收"以 / 分隔的相对路径"）；
 *   · 保留中文与空格；折叠连续空白；
 *   · 收尾补 `.json`；空白输入 ⇒ 兜底名；
 *   · 按**码点**限长 80（ZIP 条目名上限是 65535 **字节**，80 码点远够用，也免得一个超长名把包撑怪）。
 */
export function sanitizeZipEntryName(raw: unknown): string {
  const s = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const cps = Array.from(s || '真实路径')
  const clipped = cps.length > 80 ? cps.slice(0, 80).join('') : cps.join('')
  return /\.json$/i.test(clipped) ? clipped : `${clipped}.json`
}

/** 把一条路径的**分享包**序列化出来（批量导出时每条一个文件；与单条导出的结构逐字相同） */
export function bundleJsonOf(item: RealPathBundleItem, exportedAt = new Date().toISOString()): string {
  return JSON.stringify(buildShareBundle([item], exportedAt))
}

/**
 * 读归档时**当前生效的月份**：给了 `monthId` 就用它；没给就选「当前月份」。
 *
 * 判据（按顺序，取第一个命中）：
 *   ① 列表里 `isCurrent` 的那一条；
 *   ② 没有（服务端没标 / 标了两条以上）⇒ 用 `now` 推出 `YYYYMM`，按 `monthId` **或** `monthName`
 *      （`2026年11月` / `2026-11` 都认）对上那一条；
 *   ③ 还选不出 ⇒ 空串（**不猜月份**：猜错了界面上会"高亮一个月份、读的却是另一个月份的成绩"）。
 *
 * 返回值就是发给 `getSunrunArch` 的 `monthId`，界面据此高亮，两边同源。
 */
export function pickMonthId(
  months: { monthId: string; monthName: string; isCurrent: boolean }[],
  monthId?: string,
  now: Date = new Date(),
): string {
  const picked = String(monthId ?? '').trim()
  if (picked) return picked
  const list = (Array.isArray(months) ? months : []).filter((m) => m && String(m.monthId ?? '').trim())
  const nameOf = (m: { monthName?: unknown }) => String(m.monthName ?? '').trim()
  const marked = list.filter((m) => m.isCurrent)
  if (marked.length === 1) return String(marked[0]!.monthId).trim()
  const yearMonth = `${now.getFullYear()}年${now.getMonth() + 1}月`
  const alt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const byName = (m: { monthName?: unknown }) => nameOf(m) === yearMonth || nameOf(m) === alt
  const hit = (marked.length > 1 ? marked.find(byName) : undefined) ?? list.find(byName)
  return hit ? String(hit.monthId).trim() : ''
}

/** 生成预设草稿需要的输入（组合层从"选中的那天那条记录 + 它的点列"组装） */
export interface RealPathPresetDraftInput {
  meta: RealPathMeta
  /**
   * **原样整条轨迹**（🆕 2026-11-04 用户口径"直接原样上传，而不是只保留几圈"）：
   * **不切圈、不降采样**，点列顺序即跑向。一圈长度（预览着色用）由 `meta.lapLengthM` 携带。
   */
  points: RealPathPoint[]
  /** 保存到哪个**地点**（厂商线路 `pointId` 或本机键；界面让用户选） */
  lineId: string
  /** 那个地点的名字快照 */
  lineName: string
  /** 用户填的预设名（留空则由组合层自动命名） */
  presetName?: string
}

/**
 * 由"真实路径 + 目标地点"生成**预设草稿**（还不落库；落库走 `lib.upsert`）。
 *
 * 口径与「研途健行路径编辑器」保存的那条**完全一致**（这样才能被跑步页当几何用）：
 *   · 几何权威是 `freeShape`（`kind: 'curve'`，首尾自动闭合）；
 *   · `outer`/`inner` 放**占位几何**（≥3 点，给旧版本应用看）—— 复用 `freeShapePlaceholderRing`；
 *   · `start` 显式 `null`（形状就是路径本身，"起跑点 = 第 1 个点"）。
 *
 * ⚠️ 返回的是**给 `upsert` 的入参**，不是已经归一化的 `TrackRouteEntry`；
 *    `realPath` 元信息一并带上（可选字段，旧数据没有它 ⇒ 行为不变）。
 */
export function buildRealPathPresetDraft(input: RealPathPresetDraftInput): {
  lineId: string
  lineName: string
  presetName: string
  outer: RealPathPoint[]
  inner: RealPathPoint[]
  freeShape: { kind: 'curve'; points: RealPathPoint[] }
  start: null
  realPath: RealPathMeta
} {
  const points = (Array.isArray(input.points) ? input.points : []).map((p) => ({
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
  }))
  /** 占位几何：把真实路径**均匀取 3 点**充数（旧版本只要求"内外圈各 ≥3 点"） */
  const placeholder = (() => {
    if (points.length < 3) return points
    const idx = [0, Math.floor(points.length / 2), points.length - 1]
    return idx.map((i) => points[i]!)
  })()
  return {
    lineId: String(input.lineId ?? ''),
    lineName: String(input.lineName ?? ''),
    presetName: String(input.presetName ?? ''),
    outer: placeholder.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    inner: placeholder.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    freeShape: { kind: 'curve', points },
    start: null,
    realPath: { ...input.meta },
  }
}

// ---------------------------------------------------------------- 分享包（zip 里那份 JSON）

/** 分享包的格式版本（改了它就要考虑旧包还能不能读） */
export const REAL_PATH_BUNDLE_VERSION = 1
/** 分享包里的**唯一**条目名（固定，便于人肉排查） */
export const REAL_PATH_BUNDLE_FILE = 'totoro-real-path.json'
/** 分享包的种类标记（防止把别的 JSON 当路径包导入） */
export const REAL_PATH_BUNDLE_KIND = 'totoro-real-path'

/** 分享包里的**一条**路径（只放几何 + 元信息，**绝不放 token/学号/姓名**） */
export interface RealPathBundleItem {
  name: string
  /**
   * 这条路径**属于哪个地点**（厂商线路 pointId，或本机键如 local:free）。
   *
   * 🔴 2026-11-10：导出时**必须写值**。此前一律写空串，包里没有地点信息 ⇒
   * 导入时只能落到界面下拉当前选中的地点（默认「本机跑道」），用户反馈的就是这个
   * （「导入东操场的路径，没有被录入到东操场」）。
   * 空串仍有意义：**旧包**（这一版之前导出的）里就是空串，导入时走「几何匹配 / 让用户选」。
   */
  lineId: string
  /** 那个地点的**名字快照**（好友那里可能没有同名线路，所以只作提示与名字匹配用） */
  lineName: string
  points: RealPathPoint[]
  meta: RealPathMeta
}

/** 分享包（会被序列化进 zip 的唯一 JSON） */
export interface RealPathBundle {
  kind: typeof REAL_PATH_BUNDLE_KIND
  version: number
  /** 导出时刻（ISO） */
  exportedAt: string
  items: RealPathBundleItem[]
}

/**
 * 构造分享包（**只有几何与必要元信息**）。
 * 🔴 隐私红线：这里**只挑白名单字段**，绝不整对象透传（`TrackRouteEntry` 里将来加了什么都不会漏出去）。
 */
export function buildShareBundle(items: RealPathBundleItem[], exportedAt = new Date().toISOString()): RealPathBundle {
  return {
    kind: REAL_PATH_BUNDLE_KIND,
    version: REAL_PATH_BUNDLE_VERSION,
    exportedAt: String(exportedAt),
    items: (Array.isArray(items) ? items : []).map((it) => ({
      name: String(it.name ?? ''),
      lineId: String(it.lineId ?? ''),
      lineName: String(it.lineName ?? ''),
      points: (Array.isArray(it.points) ? it.points : []).map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
      meta: {
        date: String(it.meta?.date ?? ''),
        scoreId: String(it.meta?.scoreId ?? ''),
        km: it.meta?.km === null || it.meta?.km === undefined ? null : Number(it.meta.km),
        usedTime: String(it.meta?.usedTime ?? ''),
        fitDegree: it.meta?.fitDegree === null || it.meta?.fitDegree === undefined ? null : Number(it.meta.fitDegree),
        sourcePoints: Number(it.meta?.sourcePoints ?? 0) || 0,
        /** 🆕 2026-11-04：一圈长度（预览按圈着色用）；没有 ⇒ null */
        lapLengthM: it.meta?.lapLengthM === null || it.meta?.lapLengthM === undefined ? null : Number(it.meta.lapLengthM),
        exportedAt: String(it.meta?.exportedAt ?? ''),
      },
    })),
  }
}

/** 解析分享包的结果（`error` 非空 = 读不了，且**说明原因**） */
export interface ParsedBundle {
  ok: boolean
  /** 失败原因（人话；成功时为空串） */
  error: string
  items: RealPathBundleItem[]
}

/**
 * 解析分享包（**坏数据一律拒绝并说明原因**，绝不半信半疑地导入）。
 * 判据：`kind` 必须是 `totoro-real-path`；`version` 认 1（更高的版本如实提示"需要更新软件"）；
 * 每条至少 3 个**合法**坐标点，否则丢掉那一条（并计数报告）。
 */
export function parseShareBundle(raw: unknown): ParsedBundle {
  const fail = (error: string): ParsedBundle => ({ ok: false, error, items: [] })
  let obj = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return fail('这不是一个有效的 JSON（文件可能损坏，或者不是路径包）')
    }
  }
  if (!obj || typeof obj !== 'object') return fail('路径包内容为空')
  const b = obj as Record<string, unknown>
  if (str(b.kind) !== REAL_PATH_BUNDLE_KIND) return fail('这不是「龙猫天堂」导出的路径包（缺少 kind 标记）')
  const version = Number(b.version)
  if (!Number.isFinite(version) || version < 1) return fail('路径包版本号不合法')
  if (version > REAL_PATH_BUNDLE_VERSION) return fail(`这个包是更新版本导出的（v${version}），请先更新软件再导入`)
  const list = Array.isArray(b.items) ? b.items : []
  const items: RealPathBundleItem[] = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const v = it as Record<string, unknown>
    const points = parseArchDetailPoints(v.points)
    if (points.length < 3) continue
    const meta = (v.meta && typeof v.meta === 'object' ? v.meta : {}) as Record<string, unknown>
    items.push({
      name: str(v.name),
      lineId: str(v.lineId),
      lineName: str(v.lineName),
      points,
      meta: {
        date: isIsoDate(meta.date) ? str(meta.date) : '',
        scoreId: str(meta.scoreId),
        km: num(meta.km),
        usedTime: str(meta.usedTime),
        fitDegree: num(meta.fitDegree),
        sourcePoints: Number(meta.sourcePoints) || 0,
        lapLengthM: num(meta.lapLengthM),
        exportedAt: str(meta.exportedAt),
      },
    })
  }
  if (!items.length) return fail('路径包里没有可用的路径（可能是空包，或坐标全部损坏）')
  return { ok: true, error: '', items }
}

/**
 * 从路径包里挑出**一条**要导入的（用户在界面上选；这里只做"选中"的纯逻辑）。
 * 传索引越界 ⇒ 返回 `undefined`（界面据此说"没选中"）。
 */
export function pickBundleItem(items: RealPathBundleItem[], index: number): RealPathBundleItem | undefined {
  const list = Array.isArray(items) ? items : []
  const i = Math.trunc(Number(index))
  if (!Number.isFinite(i) || i < 0 || i >= list.length) return undefined
  return list[i]
}

// ---------------------------------------------------------------- 批量选择与批量结果（2026-11-10）

/**
 * **批量选择**的开关（纯函数，界面只读它的返回值）：加进去 / 拿掉 / 全选 / 清空。
 *
 * 为什么要有它：批量导出与批量导入都要"点一条加一条、再点一下拿掉"，若各写一遍
 * `Set` 操作，两处对"重复点、点了不存在的项"的行为迟早不一致。
 *
 * 判据：返回的是**新集合**（不改入参）；`ids` 里的空串/空白一律忽略（界面可能把 `undefined` 传进来）。
 */
export function toggleSelection(current: Iterable<string>, id: string): Set<string> {
  const out = new Set<string>()
  for (const x of current) {
    const s = String(x ?? '').trim()
    if (s) out.add(s)
  }
  const key = String(id ?? '').trim()
  if (!key) return out
  if (out.has(key)) out.delete(key)
  else out.add(key)
  return out
}

/** 把一批 id **整体**加入或移出选择（全选/全不选用；同样忽略空串） */
export function setSelection(current: Iterable<string>, ids: Iterable<string>, on: boolean): Set<string> {
  const out = new Set<string>()
  for (const x of current) {
    const s = String(x ?? '').trim()
    if (s) out.add(s)
  }
  for (const raw of ids) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    if (on) out.add(s)
    else out.delete(s)
  }
  return out
}

/** 一次批量动作里**单条**的结果（成功或失败都要留名，绝不静默丢） */
export interface BatchOutcome {
  /** 这一条的显示名（失败时用它指出"是哪个包/哪一天出的问题"） */
  name: string
  ok: boolean
  /** 人话原因（成功时是"已导入…"，失败时是拒绝的理由） */
  message: string
}

/** 批量动作的汇总（界面据此给一句话 + 可展开的逐条清单） */
export interface BatchSummary {
  total: number
  okCount: number
  failCount: number
  /** 成功的那几条（顺序与调用方给的一致） */
  ok: BatchOutcome[]
  /** 失败的那几条（**必须在界面上列出来**，否则用户以为都成功了） */
  failed: BatchOutcome[]
  /** 一句话总结（成功 + 失败数都在里面；全成功时不提失败） */
  text: string
}

/**
 * 把逐条结果收敛成**一句总结 + 两份清单**。
 *
 * 🔴 判据（这是"导入失败要有提示"的机械保证）：`okCount + failCount === total`，
 *    且失败项的 `message` 非空 —— 任何一条被吞掉都会让这个等式不成立。
 */
export function summarizeBatch(outcomes: BatchOutcome[]): BatchSummary {
  const list = Array.isArray(outcomes) ? outcomes : []
  const ok = list.filter((o) => o.ok)
  const failed = list.filter((o) => !o.ok)
  const total = list.length
  let text: string
  if (!total) text = '没有可处理的条目'
  else if (!failed.length) text = `全部成功：${ok.length} 条`
  else if (!ok.length) text = `全部失败：${failed.length} 条（原因见下面逐条说明）`
  else text = `成功 ${ok.length} 条，失败 ${failed.length} 条（失败原因见下面逐条说明）`
  return { total, okCount: ok.length, failCount: failed.length, ok, failed, text }
}

/**
 * 按索引挑出要导入的那几条（**老口径**：单条导入时"只要包里第 N 条"）。
 *
 * ⚠️ 批量导入**不走它** —— 批量口径是"包里每条都收"（见 `readAllShareItemsFromZip` 与
 *    `importManyShareZips`），那样"包 A 1 条 + 包 B 2 条 ⇒ 3 条"才对得上。
 *    这里保留给"指定第几条"的单入口场景（`pickBundleItem` 的复数版），索引越界/重复都安全。
 */
export function batchImportCandidates(items: RealPathBundleItem[], index?: number[]): RealPathBundleItem[] {
  const list = Array.isArray(items) ? items : []
  if (!index || !index.length) return list
  const want = new Set(index.map((i) => Math.trunc(Number(i))).filter((i) => Number.isFinite(i) && i >= 0))
  return list.filter((_, i) => want.has(i))
}

// ---------------------------------------------------------------- zip 读取（store + deflate）

/** 读出来的一个条目 */
export interface ZipReadEntry {
  name: string
  data: Uint8Array
}

/**
 * **读 ZIP**（本功能只需要"读回自己导出的那个包"）。
 *
 * 支持两种 method：**0 = store**（我们自己写的包就是这个）与 **8 = deflate**
 * （好友可能用微信/7-Zip 重新压过；deflate 走平台的 `DecompressionStream('deflate-raw')`，
 * Node 18+ 与 Chrome 都内置，不引第三方库）。
 *
 * ⚠️ 只认 **local file header + central directory 之前的条目**：按 central directory 逐个定位，
 *    不靠"顺序扫描签名"（后者遇到文件名里带 `PK` 字节会读错）。
 * 判据：找不到 EOCD / central 段损坏 ⇒ 抛错（调用方转成人话）；不静默返回空包。
 */
export async function readZip(bytes: Uint8Array): Promise<ZipReadEntry[]> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(0)
  if (buf.length < 22) throw new Error('zip 太小（不是有效压缩包）')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  /** ① 找 EOCD（从尾部往前扫，最多 65557 字节） */
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip 里找不到目录（EOCD）')
  const count = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (!(count > 0) || cdOffset <= 0 || cdOffset >= buf.length) throw new Error('zip 目录段不合法')
  const decoder = new TextDecoder('utf-8')
  const out: ZipReadEntry[] = []
  let at = cdOffset
  for (let k = 0; k < count; k++) {
    if (at + 46 > buf.length) throw new Error('zip 目录段越界')
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('zip 目录项签名不对')
    const method = view.getUint16(at + 10, true)
    const compSize = view.getUint32(at + 20, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    const name = decoder.decode(buf.subarray(at + 46, at + 46 + nameLen))
    at += 46 + nameLen + extraLen + commentLen
    /** ② 按 local header 定位真实数据 */
    if (localOffset + 30 > buf.length) throw new Error(`zip 条目「${name}」的本地头越界`)
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`zip 条目「${name}」的本地头签名不对`)
    const lNameLen = view.getUint16(localOffset + 26, true)
    const lExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    if (dataStart + compSize > buf.length) throw new Error(`zip 条目「${name}」的数据越界`)
    const raw = buf.subarray(dataStart, dataStart + compSize)
    if (method === 0) {
      out.push({ name, data: raw })
    } else if (method === 8) {
      out.push({ name, data: await inflateRaw(raw) })
    } else {
      throw new Error(`zip 条目「${name}」用了不支持的压缩方式（method=${method}）`)
    }
  }
  return out
}

/** deflate-raw 解压（平台内置 `DecompressionStream`；不可用就如实报错，不假装成功） */
async function inflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: new (format: string) => DecompressionStream }).DecompressionStream
  if (!Ctor) throw new Error('当前环境不支持解压 deflate（请让好友直接发原包，或用「导出到本地」的那份）')
  /** ⚠️ 先拷成独立的 `ArrayBuffer` 再交给 Blob：`Uint8Array<ArrayBufferLike>` 可能是 SharedArrayBuffer 视图，
   *  而 `BlobPart` 只收 `ArrayBuffer`/`ArrayBufferView<ArrayBuffer>`（TS 会拦，运行时也可能行为不同）。 */
  const copy = new Uint8Array(raw.byteLength)
  copy.set(raw)
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new Ctor('deflate-raw'))
  const out = new Uint8Array(await new Response(stream).arrayBuffer())
  return out
}

/**
 * 从 zip 里取出路径包 JSON 并解析（**一步到位**，界面只调这一个）。
 * 找不到 JSON ⇒ 明确报错（说明"包里没有路径数据"），不静默当空包。
 */
export async function readShareBundleFromZip(bytes: Uint8Array): Promise<ParsedBundle> {
  let entries: ZipReadEntry[]
  try {
    entries = await readZip(bytes)
  } catch (err) {
    return { ok: false, error: `读不了这个压缩包：${err instanceof Error ? err.message : '未知错误'}`, items: [] }
  }
  const entry = entries.find((e) => /\.json$/i.test(e.name)) ?? entries[0]
  if (!entry) return { ok: false, error: '压缩包里没有文件', items: [] }
  const text = new TextDecoder('utf-8').decode(entry.data)
  return parseShareBundle(text)
}

/** 一个 zip 里解析出来的**一条**路径（带它是从哪个包内文件来的，便于逐条报错） */
export interface ZipBundleItem {
  /** 包内条目名（`totoro-real-path.json` 或批量包里的 `某路径.json`） */
  entryName: string
  item: RealPathBundleItem
}

/** 读**一个 zip 里的全部路径**的结果（批量导入用；坏条目只跳它自己） */
export interface ParsedZipItems {
  /** 这个包整体能不能读（读不了 ⇒ `error` 非空，`items` 为空） */
  ok: boolean
  /** 包级失败原因（人话；能读出条目时为空串） */
  error: string
  /** 读出来的路径（可能来自包内多个 JSON 文件） */
  items: ZipBundleItem[]
  /** 被跳过的条目及其原因（**必须回报**，否则"包里 3 条只进来 2 条"没人知道） */
  skipped: { entryName: string; reason: string }[]
}

/**
 * **读一个 zip 里的全部路径**（2026-11-10 用户口径：批量导出"大压缩包的内部就是相关的各个路径"，
 * 所以导入一个包可能拿到**多条**）。
 *
 * 与 `readShareBundleFromZip()` 的区别：后者只认**第一个** JSON（单条口径，保持旧行为不变），
 * 本函数遍历包内**所有** `.json` 条目，逐个 `parseShareBundle()`：
 *   · 某个条目不是路径包 / 坐标全坏 ⇒ **只跳它自己**，原因进 `skipped`；
 *   · 一个包几条路径都读不出来 ⇒ 包级 `ok:false` 并说明（这才是真的坏包）。
 */
export async function readAllShareItemsFromZip(bytes: Uint8Array): Promise<ParsedZipItems> {
  let entries: ZipReadEntry[]
  try {
    entries = await readZip(bytes)
  } catch (err) {
    return { ok: false, error: `读不了这个压缩包：${err instanceof Error ? err.message : '未知错误'}`, items: [], skipped: [] }
  }
  /** 只认 `.json`；一个都没有 ⇒ 拿第一个条目兜底试一次（好友可能把 JSON 改过名） */
  const jsonEntries = entries.filter((e) => /\.json$/i.test(e.name))
  const targets = jsonEntries.length ? jsonEntries : entries.slice(0, 1)
  if (!targets.length) return { ok: false, error: '压缩包里没有文件', items: [], skipped: [] }
  const decoder = new TextDecoder('utf-8')
  const items: ZipBundleItem[] = []
  const skipped: { entryName: string; reason: string }[] = []
  for (const entry of targets) {
    const parsed = parseShareBundle(decoder.decode(entry.data))
    if (!parsed.ok) {
      skipped.push({ entryName: entry.name, reason: parsed.error })
      continue
    }
    for (const item of parsed.items) items.push({ entryName: entry.name, item })
  }
  if (!items.length) {
    const why = skipped[0]?.reason || '包里没有可用的路径'
    return { ok: false, error: why, items: [], skipped }
  }
  return { ok: true, error: '', items, skipped }
}
