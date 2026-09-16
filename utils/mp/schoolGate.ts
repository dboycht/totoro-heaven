/**
 * 学校登记表 + 开跑前三合一否决门禁（纯函数，零依赖，有单测）
 *
 * 设计目的（2026-09-15，1.1.3）：
 *   1. **支持范围 = 条件式**（2026-09-15 用户明确）：
 *        ① 与南航**共享同一个 API 域**（`wxxcx.xtotoro.com`）；且
 *        ② 该校**没有开启**开跑前的人脸/抽查/摄像头校验
 *      ⇒ 即可支持。**不再是"只支持南航"的白名单**。
 *      （登记表 `VERIFIED_SCHOOLS` 仅用于**标注"判分口径是否已被我们实测验证"**，不再作为放行条件。）
 *   2. **开跑前三合一否决门禁** —— 南航实测（2026-09-14）确认开跑前有三个**服务端强校验**项：
 *      `sunrunStartFace`（开场人脸）、`sunrunPointRandom`（随机抽查）、`camera.getCameraConfig.flag`（摄像头杆）。
 *      任一开启 ⇒ 纯网页/本地伪造轨迹**不成立**，必须在**创建场次之前**拒绝。
 *      ⚠️ 1.1.2 之前这三项**只在界面展示、没有真正拦截**，本模块补上真正的拦截。
 *
 * 门禁原则（宁可挡住，不可放行）：
 *   - 三个开关**未读取**（未知）⇒ 拒绝（不能拿"不知道"当"没开启"）；
 *   - 线路的摄像头 flag 属于**当前选中线路**，未读取该线路 ⇒ 拒绝；
 *   - 专属小程序（非共享域）⇒ 拒绝（那等于另一个后端，不在支持范围）。
 */
import type { MpRunLine } from '../../src/mp/types'

/** 共享域 host（支持范围判据①：与南航同一个 API 域） */
export const SHARED_DOMAIN_HOST = 'wxxcx.xtotoro.com'

/** 判断某个基址是否属于共享域（支持范围判据①） */
export function isSharedDomain(baseUrl: string | null | undefined): boolean {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return false
  try {
    return new URL(raw).host.toLowerCase() === SHARED_DOMAIN_HOST
  } catch {
    return raw.toLowerCase().includes(SHARED_DOMAIN_HOST)
  }
}

/** 登记表里的一所学校 */
export interface VerifiedSchool {
  /** 学校代码（= GetStudentInfoByToken 的 schoolCode） */
  schoolCode: string
  /** 学校名（展示用） */
  schoolName: string
  /** 判分口径是否已被我们**实测验证**（false = 可用但未验证；仅影响提示，不影响放行） */
  verified: boolean
  /** 验证日期（YYYY-MM-DD）；未验证为 '' */
  verifiedAt: string
  /** 该校实测到的开跑前三个开关状态（供界面展示与回归对照） */
  knownSwitches: {
    sunrunStartFace: string
    sunrunPointRandom: string
    cameraFlag: boolean
  }
  /** 备注（判分口径、任务约束等实测要点） */
  note?: string
}

/**
 * **已验证学校登记表**（唯一支持来源）。
 * ⚠️ 新增学校 = 先做「逐校取证」再在此登记，**不要只加一行就放开**：
 *    取证清单见 HANDOVER.md §7（任务约束 + 三个开关 + 是否专属小程序 + 判分口径验证）。
 */
export const VERIFIED_SCHOOLS: VerifiedSchool[] = [
  {
    schoolCode: '98765',
    schoolName: '南京航空航天大学',
    verified: true,
    verifiedAt: '2026-09-14',
    knownSwitches: { sunrunStartFace: '0', sunrunPointRandom: '0', cameraFlag: false },
    note:
      '唯一实测通过的学校：3.20km / 拟合度阈值 0.60 / 3~15 km/h / 10~25 分钟 / 06:00~23:00 / 围栏 300m；' +
      '三个开关均关闭；2026-09-14 真实提交判 scorePassType=1（有效）。',
  },
]

