/**
 * 【1.1.2 真实链路】南航（schoolCode 98765）真实账号 / 任务 / 线路 / 提交
 *
 * ⚠️ **支持范围：目前仅支持南京航空航天大学（`schoolCode === '98765'`）**。
 *    其他学校（含会自动跳转「学校专属小程序」的学校，如江苏科技大学 10289）**不在支持范围** ——
 *    `loadRealData()` 里会直接拒绝，界面上也有明确提示。
 *
 * 安全设计（来自 2026-09-14 实测那笔"判有效"的成功经验）：
 *   1. **真实等待**：`getRunBegin` 之后**真等够报备时长**再提交，
 *      保证 `endTime - startTime` 与服务器观测到的真实间隔一致（避免"秒级完成 3.2km"的破绽）；
 *   2. **只提交一次**：写操作不重试；失败即停（按源码行为：成绩失败则轨迹不发）；
 *   3. **提交前自检**：用 `evaluateRunAgainstTask` 先把硬性项算一遍，不合格就不提交；
 *   4. **不做挑衅性实验**（不重复提交同一 `scantronId`、不故意偏离轨迹）。
 *
 * 只读/写入端点清单（除此之外不碰任何端点）：
 *   只读：`resolveSchoolBaseUrl`(getSunRunSchoolList) / `GetStudentInfoByToken` / `getSunrunPaper` /
 *         `getTermList` / `getSchoolMonthByTerm` / `getSunrunArch`
 *   写入：`getRunBegin` / `sunRunExercises` / `sunRunExercisesDetail`
 */
import { useMpRealData } from './real/data'
import { useMpRealSubmit } from './real/submit'

export type { MpRealProfile, RealPhase, RealSubmitResult } from './real/state'

/**
 * 支持范围 = **条件式**（1.1.3，2026-09-15 用户确认）：
 *   ① 与南航共享同一个 API 域（`wxxcx.xtotoro.com`）；且
 *   ② 该校未开启开场人脸 / 随机抽查 / 摄像头杆校验（运行时由门禁判定）。
 * 学校是否"判分口径已被实测验证"只作**软提示**（`schoolNotice`），不影响放行。
 */

/**
 * ⚠️ 2026-09-17（1.1.7 结构整理）：本文件是**组装器**，只做两件事：
 *   ① 调用只读侧 `useMpRealData()`（`real/data.ts`：读档案/任务/线路/开关/摄像头杆、
 *      「上次任务」缓存、选线、门禁状态与派生展示值）与写侧 `useMpRealSubmit()`（`real/submit.ts`：
 *      真实提交 / 读回判定 / 停止等待 + 提交期状态）；
 *   ② 把两侧的返回值**逐字段合并**后返回 —— **对外键集合与语义逐字不变**，页面无需改动。
 * 共享状态由 `real/state.ts` 统一声明（Nuxt 的 `useState('mpRealXxx')` 是**跨文件同一个引用**，
 * 所以拆分不需要单例/工厂）。依赖方向：本文件 → {`real/data`, `real/submit`} → `real/state`（单向）。
 */
export function useMpReal() {
  const {
    profile,
    profileMasked,
    task,
    realLines,
    status,
    error,
    loadedAt,
    switches,
    cameraFlag,
    cameraFlagError,
    selectedLine,
    gateStatus,
    schoolNotice,
    isRealApplied,
    loadRealData,
    restoreCachedTask,
    hasCachedTask,
    cachedTaskLabel,
    cacheHasToken,
    cacheTokenMask,
    clearCachedTask,
    logoutAndClearSession,
    clearAllLocalData,
    applyToRunner,
    persistSelectedLine,
    refreshCameraFlag,
    retryCameraFlag,
  } = useMpRealData()

  const { phase, phaseMessage, remainingSeconds, result, progress, submitRealRun, fetchVerdict, stopWait } =
    useMpRealSubmit()

  return {
    // 状态
    profile,
    profileMasked,
    task,
    realLines,
    status,
    error,
    loadedAt,
    switches,
    cameraFlag,
    /** 摄像头杆开关读取失败的原因（空串=正常） */
    cameraFlagError,
    selectedLine,
    /** 开跑前三合一否决门禁状态（allow / reason / blockedBy） */
    gateStatus,
    /** 未验证学校的软提示（非阻断） */
    schoolNotice,
    phase,
    phaseMessage,
    remainingSeconds,
    result,
    /** 提交过程清单（2026-09-21：六步逐条打点，界面上展示"现在在传什么"） */
    progress,
    isRealApplied,
    // 动作
    loadRealData,
    /** 显式恢复"上次读取的任务"（刷新后**不会**自动恢复） */
    restoreCachedTask,
    /** 是否存在可恢复的上次任务 */
    hasCachedTask,
    cachedTaskLabel,
    /** 缓存里是否存了 token（决定「恢复」能否重建会话）+ 其掩码（仅供显示） */
    cacheHasToken,
    cacheTokenMask,
    clearCachedTask,
    logoutAndClearSession,
    /** 一键清空本机数据（会话 + 任务 + 记录 + 缓存） */
    clearAllLocalData,
    applyToRunner,
    persistSelectedLine,
    submitRealRun,
    fetchVerdict,
    refreshCameraFlag,
    retryCameraFlag,
    stopWait,
  }
}
