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
import { MP_HOST, type MpMornSignTask, type MpRunLine, type MpRunRecord, type MpSunrunTask } from './types'

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

// ============================================================
// 演示模式补齐（2026-11-24）：真实路径 / 成绩归档 / 本机记录 / 研途健行
//
// 目的：`enableDemo()` 之前只注入任务与线路 ⇒ 凡是靠「本机路线库 / 本机记录 / 成绩归档」的
// 界面在演示下必然是空的（真实路径页只剩"还没有登录态"、跑步页「开始跑步」是灰的）。
// 这里只放**数据与纯几何**；怎么装配（内存预设、演示分支）在装配层，本文件零框架依赖。
//
// 🔴 全部是编出来的：学号/姓名带 `DEMO`，场次号带 `demo-` 前缀（判据见 `utils/mp/realPath.ts`
//    的 `isDemoScoreId`）。演示数据**只进内存**，退出演示即消失，绝不进任何提交报文。
// ============================================================

/**
 * 【演示】整场轨迹：绕 `laps` 圈的连续点列（每圈带轻微径向漂移与相位差，
 * 免得看起来像"同一圈复制了 N 份"）。周长按 `lapM` 缩放，圈与圈之间不补首尾闭合点
 * —— 真人跑本来就有几米误差，正好给 `extractOneLap` 的 25 m 容差用。
 */
const buildLapRun = (
  centerLat: number,
  centerLng: number,
  lapM: number,
  laps: number,
  count = 40,
  driftM = 0.9,
): { latitude: number; longitude: number }[] => {
  const lngPerM = 1 / (M_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180))
  const radiusAt = (theta: number) => 1 + 0.28 * Math.sin(2 * theta + 0.6) + 0.12 * Math.cos(3 * theta)
  let oneLap = 0
  for (let i = 0; i < count; i++) {
    const a = radiusAt((i / count) * 2 * Math.PI)
    const b = radiusAt(((i + 1) / count) * 2 * Math.PI)
    const dTheta = (2 * Math.PI) / count
    // 折线长（米，scale=1 时）—— 用弦长近似，够用
    oneLap += Math.hypot(a - b, a * dTheta)
  }
  const scale = oneLap > 0 ? lapM / oneLap : 1
  const out: { latitude: number; longitude: number }[] = []
  for (let lap = 0; lap < laps; lap++) {
    const drift = driftM * lap
    const phase = 0.03 * lap
    for (let i = 0; i < count; i++) {
      const theta = (i / count) * 2 * Math.PI + phase
      const r = radiusAt(theta) * scale + drift
      out.push({
        latitude: Number((centerLat + (r * Math.sin(theta)) / M_PER_DEG_LAT).toFixed(6)),
        longitude: Number((centerLng + r * Math.cos(theta) * lngPerM).toFixed(6)),
      })
    }
  }
  return out
}

/** 【演示】两条真实跑的整场轨迹（操场线 × 8 圈 ≈ 3.2 km；日期/用时/拟合度都是编的） */
export const DEMO_REAL_PATH_RUNS = [
  {
    scoreId: 'demo-sunrun-20261118-01',
    date: '2026-11-18',
    startTime: '07:12:33',
    km: 3.2,
    usedTime: '00:18:42',
    fitDegree: 0.91,
    passType: 1,
    lineId: 'demo_line_002',
    lineName: '操场线（演示）',
    presetName: '演示 · 操场 11-18',
    points: buildLapRun(31.9405, 118.7865, 400, 8),
  },
  {
    scoreId: 'demo-sunrun-20261116-01',
    date: '2026-11-16',
    startTime: '06:58:10',
    km: 3.2,
    usedTime: '00:19:05',
    fitDegree: 0.88,
    passType: 1,
    lineId: 'demo_line_002',
    lineName: '操场线（演示）',
    presetName: '演示 · 操场 11-16',
    points: buildLapRun(31.9405, 118.7865, 400, 8, 40, 1.4),
  },
] as const

/** 【演示】成绩归档里的记录（「真实路径」页读的那份；日期与上面两条真实跑对齐） */
export const DEMO_ARCH_MONTHS = [
  { monthId: '2026-11', monthName: '2026年11月（演示）', isCurrent: true },
  { monthId: '2026-10', monthName: '2026年10月（演示）', isCurrent: false },
] as const

/** 【演示】归档记录：字段与服务端 `getSunrunArch` 归一化后的形状一致（`parseArchRecords` 的产物） */
export const DEMO_ARCH_RECORDS = [
  ...DEMO_REAL_PATH_RUNS.map((r) => ({
    scoreId: r.scoreId,
    paperId: 'demo_task_2026F',
    date: r.date,
    startTime: r.startTime,
    km: r.km,
    usedTime: r.usedTime,
    fitDegree: r.fitDegree,
    passType: r.passType,
  })),
  {
    scoreId: 'demo-sunrun-20261021-01',
    paperId: 'demo_task_2026F',
    date: '2026-10-21',
    startTime: '07:05:02',
    km: 3.2,
    usedTime: '00:20:31',
    fitDegree: 0.84,
    passType: 1,
  },
  {
    scoreId: 'demo-sunrun-20261012-01',
    paperId: 'demo_task_2026F',
    date: '2026-10-12',
    startTime: '07:20:44',
    km: 3.2,
    usedTime: '00:22:18',
    fitDegree: 0.52,
    passType: 0,
  },
] as const