/** 取一所已登记学校（未登记返回 undefined） */
export function findVerifiedSchool(schoolCode: string | undefined | null): VerifiedSchool | undefined {
  const code = String(schoolCode ?? '').trim()
  if (!code) return undefined
  return VERIFIED_SCHOOLS.find((s) => s.schoolCode === code)
}

/** 该校的**判分口径**是否已被我们实测验证（仅用于提示，不再作为放行条件） */
export function isSchoolVerified(schoolCode: string | undefined | null): boolean {
  return findVerifiedSchool(schoolCode)?.verified === true
}

/**
 * 未验证学校的软披露（不阻断，只提示"判分口径未实测"；已验证或已登记返回空串）。
 * ℹ️ 支持范围本身是**条件式**的（共享域 + 无三类风控校验，见 `isSharedDomain` 与 `evaluateRunGate`），
 *    本函数只负责"这所学校的判分口径我们实测过没有"这一条**非阻断**提示。
 */
export function unverifiedSchoolNotice(schoolCode: string | undefined | null, schoolName?: string): string {
  const code = String(schoolCode ?? '').trim()
  const registered = findVerifiedSchool(code)
  if (registered?.verified) return ''
  const who = code ? `${schoolName || registered?.schoolName || '本校'}（${code}）` : '当前学校'
  const list = VERIFIED_SCHOOLS.filter((s) => s.verified)
    .map((s) => `${s.schoolName}（${s.schoolCode}）`)
    .join('、')
  return `${who} 不在我们实测验证过的名单内（已验证：${list || '（无）'}）：可以开跑，但「判分口径未经实测」，首次提交后请到「记录」页核对是否判为「有效」。`
}

/** 非共享域（专属小程序等）的统一提示语 */
export function nonSharedDomainMessage(baseUrl: string | null | undefined): string {
  const host = (() => {
    try {
      return new URL(String(baseUrl ?? '')).host
    } catch {
      return String(baseUrl ?? '未知域名')
    }
  })()
  return `该校使用独立域（${host}），不在支持范围内（只支持共享域 ${SHARED_DOMAIN_HOST}）。专属小程序等于另一套后端，本项目不支持。`
}

/** 门禁输入：三个开关的读取状态 + 当前线路 */
export interface RunGateInput {
  /** 选择的学校代码（来自学生档案） */
  schoolCode: string | null | undefined
  /** `selectSunRunStartConfiguration` 的 body（null/undefined = 未读取） */
  switches: Record<string, string> | null | undefined
  /** 当前选中线路 */
  line: MpRunLine | null | undefined
  /** 当前线路的摄像头 flag（null = 未读取；undefined 同） */
  cameraFlag: boolean | null | undefined
  /** 上面那个 flag 对应的线路 id（防止"线路已切换但 flag 还是上一条的"） */
  cameraFlagLineId?: string | null | undefined
  /** 当前时刻（**可注入**，便于测试；缺省取系统时间） */
  now?: Date
}

/** 门禁结论 */
export interface RunGateResult {
  /** true = 允许创建场次并开跑 */
  allow: boolean
  /** 拒绝原因（allow=false 时必填） */
  reason: string
  /** 命中的否决项代号（便于界面/测试断言） */
  blockedBy?: 'night' | 'switches_unknown' | 'start_face' | 'point_random' | 'camera_on' | 'camera_unknown'
}

/**
 * **夜间停用时段**（用户 2026-09-16 要求："22:30 后禁止使用，防止出现不必要的麻烦"）。
 *
 * 口径：**22:30 ~ 次日 06:00 停用**（即每天可用窗口 = 06:00~22:30）。
 *   - 为什么延伸到次日 06:00：任务本身的生效时段就是 06:00 起（`runTimeRuleList`），
 *     凌晨其实也跑不了；把整夜都算停用时段，语义更清楚，也不会出现"0 点后又偷偷能用"。
 *   - ⚠️ 只影响**开跑/提交**（门禁前置拦截），**不影响任何判定逻辑**：里程/拟合度/配速/时段自检
 *     与 `scorePassType` 的读回一律照旧（见 `taskRules.ts`，本文件不碰）。
 */
