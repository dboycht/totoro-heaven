/**
 * 真实提交报文构造（纯函数，零依赖，有单测）
 *
 * 字段口径全部来自 **2026-09-14 实测**（`_mp-analyze/9-14-实测日志.md`）：
 *   - `sunRunExercises` 18 字段逐字对齐（含 `steps:""` 实测空串、`flag:"1"`、token 在 body 再传一份）
 *   - `sunRunExercisesDetail`：**只有 3 个字段** `pointList + scantronId + token`（2026-09-16 修正；
 *     点必须带 `time:"HH:mm:ss"`，否则服务端判「GPS位置为空！」整条拒收）
 *   - `getRunBegin`：`paperId = line.taskId`、`lineId = line.pointId`、**不带 token**（源码实测）
 *     （🆕 2026-09-22：服务端未下发线路的任务改用**任务号兜底** `paperId = task.taskId`、`lineId = ''`，
 *      见 `buildRunBeginRequest` 的说明）
 *
 * ⚠️ 这些函数只负责"拼报文"；实际请求、等待与判定在 `composables/useMpReal.ts`。
 */
import type { MpRunLine, MpScoreDetailRequest, MpScoreRequest, MpSunrunTask } from '../../src/mp/types'
import { buildRunStats, buildTimeFields, withPointTimes } from './runData'

/** 微信基础库版本（实测真包同款） */
export const MP_CLIENT_VERSION = '4.1.12.55'
/** getRunBegin 的 phoneInfo：照源码 brand&model&system 三段式（实测真包同款） */
export const MP_PHONE_INFO_BEGIN = 'microsoft&microsoft&Windows 11 x64'
/** sunRunExercises 的 phoneInfo：照实测真包（源码 `||` 优先级 bug → 纯品牌串） */
export const MP_PHONE_INFO_SCORE = 'microsoft'

export interface RealSubmitContext {
  /** 学生档案（snCode / schoolCode） */
  snCode: string
  schoolCode: string
  /** 当前任务（约束）；自由跑没有任务 ⇒ 可为空 */
  task: MpSunrunTask | null
  /**
   * 选中线路（其 pointId 即 lineId、taskId 即 paperId）。
   * ⚠️ **自由跑为 `null`**（厂商源码：只有阳光跑才取线路；自由跑 paperId/lineId 都是空串）。
   * ⚠️ **服务端未下发线路的任务**（`routeRequirementOf(task).kind === 'free'`）也为 `null` ——
   *    此时任务号由下面的 `paperId` 兜底（见 `buildScoreRequest` 的 taskId 分支）。
   */
  line: MpRunLine | null
  /**
   * 🆕 2026-09-22（issue #12）：**任务号兜底** —— 只有"没有线路可取自"时才被使用。
   *
   * 依据：`MpRunLine.taskId` 的注释写明"提交 getRunBegin 的 paperId / sunRunExercises 的 taskId；
   * **实测 9-14 同值**" ⇒ 线路的 taskId 与任务自身的 `taskId` 就是同一个值，
   * 所以没有线路时用任务的 `taskId` 不是"发明新值"，而是取同一事实的另一个来源。
   * ⚠️ 有线路时**以线路为准**（`line.taskId` 优先），本字段被忽略 ⇒ 老路径逐字不变。
   */
  paperId?: string
  /** 实际里程（公里） */
  km: number
  /** 实际时长（秒） */
  durationSeconds: number
  /** 自算拟合度（0~1，服务端判定阈值来自 task.fitDegree） */
  fitDegree: number
  /** 轨迹点（提交与轨迹明细都用它） */
  points: { latitude: number; longitude: number }[]
  /** 会话 token（header 与 body 各一份） */
  token: string
  /** getRunBegin 返回的会话 id */
  scantronId: string
  /** 跑步开始时刻（真实时钟） */
  startMs: number
  /** 跑步结束时刻（真实时钟） */
  endMs: number
}

/**
 * getRunBegin 报文（注意：**不带 token**，照源码）。
 *
 * ⚠️ **自由跑口径**（2026-09-18 从厂商反编译源码读出的权威依据，`_mp-analyze/extracted/app-service.js`）：
 * ```js
 * 2==a.data.runType && (i=1),                        // 2(自由跑) → 提交 runType=1
 * 0==a.data.runType && (o=a.data.columnsLine[...]),  // 只有 0(阳光跑) 才取线路
 * r={runType:i, ..., paperId:o.taskId||"", lineId:o.pointId||""}
 * ```
 * 即：**自由跑传 `runType:1`，且 `paperId`/`lineId` 都是空串**（不去取线路）。
 * 传 `line` 时按阳光跑口径取该线路的 taskId/pointId；**`line` 可为空**（自由跑）。
 *
 * 🆕 2026-09-22（issue #12）：**服务端未下发线路的任务**（`routeRequirementOf(task).kind === 'free'`）下
 * 我们没有线路可取，但"总得有个任务号"—— 用 `paperId`（任务自身的 `taskId`）兜底，`lineId` 为空串。
 * 依据：`MpRunLine.taskId` 与任务 `taskId` **实测同值**（见 `src/mp/models.ts` 的字段注释）。
 * ⚠️ **有线路时以线路为准**（`line.taskId` 优先，哪怕它是空串）⇒ `kind === 'line'` 的老路径逐字不变。
 */