/** 【演示】按 `scoreId` 取那条的整场轨迹（「真实路径」页的"读取这条的轨迹"用；没有 ⇒ 空数组） */
export const demoArchPoints = (scoreId: string): { latitude: number; longitude: number }[] => {
  const hit = DEMO_REAL_PATH_RUNS.find((r) => r.scoreId === String(scoreId))
  if (hit) return hit.points.map((p) => ({ ...p }))
  /** 归档里多出来的两条：换个中心/圈数，几何明显不是同一条（免得预览看起来"全一样"） */
  if (String(scoreId) === 'demo-sunrun-20261021-01') return buildLapRun(31.9398, 118.7884, 400, 8, 36, 1.1)
  if (String(scoreId) === 'demo-sunrun-20261012-01') return buildLapRun(31.9398, 118.7884, 400, 8, 36, 2.2)
  return []
}

/**
 * 【演示】本机成绩记录（记录页"载入演示数据"之后直接能看到 4 条，不用先跑一条）。
 * 三态里这四条都是 `demo`（`RecordsView` 的「提交」列会如实标「演示」）。
 */
export const DEMO_RECORDS_SEED: MpRunRecord[] = [
  ...DEMO_ARCH_RECORDS.map((r, i) => ({
    scoreId: r.scoreId,
    localId: `demo-local-${i + 1}`,
    submitState: 'demo',
    settledAtMs: Date.parse(`${r.date}T${r.startTime}+08:00`),
    paperId: r.paperId,
    runTime: r.date,
    startTmie: r.startTime,
    endTmie: '',
    scorePassType: r.passType,
    /** 都是阳光跑（runType=0）；缺了记录页的「类型」列会兜底显示"自由跑" */
    runType: 0,
    mileage: r.km.toFixed(2),
    usedTime: r.usedTime,
    trajectorySimilary: r.fitDegree,
    warnType: 0,
    ...(r.passType === 0 ? { scorePassRemark: '演示：拟合度不足（编的）' } : {}),
  })),
]

/**
 * 【演示】「研途健行」形态的任务：服务端**未下发线路**（`runPointList: []`）⇒
 * 走 `routeRequirementOf(task).kind === 'free'` 那套专用界面（目标里程 / 圈数 / 配速块）。
 * 其余字段与 `DEMO_TASK` 逐字一致，避免"演示两种任务约束不一样"造成误判。
 */
export const DEMO_TASK_YTU: MpSunrunTask = {
  ...DEMO_TASK,
  paperName: '研途健行（演示 · 未下发线路）',
  taskId: 'demo_task_ytu_2026F',
  runPointList: [],
  faceFlag: '0',
}

/**
 * 【演示】早操签到任务与点位（2026-11-24，演示模式补齐）。
 *
 * 真实链路对 `demo-` 前缀 token 一律拒绝（"演示 token 不能查真实数据"），
 * 于是演示模式下签到页只剩一句错误提示；这里给一份**本地假任务**，让「签到区域编辑」与
 * 「早操签到」两页能照常演示（只展示，**提交仍然要求真实 token**）。
 *
 * 🔴 `qrCode` 是编的（带 `DEMO-` 前缀），真实值由服务端下发；演示下提交按钮会被明确拒绝。
 */
export const DEMO_SIGN_TASK: MpMornSignTask = {
  signType: '1',
  startDate: '2026-09-01',
  endDate: '2027-01-10',
  /** ⚠️ 演示窗口刻意做成**全天**：真实窗口是 06:00~08:30，那个时段外"提交签到"按钮是灰的，
   *  演示时多半不在窗口内 ⇒ 用户/探针根本点不到那个按钮、看不到"演示态拒绝提交"这条提示。 */
  startTime: '00:00:00',
  endTime: '23:59:59',
  offsetRange: '200',
  dayNeedSignCount: '1',
  /** ⚠️ 演示用 0/1（今天还没签）：设成 1/1 会让"提交签到"按钮因"今日已完成"变灰，
   *  演示时看不到"演示态拒绝提交"这条提示。 */
  dayCompSignCount: '0',
  minTimeInterval: '0',
  signPointList: [
    {
      taskId: 'demo-sign-task',
      pointId: 'demo_sign_p1',
      pointName: '东操场入口（演示）',
      latitude: '31.9405',
      longitude: '118.7865',
      qrCode: 'DEMO-QRCODE-NOT-REAL-1',
    },
    {
      taskId: 'demo-sign-task',
      pointId: 'demo_sign_p2',
      pointName: '图书馆北门（演示）',
      latitude: '31.9398',
      longitude: '118.7884',
      qrCode: 'DEMO-QRCODE-NOT-REAL-2',
    },
    {
      taskId: 'demo-sign-task',
      pointId: 'demo_sign_p3',
      pointName: '体育馆西门（演示）',
      latitude: '31.9412',
      longitude: '118.7872',
      qrCode: 'DEMO-QRCODE-NOT-REAL-3',
    },
  ],
}

/** 【演示】本月签到记录（`getMornSignArchDetail` 归一化后的形状；日期是编的） */
export const DEMO_SIGN_ARCH = {
  completed: 12,
  incomplete: 3,
  required: 15,
  todaySigned: false,
  records: [
    { date: '2026-11-21', status: 1, statusText: '已签到', raw: { demo: true } },
    { date: '2026-11-20', status: 1, statusText: '已签到', raw: { demo: true } },
    { date: '2026-11-19', status: 0, statusText: '未签到', raw: { demo: true } },
    { date: '2026-11-18', status: 1, statusText: '已签到', raw: { demo: true } },
  ],
}