export const NIGHT_BLOCK_START_MIN = 22 * 60 + 30 // 22:30
export const NIGHT_BLOCK_END_MIN = 6 * 60 // 次日 06:00

/** 当前是否处于夜间停用时段 */
export function isNightBlocked(now: Date = new Date()): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes()
  // 跨零点：>= 22:30 或 < 06:00 都算停用
  return minutes >= NIGHT_BLOCK_START_MIN || minutes < NIGHT_BLOCK_END_MIN
}

/** 夜间停用时的提示文案（含当前时间，便于用户判断） */
export function nightBlockReason(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return (
    `现在是 ${hhmm}，处于**夜间停用时段（22:30~06:00）**：为避免不必要的麻烦，已停止开跑与提交。` +
    `请在**每天 06:00 之后**再使用（只读功能仍可用：读取账号/任务、取 token、看记录与日志）。`
  )
}

/**
 * 开跑前三合一否决门禁（**必须在 `getRunBegin` 之前调用**）。
 * 判定顺序：夜间停用 → 开关是否读到 → 开场人脸 → 随机抽查 → 摄像头杆（含"线路切了但没重查"）。
 * ℹ️ 学校**不再做白名单校验**（支持范围改条件式）；是否"已验证判分口径"只由界面软提示。
 */
export function evaluateRunGate(input: RunGateInput): RunGateResult {
  // ⓪ 夜间停用（最先判：到点就谁也别跑，避免留下深夜记录）
  const now = input.now ?? new Date()
  if (isNightBlocked(now)) {
    return { allow: false, reason: nightBlockReason(now), blockedBy: 'night' }
  }

  // ① 三个开关必须已读取（未知 ≠ 关闭）
  if (!input.switches || typeof input.switches !== 'object') {
    return {
      allow: false,
      reason: '尚未读取学校的开跑开关（人脸 / 随机抽查），请先在工作台「读取真实账号与任务」。',
      blockedBy: 'switches_unknown',
    }
  }

  // ② 开场人脸
  if (String(input.switches.sunrunStartFace ?? '') === '1') {
    return {
      allow: false,
      reason: '本任务「开场人脸校验」已开启（sunrunStartFace=1）：需要实时拍摄，网页无法完成 —— 已停止，未创建场次。',
      blockedBy: 'start_face',
    }
  }

  // ③ 随机人脸抽查
  if (String(input.switches.sunrunPointRandom ?? '') === '1') {
    return {
      allow: false,
      reason: '本任务「随机人脸抽查」已开启（sunrunPointRandom=1）：跑动中会弹脸，网页无法完成 —— 已停止，未创建场次。',
      blockedBy: 'point_random',
    }
  }

  // ④ 摄像头杆（**按线路**下发，且必须确认是"当前这条线路"的 flag）
  const lineId = String(input.line?.pointId ?? '')
  if (!lineId) {
    return { allow: false, reason: '尚未选择跑步线路。', blockedBy: 'camera_unknown' }
  }
  const flagLineId = String(input.cameraFlagLineId ?? '')
  if (input.cameraFlag === null || input.cameraFlag === undefined || flagLineId !== lineId) {
    return {
      allow: false,
      reason: '当前线路的「摄像头杆」开关尚未读取（切换线路后需重新读取）——为避免误提交，已停止。',
      blockedBy: 'camera_unknown',
    }
  }
  if (input.cameraFlag === true) {
    return {
      allow: false,
      reason: '当前线路启用了「摄像头杆过点校验（getCameraConfig.flag=true）」：需真人到杆附近拍摄，网页无法完成 —— 已停止，未创建场次。',
      blockedBy: 'camera_on',
    }
  }

  return { allow: true, reason: '' }
}
