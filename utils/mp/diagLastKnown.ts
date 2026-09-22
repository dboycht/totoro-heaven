/**
 * 「**最近一次成功读取时的状态**」—— 2026-09-22 新增（用户原话：
 * "你刚刚说刷新后就丢了，我们直接丢之前记录下来不行吗"）
 *
 * ## 为什么要有它
 * 真实用户（研究生院）的现场：**17:10:56 读到过**"开场人脸关 / 随机抽查关 / 摄像头杆未启用"，
 * 但 **18:40 导出诊断包时实时状态已经是空的**（刷新过 / 重开过页面 ⇒ `useState` 内存态全丢），
 * 于是包里只剩"开关未知"，**他"读取后又跑不了"这件事没有证据**。
 * 用户的要求很直接：**丢之前把它记下来**。
 *
 * ## 它是什么 / 不是什么（🔴 边界，改这个文件前先读这一段）
 * - **是**：诊断证据 —— "我们在 T 时刻读到过什么"。写进 `localStorage`，再由诊断快照带走。
 * - **不是**：当前状态。`evaluateRunGate()` / `submitRealRun()` **一律只认实时状态**，
 *   本模块的产物**绝不参与任何放行判断**（门禁读的是 `useState` 里的 `switches`/`cameraFlag`，
 *   不是这里的 `localStorage`）。有单测直接把这条钉死：
 *   "lastKnown 说开关全关、但实时未知 ⇒ 门禁仍然 `switches_unknown` 拦下"。
 * - 为什么必须这么严：开关是**可以随时变**的（学校改配置 / 换线路）——用旧值放行 = 用昨天的事实做今天的决定。
 *
 * ## 脱敏（与诊断包同一口径）
 * 学号/姓名走 `maskId` / `maskName`；**token 只留布尔 + 指纹**（长度 + sha256 前 12 位，不可反推）；
 * 开关原值照记（`sunrunStartFace` / `sunrunPointRandom` / `sunrunPointShowOff` 是"是不是 1"的判定依据，
 * 本身就是关键证据，不是隐私）。
 */
import { maskId, maskName, maskPhone } from './diagnostics'
import type { DiagLastKnown } from './diagnostics'
import { evaluateRunGate } from './schoolGate'
import { taskShapeLine } from './taskShape'

/** localStorage 键名（诊断证据专用；清理本机数据时一并清） */
export const LAST_KNOWN_KEY = 'mp_diag_last_known_v1'

