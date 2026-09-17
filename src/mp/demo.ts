/**
 * 【演示数据】mock 数据集中地（2026-09-13 建，等 9-14 拿到真实数据后按「接入点」替换）
 *
 * 用途：在没有真实 token / 任务下发之前，让三页流程（登录 → 阳光跑 → 记录）可以用手点通。
 *
 * ⚠️ **本文件全部是编造的演示数据**，不含任何真实 token / 学号 / 姓名 / 轨迹。
 *    `DEMO_USER.snCode` 之类刻意用 `DEMO` 前缀，方便一眼认出来。
 *
 * ## 真实数据接入点（拿到后只改这些地方，页面不动）
 * | # | 现在（demo） | 拿到真实数据后 |
 * | --- | --- | --- |
 * | 1 | `DEMO_SESSION.token = 'demo-mock-token'` | 真实 token（登录页录入 / 微信 code 换 token） |
 * | 2 | `DEMO_SESSION.baseUrl` | `MpApiWrapper.resolveSchoolBaseUrl(schoolCode)` 的返回值 |
 * | 3 | `DEMO_TASK` | `MpApiWrapper.getSunrunPaper({stuNumber, campusId, token})` → `getSunrunPaperResponseList[0]` |
 * | 4 | `DEMO_LINES[].pointList` | `getSunrunPaper` 的 `runPointList[].pointList`（官方路线点列） |
 * | 5 | `DEMO_SWITCHES` | `selectSunRunStartConfiguration` 的 `body`（人脸 / 抽查开关） |
 * | 6 | 跑步页的「模拟倍速」 | 真实跑步时去掉（改为真实 GPS / 计时） |
 */
import { MP_HOST, type MpRunLine, type MpSunrunTask } from './types'

/** 【演示】会话：假 token + 共享域基址 */
export const DEMO_SESSION = {
  token: 'demo-mock-token',
  baseUrl: MP_HOST,
  userInfo: {
    snCode: 'DEMO2026001',
    studentName: '演示同学',
    schoolCode: '98765',
    schoolName: '南京航空航天大学',
    schoolCampusCode: 'demo_campus_01',
    schoolCampusName: '演示校区',
  },
}

/** 【演示】人脸 / 抽查开关（真实值 2026-09-11 实测为 "0"/"0"，9-14 需复验） */
export const DEMO_SWITCHES = {
  sunrunPointShowOff: '1',
  sunrunStartFace: '0',
  sunrunPointRandom: '0',
}

// ⚠️ 2026-09-17（B 轮）删除 `DEMO_CLIENT`：演示页的成绩报文已改为走 `buildScoreRequest()` 单一构造器，
//    不再需要这份手抄的 version/phoneInfo —— 而且它的 `phoneInfo` 是**三段式**，
//    与真实提交用的纯品牌串（`MP_PHONE_INFO_SCORE`）不一致，留着只会再次误导。
//    上报口径的唯一来源：`utils/mp/submitPayload.ts` 的 `MP_CLIENT_VERSION` / `MP_PHONE_INFO_*`。

const M_PER_DEG_LAT = 111320

/**
 * 【演示】生成一条闭合环线（示意形状，非真实校园道路）。
 * 只做平面近似：够真实感即可，拟合度与里程都由 `generateCorridorRoute` 真实计算。
 */
