/**
 * 学校登记表 + 开跑前三合一否决门禁（纯函数，零依赖，有单测）
 *
 * 设计目的（2026-09-15，1.1.3）：
 *   1. **支持范围从「写死南航」升级为「已验证学校登记表」** —— 每支持一所学校 = 登记一行，
 *      登记前必须按「逐校取证清单」实测过该校的任务约束与三个开关（见 HANDOVER §7）。
 *   2. **开跑前三合一否决门禁** —— 南航实测（2026-09-14）确认开跑前有三个**服务端强校验**项：
 *      `sunrunStartFace`（开场人脸）、`sunrunPointRandom`（随机抽查）、`camera.getCameraConfig.flag`（摄像头杆）。
 *      任一开启 ⇒ 纯网页/本地伪造轨迹**不成立**，必须在**创建场次之前**拒绝，而不是"提交了才发现无效"。
 *      ⚠️ 1.1.2 之前这三项**只在界面展示、没有真正拦截**，本模块补上真正的拦截。
 *
 * 门禁原则（宁可挡住，不可放行）：
 *   - 三个开关**未读取**（未知）⇒ 拒绝（不能拿"不知道"当"没开启"）；
 *   - 线路的摄像头 flag 属于**当前选中线路**，未读取该线路 ⇒ 拒绝；
 *   - 学校不在登记表 ⇒ 拒绝（该校判分口径未验证，提交可能被判无效）。
 */
import type { MpRunLine } from '../../src/mp/types'

/** 登记表里的一所学校 */
export interface VerifiedSchool {
  /** 学校代码（= GetStudentInfoByToken 的 schoolCode） */
  schoolCode: string
  /** 学校名（展示用） */
  schoolName: string
  /** 是否已通过实测验证（false = 仅登记待验证，仍拒绝开跑） */
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

/** 该校当前是否允许开跑（已登记 + 已实测验证） */
export function isSchoolSupported(schoolCode: string | undefined | null): boolean {
  return findVerifiedSchool(schoolCode)?.verified === true
}

/** 未登记/未验证时的统一提示语（界面与提交前共用，避免文案漂移） */
export function unsupportedSchoolMessage(schoolCode: string | undefined | null, schoolName?: string): string {
  const code = String(schoolCode ?? '').trim()
  const registered = findVerifiedSchool(code)
  const who = code ? `${schoolName || registered?.schoolName || '该校'}（${code}）` : '当前账号'
  if (registered && !registered.verified) {
    return `${who} 已登记但尚未完成实测验证，暂不支持开跑（先按「逐校取证清单」验证该校判分口径）。`
  }
  const list = VERIFIED_SCHOOLS.filter((s) => s.verified)
    .map((s) => `${s.schoolName}（${s.schoolCode}）`)
    .join('、')
  return `${who} 不在已验证学校名单内，暂不支持开跑。当前已验证：${list || '（无）'}。`
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
}

/** 门禁结论 */
export interface RunGateResult {
  /** true = 允许创建场次并开跑 */
  allow: boolean
  /** 拒绝原因（allow=false 时必填） */
  reason: string
  /** 命中的否决项代号（便于界面/测试断言） */
  blockedBy?: 'school_unverified' | 'switches_unknown' | 'start_face' | 'point_random' | 'camera_on' | 'camera_unknown'
}

/**
 * 开跑前三合一否决门禁（**必须在 `getRunBegin` 之前调用**）。
 * 判定顺序：学校登记 → 开关是否读到 → 开场人脸 → 随机抽查 → 摄像头杆（含"线路切了但没重查"）。
 */
export function evaluateRunGate(input: RunGateInput): RunGateResult {
  // ① 学校必须在已验证登记表内
  if (!isSchoolSupported(input.schoolCode)) {
    return { allow: false, reason: unsupportedSchoolMessage(input.schoolCode), blockedBy: 'school_unverified' }
  }

  // ② 三个开关必须已读取（未知 ≠ 关闭）
  if (!input.switches || typeof input.switches !== 'object') {
    return {
      allow: false,
      reason: '尚未读取学校的开跑开关（人脸 / 随机抽查），请先在工作台「读取真实账号与任务」。',
      blockedBy: 'switches_unknown',
    }
  }

  // ③ 开场人脸
  if (String(input.switches.sunrunStartFace ?? '') === '1') {
    return {
      allow: false,
      reason: '本任务「开场人脸校验」已开启（sunrunStartFace=1）：需要实时拍摄，网页无法完成 —— 已停止，未创建场次。',
      blockedBy: 'start_face',
    }
  }

  // ④ 随机人脸抽查
  if (String(input.switches.sunrunPointRandom ?? '') === '1') {
    return {
      allow: false,
      reason: '本任务「随机人脸抽查」已开启（sunrunPointRandom=1）：跑动中会弹脸，网页无法完成 —— 已停止，未创建场次。',
      blockedBy: 'point_random',
    }
  }

  // ⑤ 摄像头杆（**按线路**下发，且必须确认是"当前这条线路"的 flag）
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
