/**
 * 真实提交报文构造（纯函数，零依赖，有单测）
 *
 * 字段口径全部来自 **2026-09-14 实测**（`_mp-analyze/9-14-实测日志.md`）：
 *   - `sunRunExercises` 18 字段逐字对齐（含 `steps:""` 实测空串、`flag:"1"`、token 在 body 再传一份）
 *   - `sunRunExercisesDetail`：**只有 3 个字段** `pointList + scantronId + token`（2026-09-16 修正；
 *     点必须带 `time:"HH:mm:ss"`，否则服务端判「GPS位置为空！」整条拒收）
 *   - `getRunBegin`：`paperId = line.taskId`、`lineId = line.pointId`、**不带 token**（源码实测）
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
  /** 当前任务（约束） */
  task: MpSunrunTask
  /** 选中线路（其 pointId 即 lineId、taskId 即 paperId） */
  line: MpRunLine
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

/** getRunBegin 报文（注意：**不带 token**，照源码） */
export function buildRunBeginRequest(context: {
  line: MpRunLine
  /** 0 = 阳光跑 / 1 = 自由跑（源码：`2 == runType ? 1 : 0`，即 0/1 原样透传） */
  runType: 0 | 1
}): { runType: number; version: string; phoneInfo: string; paperId: string; lineId: string; faceBase64: string } {
  return {
    runType: context.runType,
    version: MP_CLIENT_VERSION,
    phoneInfo: MP_PHONE_INFO_BEGIN,
    paperId: context.line.taskId ?? '',
    lineId: context.line.pointId ?? '',
    faceBase64: '', // ✅ 已建档 → 留空即可放行（9-11 对照实验 + 9-14 实测双重确认）
  }
}

/** sunRunExercises 报文（18 字段，逐字对齐实测真包） */
export function buildScoreRequest(context: RealSubmitContext): MpScoreRequest {
  const stats = buildRunStats({
    distanceKm: context.km,
    durationSeconds: context.durationSeconds,
    runType: 0, // 阳光跑
  })
  const time = buildTimeFields(context.startMs, context.endMs)
  return {
    scantronId: context.scantronId,
    stuNumber: context.snCode,
    schoolCode: context.schoolCode,
    runType: 0, // 阳光跑（自由跑才转 1）
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
    taskId: context.line.taskId ?? '',
    sunrunPathPointList: context.line.pointList ?? [],
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