export function buildRunBeginRequest(context: {
  line?: MpRunLine | null
  /** 任务号兜底（**只在没有线路时生效**；有线路时忽略 —— 见上面说明） */
  paperId?: string
  /** 0 = 阳光跑 / 1 = 自由跑（源码：`2 == runType ? 1 : 0`，即 0/1 原样透传） */
  runType: 0 | 1
}): { runType: number; version: string; phoneInfo: string; paperId: string; lineId: string; faceBase64: string } {
  const freeRun = context.runType === 1
  return {
    runType: context.runType,
    version: MP_CLIENT_VERSION,
    phoneInfo: MP_PHONE_INFO_BEGIN,
    // 有线路 ⇒ 取线路的 taskId（逐字同旧行为）；没有线路 ⇒ 任务号兜底（无则空串）
    paperId: freeRun ? '' : (context.line ? String(context.line.taskId ?? '') : String(context.paperId ?? '')),
    lineId: freeRun ? '' : (context.line?.pointId ?? ''),
    faceBase64: '', // ✅ 已建档 → 留空即可放行（9-11 对照实验 + 9-14 实测双重确认）
  }
}

/** 报文的 runType 口径：`0` = 阳光跑（默认） / `1` = 自由跑（源码 `2 -> 1`，见 `toSubmitRunType`） */
export interface ScorePayloadOptions {
  runType?: 0 | 1
}

/**
 * sunRunExercises 报文（18 字段，逐字对齐实测真包）。
 *
 * ⚠️ **单一构造出口**（2026-09-17 健壮化 B 轮统一）：演示页的「报文预览」与真实提交**都必须走这里**。
 *    此前 `composables/useMpDemo.ts` 手抄了一份 18 字段，导致预览可能和实发漂移
 *    （E33 就是"预览与实发不一致"这一类；`scripts/check-wiring.mjs` 现已把它变成硬断言）。
 *
 * **自由跑口径**（真包源码：`sunrunPathPointList: (o?.pointList) || []`，自由跑时 `o` 为空）：
 *   `runType = 1`、**不带任务号**（`taskId: ''`）、**路径点列为空数组**。
 */
export function buildScoreRequest(context: RealSubmitContext, options: ScorePayloadOptions = {}): MpScoreRequest {
  const runType = options.runType ?? 0
  const stats = buildRunStats({
    distanceKm: context.km,
    durationSeconds: context.durationSeconds,
    runType,
  })
  const time = buildTimeFields(context.startMs, context.endMs)
  const freeRun = runType === 1
  return {
    scantronId: context.scantronId,
    stuNumber: context.snCode,
    schoolCode: context.schoolCode,
    runType,
    km: stats.km,
    usedTime: stats.usedTime,
    fitDegree: Number(context.fitDegree).toFixed(2),
    avgSpeed: stats.avgSpeed,
    steps: '', // 实测真包恒为空串（源码全工程无赋值）
    token: context.token, // 请求体里再传一份（实测确认）
    version: MP_CLIENT_VERSION,
    phoneInfo: MP_PHONE_INFO_SCORE,
    evaluateDate: time.evaluateDate,
    endTime: time.endTime,
    startTime: time.startTime,
    taskId: freeRun ? '' : (context.line ? String(context.line.taskId ?? '') : String(context.paperId ?? '')),
    // ⚠️ 服务端未下发线路的任务 ⇒ 我们**没有官方点列**可带（本机跑道几何不是服务端线路）
    //    ⇒ 如实传空数组（不拿本机坐标冒充服务端线路，见 `_mp-analyze` 的报文纪律）。
    sunrunPathPointList: freeRun ? [] : (context.line?.pointList ?? []),
    flag: '1',
  }
}

/** sunRunExercisesDetail 报文（轨迹明细；顺序上必须在成绩成功之后）
 *
 * ⚠️ 2026-09-16 修正（用户真跑对比后查实）：小程序**只发 3 个字段**
 *   `{ pointList: polyline[0].points, scantronId, token }`（v65/v67 逐字一致）；
 *   且每个点形如 `{ latitude, longitude, time: "HH:mm:ss" }`。
 *   我们此前多发 `gyroscope/accelerometer/cheatCode`（来自第三方实现，小程序并没有），
 *   且**点里漏了 `time`** → 服务端回 `code:"1", message:"GPS位置为空！"` 整条拒收 →
 *   云端 `pointList = null` → 详情页地图没有轨迹（见 `_mp-analyze/capture/submit-result.json` 与 ERROR.md E33）。
 */
export function buildScoreDetailRequest(context: RealSubmitContext): MpScoreDetailRequest {
  return {
    pointList: withPointTimes(context.points, context.startMs, context.durationSeconds),
    scantronId: context.scantronId,
    token: context.token,
  }
}

/** 轨迹点转成 6 位小数（接口习惯；由生成器输出转换） */
export function toSubmitPoints(points: { latitude: string | number; longitude: string | number }[]): { latitude: number; longitude: number }[] {
  return points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
}
