/**
 * 「定位」的**纯逻辑**（2026-09-22 用户澄清版）
 *
 * ## 用户原话
 * > "那个非官方路径绘制指的是**定位是定位我们在的位置**"
 *
 * 所以「定位」的**主行为**是**浏览器定位**（`navigator.geolocation.getCurrentPosition`）：
 * 把地图移到"这台设备当前所在的位置"，让用户就近画路径。
 * 之前那套"逐级兜底到 草稿 / 官方路线 / 本机已保存的几何"**降级**为**失败后的退路**，
 * 不再是主行为（见 `locateFallbackNotice()` 的措辞：必须**如实说明**"浏览器定位不可用 + 为什么 + 退到了哪一级"）。
 *
 * ## 为什么把这一层抽成纯函数
 *   · 失败原因 → 人话 + 该退到哪一级，是**可枚举的判据**，不该散在界面里写成一串 `if`；
 *     离线单测能钉住"每个错误码都有话可说、且都不许出现 markdown 标记"这类不变式；
 *   · 界面只做两件事：调浏览器 API、把这里返回的文本原样显示。
 *
 * ## 隐私红线（与需求一致）
 *   坐标**只在内存里**用于地图居中；本模块不写盘、不发网络、不返回任何"要落库"的东西。
 */
import type { LatLng } from './routeSimilarity'

/** 浏览器定位失败的种类（**唯一判据来源**：界面按它取文案，不再自己判断） */
export type GeoFailureKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'insecure' | 'unknown'

/** 一次失败的**如实说明**：`reason` = 发生了什么；`hint` = 下一步怎么办 */
export interface GeoFailure {
  kind: GeoFailureKind
  reason: string
  hint: string
}

/**
 * `GeolocationPositionError.code` 的三个标准值。
 * ⚠️ 写成普通常量而不是引用 DOM 类型：本模块要能在**离线单测**（Node，无 DOM）里跑。
 */
export const GEO_PERMISSION_DENIED = 1
export const GEO_POSITION_UNAVAILABLE = 2
export const GEO_TIMEOUT = 3

/**
 * **错误码 → 人话**（纯函数，唯一出口）。
 *
 * 判据（可执行）：
 *   · `supported === false`（浏览器没有 `navigator.geolocation`）⇒ `unsupported`；
 *   · `secure === false`（不是安全上下文）⇒ `insecure` —— 浏览器只在 `https://` 或
 *     `localhost` / `127.0.0.1` 下允许定位，换到普通域名会被直接禁掉（**这条必须说清楚**，
 *     否则用户只会看到"定位失败"四个字，不知道是自己换了地址）；
 *   · 其余按标准错误码 1/2/3 分情形；不认识的码也**如实报出码值**，不猜。
 */
export function geolocationFailure(rawCode: unknown, opts: { supported?: boolean; secure?: boolean } = {}): GeoFailure {
  if (opts.supported === false) {
    return {
      kind: 'unsupported',
      reason: '这个浏览器没有提供定位能力（navigator.geolocation 不存在）',
      hint: '换 Chrome / Edge 这类现代浏览器再试；本页的绘制与保存不受影响',
    }
  }
  if (opts.secure === false) {
    return {
      kind: 'insecure',
      reason: '当前页面不是安全上下文（浏览器只在 https 或 localhost / 127.0.0.1 下允许定位）',
      hint: '用本程序自带的 localhost 地址打开（或改用 https）；本页的绘制与保存不受影响',
    }
  }
  const code = Number(rawCode)
  if (code === GEO_PERMISSION_DENIED) {
    return {
      kind: 'denied',
      reason: '你拒绝了定位授权（或浏览器里把本站点的位置权限设成了禁止）',
      hint: '想用定位就在地址栏左侧的权限里打开「位置」再点一次；不开也能用，见下面的降级说明',
    }
  }
  if (code === GEO_POSITION_UNAVAILABLE) {
    return {
      kind: 'unavailable',
      reason: '浏览器拿不到位置（系统的定位服务关着，或这台设备没有可用的定位来源）',
      hint: '检查系统的定位服务是否打开，然后重新点一次',
    }
  }
  if (code === GEO_TIMEOUT) {
    return {
      kind: 'timeout',
      reason: '定位超时（10 秒内没拿到位置，室内或信号差时常见）',
      hint: '走到窗边或室外再点一次',
    }
  }
  return {
    kind: 'unknown',
    reason: `定位失败（浏览器给的错误码：${rawCode === undefined || rawCode === null ? '未知' : String(rawCode)}）`,
    hint: '过一会儿再点一次',
  }
}

/** 可降级的定位目标（**按优先级排列**，界面按顺序挑第一个可用的） */
export type LocateFallbackLevel = 'draft' | 'official' | 'library'

export interface LocateFallbackCandidate {
  level: LocateFallbackLevel
  /** 如实说明"这一级是什么"（会原样显示给用户） */
  label: string
  pts: LatLng[]
}

/** 挑中的那一个（与候选同形，方便调用方直接用） */
export interface LocateFallbackChoice {
  level: LocateFallbackLevel
  label: string
  pts: LatLng[]
}

/** 一组点能不能当定位目标：**至少 2 点、且坐标都是有限数**（不然居中了也是乱跳） */
const usablePoints = (pts: unknown): boolean => {
  if (!Array.isArray(pts) || pts.length < 2) return false
  return pts.every((p) => {
    const v = p as LatLng | undefined
    return Number.isFinite(Number(v?.latitude)) && Number.isFinite(Number(v?.longitude))
  })
}

/**
 * **降级链的选择**（纯函数）：按数组顺序取第一个可用（≥2 个有限坐标）的候选。
 * 顺序由调用方决定（本页是：你正在画的路径 → 本任务下发的官方路线 → 本机路线库里已保存的几何）；
 * 都不满足 ⇒ `null`（界面据此说明"现在没有可降级的几何"，而不是闷着不动）。
 */
export function pickLocateFallback(candidates: readonly LocateFallbackCandidate[]): LocateFallbackChoice | null {
  for (const c of candidates ?? []) {
    if (!c || typeof c.label !== 'string') continue
    if (!usablePoints(c.pts)) continue
    return { level: c.level, label: c.label, pts: c.pts }
  }
  return null
}

/**
 * **降级时要说给用户的那一句话**（纯函数，唯一出口）：必须同时说清"为什么"与"退到了哪一级"。
 * 没有可降级的几何时也要**明说**（并给出下一步），不许静默不动。
 */
export function locateFallbackNotice(failure: GeoFailure, choice: { label: string } | null): string {
  const why = `浏览器定位不可用（${failure.reason}）`
  if (!choice) {
    return `${why}，而且现在还没有任何可定位的几何可降级：请先在地图上画出这条非官方路径。${failure.hint}`
  }
  return `${why}。已改为定位到${choice.label}。${failure.hint}`
}

/**
 * **定位成功的那一刻要说的话**：如实带上浏览器给的**精度**（米）。
 * 浏览器没给精度（或给了 0）时如实说"没给"，不编一个数字出来。
 */
export function geoLocatedText(accuracyM: unknown): string {
  const a = Number(accuracyM)
  if (!Number.isFinite(a) || a <= 0) return '已定位到你当前位置（浏览器这次没有给出精度）'
  return `已定位到你当前位置（精度 ±${Math.round(a)} m）`
}
