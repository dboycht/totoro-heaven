/**
 * 真实提交的**过程文案**（纯函数 + 可离线单测）—— 2026-09-21 用户要求"要能看到现在在传什么"
 *
 * 背景：原先界面上只有一句粗粒度提示（"正在提交成绩…"），用户看不到**分几步、每步在传什么**，
 * 于是 issue #11 那种"到底哪一步没交上去"只能靠翻日志才说得清。
 * 现在按**真实流程的六步**逐条打点，每步都写清"正在传什么/传了多少/结果如何"：
 *   ① 前置检查（门禁：夜间 / 风控 / 线路 / 摄像头杆）
 *   ② 创建场次 getRunBegin（写）
 *   ③ 真实等待（让 endTime-startTime 与服务端观测一致）
 *   ④ 上传成绩 sunRunExercises（写）：里程/用时/拟合度 + 线路标识 + **线路点列**
 *   ⑤ 上传轨迹明细 sunRunExercisesDetail（写）：**跑出来的 GPS 点列**
 *   ⑥ 读回判定 getSunrunArch（只读）
 *
 * ⚠️ 超时分支（issue #11 的修复）在这份文案里必须**看得见**：超时 ≠ 失败，
 * 要显式打出"超时（结果未知）→ 正在核实 → 已核实入库/无法确认"，别让用户以为就是失败了。
 */
export type SubmitProgressKind = 'step' | 'ok' | 'warn' | 'error'

export interface SubmitProgressLine {
  /** 打点时间（毫秒时间戳；界面自己格式化） */
  at: number
  kind: SubmitProgressKind
  text: string
}

export const submitProgressLine = (
  kind: SubmitProgressKind,
  text: string,
  at: number = Date.now(),
): SubmitProgressLine => ({ at, kind, text })

/** 秒数 → "x.x 秒"（用于"服务端用时"这类展示） */
export const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)} 秒`

/** 计划等待时长 → "N 分 M 秒" */
export const formatDuration = (totalSeconds: number): string => {
  const s = Math.max(0, Math.round(totalSeconds))
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`
}

export const SUBMIT_PROGRESS = {
  /** ① 前置检查 */
  gate: () => '① 前置检查：门禁（夜间停用 / 风控开关 / 线路 / 摄像头杆）…',
  gateBlocked: (reason: string) => `① 前置检查未通过，未创建场次：${reason}`,
  gatePassed: () => '① 前置检查通过',

  /** ② 创建场次（写） */
  begin: (lineName: string, runTypeText: string) =>
    `② 创建场次（getRunBegin，写）：${runTypeText}${lineName ? ` · 线路「${lineName}」` : ''}…`,
  beginOk: (scantronId: string) => `② 场次已创建：${scantronId}`,
  beginFail: (message: string) => `② 创建场次失败：${message}`,

  /** ③ 真实等待 */
  wait: (plannedSeconds: number, km: number) =>
    `③ 真实等待 ${formatDuration(plannedSeconds)}（${km.toFixed(2)} km）：让服务端看到的时间线与真实一致…`,
  waitDone: () => '③ 等待结束，开始上报',

  /** ④ 上传成绩（写） */
  score: (km: number, linePoints: number, usedTimeText: string) =>
    `④ 上传成绩（sunRunExercises，写）：${km.toFixed(2)} km · 用时 ${usedTimeText} · 拟合度 + 线路标识 + 线路点列（${linePoints} 点）…`,
  scoreOk: (ms: number) => `④ 成绩已上传：服务端回「提交成功」（用时 ${formatSeconds(ms)}）`,
  scoreTimeout: (ms: number) =>
    `④ 成绩上传超时（等了 ${formatSeconds(ms)}）：结果未知 —— 正在向服务端核实是否已入库…`,
  scoreVerified: () => '④ 已核实：服务端确认这条成绩已入库 → 按成功继续（继续上传轨迹）',
  scoreUnknown: () => '④ 无法确认是否入库：请勿立即重复提交（可能多录一条成绩），稍后可点「查询判定」',
  scoreFail: (message: string) => `④ 成绩上传失败：${message}`,

  /** ⑤ 上传轨迹明细（写） */
  detail: (points: number) => `⑤ 上传轨迹明细（sunRunExercisesDetail，写）：跑出来的 GPS 点列（${points} 点 + 时间戳）…`,
  detailOk: (ms: number) => `⑤ 轨迹已上传：服务端回「提交成功」（用时 ${formatSeconds(ms)}）`,
  detailFail: (message: string) => `⑤ 轨迹上传失败：${message}`,
  detailSkipped: (reason: string) => `⑤ 轨迹未上传：${reason}`,

  /** ⑥ 读回判定（只读） */
  verdict: () => '⑥ 读回判定（getSunrunArch，只读）…',
  verdictOk: (text: string) => `⑥ 判定已读回：${text}`,
  verdictNone: () => '⑥ 归档里暂时还没找到这条（服务端可能仍在处理，稍后再点「查询判定」）',
} as const