/** `captureLastKnown()` 的输入：**从实时状态里现取**（调用方负责把当前值传进来） */
export interface LastKnownInput {
  /** 就读到的任务（可能为 null） */
  task: Record<string, unknown> | null
  /** 会话/身份（卡片与 data.ts 都能拿到的那几项） */
  schoolCode?: string
  schoolName?: string
  campusId?: string
  campusName?: string
  snCode?: string
  studentName?: string
  phone?: string
  /** 是否持有 token（**只记布尔**；指纹可选——服务端指纹函数在 `server/utils`，前端 composable 引不到） */
  hasToken: boolean
  /** 可选的 token 指纹（**永不**是 token 本体）。不传就只记布尔 —— 少一个字段好过引一条不该有的依赖 */
  tokenFingerprint?: string
  /** 开跑开关的**原值**（可能为 null = 没读到） */
  switches: Record<string, string> | null
  /** 摄像头杆 flag（true/false/null=未知） */
  cameraFlag: boolean | null
  /** 摄像头杆 flag 对应的线路 id */
  cameraFlagLineId: string
  cameraFlagError?: string
  /** 当前选中的线路 id（用于算"当时的门禁终值"） */
  lineId?: string
  /** 服务端是否未下发线路（自由路线任务） */
  lineRequired?: boolean
  /** 当前是否演示模式（演示态的东西**不该**被当成本机真实读取的证据） */
  demoMode?: boolean
  /** 采集时刻（默认 now；单测传固定值） */
  now?: Date
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 造一份"最近已知状态"（纯函数）。
 *
 * @returns `null` = **没有任何可记的东西**（没任务、也没读到开关）——
 *   宁可不写，也不要在 `localStorage` 里留一份"全是空"的假证据。
 */
export function buildLastKnown(input: LastKnownInput): DiagLastKnown | null {
  const now = input.now ?? new Date()
  const task = isObj(input.task) ? input.task : null
  const lines = task && Array.isArray(task.runPointList) ? task.runPointList : []
  const hasAnyEvidence = Boolean(task) || Boolean(input.switches) || input.cameraFlag !== null
  if (!hasAnyEvidence) return null
  /**
   * 当时的门禁终值 —— 用**与真实提交完全同一个** `evaluateRunGate()`（不另写一套判据）。
   * ⚠️ 门禁只用到 `line.pointId`；这里按 `MpRunLine` 的最小合法形状构造（`pointName`/`pointList` 补默认值），
   * 免得为了"记个证据"去动 `schoolGate` 的判据（那才是真危险）。
   */
  const gate = evaluateRunGate({
    // 证据里已经有 schoolCode（真实调用方一定会传）
    schoolCode: String(input.schoolCode ?? ''),
    switches: input.switches,
    cameraFlag: input.cameraFlag,
    cameraFlagLineId: input.cameraFlagLineId,
    line: input.lineId ? { pointId: input.lineId, pointName: '', pointList: [] } : null,
    runType: 0,
    ...(input.lineRequired === false ? { lineRequired: false } : {}),
    now,
  })
  return {
    at: now.toISOString(),
    atMs: now.getTime(),
    status: input.demoMode ? 'demo' : task ? 'ready' : 'partial',
    school: {
      schoolCode: String(input.schoolCode ?? ''),
      schoolName: String(input.schoolName ?? ''),
      campusId: String(input.campusId ?? ''),
      campusName: String(input.campusName ?? ''),
    },
    student: {
      // 🔴 与诊断包同一口径：学号/姓名/手机只以掩码形式落盘
      snCode: maskId(input.snCode ?? ''),
      studentName: maskName(input.studentName ?? ''),
      phone: maskPhone(input.phone ?? ''),
    },
    auth: { hasToken: Boolean(input.hasToken), tokenFingerprint: String(input.tokenFingerprint ?? '') },    task: {
      present: Boolean(task),
      paperName: task ? String(task.paperName ?? '') : '',
      paperId: task ? String(task.taskId ?? task.paperId ?? '') : '',
      runPointListCount: lines.length,
      shapeLine: task ? taskShapeLine(task) : '',
    },
    switches: input.switches ?? null,
    cameraFlag: input.cameraFlag,
    cameraFlagLineId: String(input.cameraFlagLineId ?? ''),
    cameraFlagError: String(input.cameraFlagError ?? ''),
    gateAllow: gate.allow,
    gateBlockedBy: gate.blockedBy ?? '',
    gateReason: gate.reason,
  }
}

/** 写进 `localStorage`（**只存诊断证据**；写失败只返回 false，绝不影响业务） */
export function saveLastKnown(state: DiagLastKnown, storage?: Pick<Storage, 'setItem'>): boolean {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!target) return false
  try {
    target.setItem(LAST_KNOWN_KEY, JSON.stringify(state))
    return true
  } catch {
    // 配额/隐私模式：诊断证据写不进去不该影响任何业务（如实返回 false 让调用方决定要不要记日志）
    return false
  }
}

/** 读回来（不存在/损坏/形状不对 ⇒ null；**绝不抛错**） */
export function readLastKnown(storage?: Pick<Storage, 'getItem'>): DiagLastKnown | null {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!target) return null
  try {
    const raw = target.getItem(LAST_KNOWN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isObj(parsed) || typeof parsed.at !== 'string' || typeof parsed.atMs !== 'number') return null
    return parsed as unknown as DiagLastKnown
  } catch {
    // 坏数据一律当"没有"（诊断证据可以是空的，但不能把页面搞崩）
    return null
  }
}

/** 清掉（「清空本机数据」时一并清；键名单一来源） */
export function clearLastKnown(storage?: Pick<Storage, 'removeItem'>): void {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!target) return
  try {
    target.removeItem(LAST_KNOWN_KEY)
  } catch {
    /* 清不掉也不影响（下次写入会覆盖） */
  }
}

/**
 * 供界面/manifest 用的**一句话摘要**（如实写明"这是历史值、不用于放行"）。
 *
 * 形如：`最近一次读到开关是 2026-09-22 17:10:56：均无阻碍（此值不用于放行，需重新读取）`
 */
export function lastKnownSummary(state: DiagLastKnown | null | undefined): string {
  if (!state || !state.atMs) return ''
  const d = new Date(state.atMs)
  const p = (n: number) => String(n).padStart(2, '0')
  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const sw = state.switches
  const swText = !sw
    ? '开关未读到'
    : `开场人脸=${String(sw.sunrunStartFace ?? '(无)')}、随机抽查=${String(sw.sunrunPointRandom ?? '(无)')}、摄像头杆=${state.cameraFlag === null ? '未读到' : state.cameraFlag ? '已启用' : '未启用'}`
  const verdict = state.gateAllow ? '当时判定：均无阻碍' : `当时判定：被拦住（${state.gateBlockedBy || '原因见 gateReason'}）`
  return `最近一次读到开关是 ${when}：${swText}；${verdict}（此值不用于放行，需重新读取）`
}
