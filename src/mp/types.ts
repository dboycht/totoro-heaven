/**
 * 小程序后端（wxxcx.xtotoro.com）接口契约与类型定义
 *
 * ⚠️ 状态说明：
 *   - 字段名与嵌套结构来自**小程序源码逆向**（`_mp-analyze/小程序逆向分析.md`），
 *     但**尚未经过真实抓包验证**（学校系统 2026-09-14 才上线）。
 *   - 凡是标注 `TODO(verify)` 的项，拿到 `.saz/.har` 后必须逐条核对，再删除标注。
 *   - 与旧 App 后端的**本质区别**：域名不同、鉴权改 Bearer、请求体为明文 JSON。
 */

/** 小程序后端基址（服务端代理目标） */
export const MP_HOST = 'https://wxxcx.xtotoro.com'

/** 小程序后端统一路由前缀（接口文档里写的是 /wxxcx/xxx） */
export const MP_API_PREFIX = '/wxxcx'

/** 通用响应包装：源码判成功用 `status === '00'` 或 `code === 0` */
export interface MpResponse<T = unknown> {
  /** '00' 表示成功（多数接口） */
  status?: string
  /** 0 表示成功（部分接口用 code） */
  code?: number | string
  msg?: string
  message?: string
  /** 业务数据体（部分接口为 body / obj / recordVos） */
  body?: T
  obj?: T
  data?: T
  [key: string]: unknown
}

/** 登录后本地保存的用户档案（小程序 storage: userInfo） */
export interface MpUserInfo {
  snCode: string
  studentName?: string
  name?: string
  schoolCode?: string
  schoolName?: string
  schoolCampusCode?: string
  schoolCampusName?: string
  [key: string]: unknown
}

/** 会话（本地持久化 token） */
export interface MpSession {
  token: string
  userInfo?: MpUserInfo
}

/** 跑步类型：小程序用 0=阳光跑，2=自由跑；提交时 2 会被转成 1 */
export type MpRunType = 0 | 2

/** 提交给 sunRunExercises 的 runType（源码：2 -> 1，其余原样） */
export const toSubmitRunType = (runType: MpRunType): number => (runType === 2 ? 1 : runType)

/** getRunBegin 入参 */
export interface MpRunBeginRequest {
  runType: number
  /** 微信基础库版本（源码取 systemInfo.version） */
  version: string
  /** 源码拼接为 brand&model&system（注意源码里 || 优先级疑似有 bug，TODO(verify)） */
  phoneInfo: string
  /** 阳光跑任务 id（自由跑为空串） */
  paperId: string
  /** 路线 id（源码用 columnsLine[i].pointId） */
  lineId: string
  /** 人脸数据（未开人脸为空串） */
  faceBase64: string
}

/** getRunBegin 返回（源码：a.scantronId） */
export interface MpRunBeginResponse extends MpResponse {
  scantronId?: string
}

/** sunRunExercises 入参（源码 saveScores 的 R 对象，完整字段） */
export interface MpScoreRequest {
  scantronId: string
  stuNumber: string
  schoolCode: string
  runType: number
  /** 公里数，字符串，如 "3.21" */
  km: string
  /** 时长，HH:mm:ss */
  usedTime: string
  /** 轨迹拟合度，两位小数字符串（0~1 还是 0~100 待核 TODO(verify)） */
  fitDegree: string
  /** 平均配速，形如 5'30" */
  avgSpeed: string
  steps: string | number
  token: string
  version: string
  phoneInfo: string
  /** 源码按 create_time_data 拆分 'T' 的第 0 段 */
  evaluateDate: string
  /** 源码按 end_time_data 拆分 'T' 的第 1 段 */
  endTime: string
  /** 源码按 create_time_data 拆分 'T' 的第 1 段 */
  startTime: string
  taskId: string
  /** 阳光跑：官方路线点列 */
  sunrunPathPointList: unknown[]
  /** 固定 '1' */
  flag: string
  [key: string]: unknown
}

/** sunRunExercisesDetail（轨迹明细）入参 */
export interface MpScoreDetailRequest {
  pointList: { latitude: number; longitude: number }[]
  gyroscope: unknown[]
  accelerometer: unknown[]
  /** 运动分析结论（如 '正常跑步'） */
  cheatCode: string
  scantronId: string
  token: string
}

/** 成绩状态：0 无效 / 1 有效 / 2 申诉有效 / 3 补录有效 */
export const MP_SCORE_STATUS = {
  0: '无效',
  1: '有效',
  2: '申诉有效',
  3: '补录有效',
} as const

/** 异常类型：1 步数异常 / 2 人脸异常 / 3 拟合度异常 */
export const MP_WARN_TYPE = {
  1: '步数异常',
  2: '人脸异常',
  3: '拟合度异常',
} as const

/**
 * 接口路径映射表（相对 MP_API_PREFIX）
 * 用途：把「业务动作」与「真实路径」解耦，方便抓包后一处修正、全局生效。
 */
export const MP_ENDPOINTS = {
  /** 微信登录换服务列表：入参 { code } */
  lesseeServerByNewDecode: '/platform/serverlist/getLesseeServerByNewDecode',
  /** 解绑/登出 */
  unbindInfo: '/platform/serverlist/unBindInfo',
  /** 首页公告 */
  sunRunNote: '/platform/note/selectSunRunNote',
  /** 首配置（决定登录方式） */
  firstConfiguration: '/sunrun/getSunRunFirstConfiguration',
  /** 开始跑步 */
  runBegin: '/sunrun/getRunBegin',
  /** 提交成绩 */
  saveScores: '/sunrun/sunRunExercises',
  /** 提交轨迹明细 */
  saveScoreDetail: '/platform/recrecord/sunRunExercisesDetail',
  /** 学期 / 月份 / 归档 */
  schoolTerm: '/sunrun/getSchoolTerm',
  schoolMonthByTerm: '/sunrun/getSchoolMonthByTerm',
  sunrunArch: '/sunrun/getSunrunArch',
  sunrunArchDetail: '/sunrun/getSunrunArchDetail',
  /** 打卡点 */
  runPointList: '/sunrun/getRunPointList',
  /** 人脸 */
  faceCheck: '/platform/sunrunFace/checkFace',
  faceCheckSave: '/platform/sunrunFace/checkFaceSave',
  faceMiddleStatus: '/platform/sunrunFace/selectFaceMiddleStatus',
  faceMiddleStart: '/platform/sunrunFace/faceMiddleStart',
  /** 随机人脸打卡上报 */
  submitPhoneCheck: '/sunrun/submitshoujidaka',
  /** 跑步配置（含人脸开关） */
  sunRunStartConfiguration: '/platform/sunrunFace/selectSunRunStartConfiguration',
} as const

export type MpEndpointKey = keyof typeof MP_ENDPOINTS