const buildLoop = (
  centerLat: number,
  centerLng: number,
  perimeterM: number,
  count = 30,
  phase = 0.6,
): { latitude: number; longitude: number }[] => {
  const lngPerM = 1 / (M_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180))
  /** 单位形状（米），半径做 2 次/3 次谐波调制 → 有直道也有转弯，不像正圆 */
  const shape = (theta: number) => {
    const r = 1 + 0.28 * Math.sin(2 * theta + phase) + 0.12 * Math.cos(3 * theta)
    return { east: r * Math.cos(theta), north: r * Math.sin(theta) }
  }
  const flat = (p: { east: number; north: number }, scale: number) => ({
    latitude: centerLat + (p.north * scale) / M_PER_DEG_LAT,
    longitude: centerLng + p.east * scale * lngPerM,
  })
  // 先按 scale=1 量周长，再整体缩放使周长 ≈ target
  let length = 0
  for (let i = 0; i < count; i++) {
    const a = flat(shape((i / count) * 2 * Math.PI), 1)
    const b = flat(shape(((i + 1) / count) * 2 * Math.PI), 1)
    length += Math.hypot((b.latitude - a.latitude) * M_PER_DEG_LAT, (b.longitude - a.longitude) / lngPerM)
  }
  const scale = length > 0 ? perimeterM / length : 1
  return Array.from({ length: count }, (_, i) => {
    const p = flat(shape((i / count) * 2 * Math.PI), scale)
    return { latitude: Number(p.latitude.toFixed(6)), longitude: Number(p.longitude.toFixed(6)) }
  })
}

/** 【演示】官方路线（闭合环线，周长约 1.15km —— 跑 3km 需绕 2.6 圈，正好体现「多圈」处理） */
export const DEMO_LINES: MpRunLine[] = [
  {
    pointId: 'demo_line_001',
    pointName: '环校线（演示）',
    pointList: buildLoop(31.9395, 118.789, 1150, 32),
  },
  {
    pointId: 'demo_line_002',
    pointName: '操场线（演示）',
    pointList: buildLoop(31.9405, 118.7865, 400, 20, 2.1),
  },
]

/** 【演示】打卡点（真实值来自任务的 `runPointList`；这里给 4 个，用来演示「应过点/已过点」） */
export const DEMO_PASS_POINTS = [
  { pointId: 'demo_point_1', pointName: '起点打卡点' },
  { pointId: 'demo_point_2', pointName: '图书馆北' },
  { pointId: 'demo_point_3', pointName: '体育馆西' },
  { pointId: 'demo_point_4', pointName: '东门折返点' },
]

/**
 * 【演示】阳光跑任务约束。
 * 字段名与**取值都已按 2026-09-14 实测的真实任务对齐**（单位已确认）：
 *   mileage 3.2km / fitDegree 0.6 / 时段 06:00–23:00 / 时长 10–25 分钟 /
 *   **minSpeed|maxSpeed = 时速 km/h（3 ~ 15）** ← 字段名实为 paperList.minSpeedHour/maxSpeedHour
 */
export const DEMO_TASK: MpSunrunTask = {
  paperName: '天目湖阳光跑（演示）',
  taskId: 'demo_task_2026F',
  mileage: 3.2,
  minSpeed: 3,
  maxSpeed: 15,
  minTime: 10,
  maxTime: 25,
  fitDegree: 0.6,
  startDate: '2026-09-14',
  endDate: '2027-01-08',
  startTime: '06:00:00',
  endTime: '23:00:00',
  runTimeRuleList: [{ startTime: '06:00:00', endTime: '23:00:00' }],
  runPointList: DEMO_LINES,
  faceFlag: '0',
  ifHasRun: '0',
}

/** 【演示】成绩页汇总（真实值来自 `getSunrunArch` 的顶层汇总字段） */
export const DEMO_ARCH_SUMMARY = {
  requireNumber: 30,
  completedTimes: 4,
  incompleteTimes: 1,
  totalMileage: '13.00',
}

/** 【演示】学期信息（`getSchoolTerm` 实测样例：2025-2026 第二学期，新学期尚未创建） */
export const DEMO_TERM = {
  id: 'demo_term_2026F',
  name: '2026-2027 第一学期（演示）',
}

/** 【演示】scantronId 形态与真实一致：`sunrunId` + `YYYYMMDD` + 当日序号 */
export const demoScantronId = (date = new Date(), seq = 1): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `sunrunId${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${String(seq).padStart(2, '0')}`
}
