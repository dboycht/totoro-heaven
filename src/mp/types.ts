/**
 * 小程序后端（wxxcx.xtotoro.com）接口契约与类型定义
 *
 * 事实来源（2026-09-11 研究轮，均已实测/源码逐字确认）：
 *   - 端点清单：对解包产物全量扫描 `url:"/..."`（54 个字面端点 + 1 个拼接端点 + 1 个裸 `wx.request`）
 *   - 信封与负载位置：`_mp-analyze/深挖/D-配置与归档数据模型.md` §0.3 逐端点表
 *   - 登录链路 / 人脸门槛 / 提交报文：`_mp-analyze/开跑前实测结论.md`
 *
 * ⚠️ 三条**必须遵守**的实测结论（旧实现曾全部搞错）：
 *   1. **没有统一信封**：`status`（sunrun/sunrunFace/h5）、`code`（serverlist/mornSign）、
 *      `header.bizCode`（登录态失效拦截）三轨并存 → 见 `envelope.ts`，禁止全局 `body ?? obj ?? data` 兜底。
 *   2. **负载位置逐端点漂移**：`obj` / `body` / `data` / 裸顶层 / 顶层具名字段 / 裸数组都有 →
 *      一律查本文件 `MP_ENDPOINTS[key].payload`。
 *   3. **请求必须始终带 `Authorization` 头**：鉴权过滤器只检查头是否存在；
 *      不带 → 401；带 `Bearer null` → 正常进入业务逻辑（登录态看 `header.bizCode == -199`）。
 */

/** 共享域基址：多租户下由 `getSunRunSchoolList` 的 `domainUrl` 覆盖（见 MpApiWrapper.resolveSchoolBaseUrl） */
export const MP_HOST = 'https://wxxcx.xtotoro.com'

/** 小程序后端统一路由前缀（多数端点在 /wxxcx/ 下） */
export const MP_API_PREFIX = '/wxxcx'

/** 第二个命名空间前缀（学校清单等 /wxapi/ 端点） */
export const MP_WXAPI_PREFIX = '/wxapi'

/** 代理转发时携带「本次上游基址」的请求头名（多租户；见 server/api/mp/[...slug].ts） */
export const MP_UPSTREAM_HEADER = 'x-mp-upstream'

/** 登录态失效时 `header.bizCode` 的取值（「登录过期，请重新登录！」）——不是 401 */
export const MP_CODE_EXPIRED = '-199'

/** 服务端业务码表（实测确认的部分，写死避免各处硬编码字符串） */
export const MP_CODES = {
  /** 登录过期（header.bizCode） */
  expired: MP_CODE_EXPIRED,
  /** 学生未注册（getLesseeServerByNewDecode） */
  unregistered: '-6001',
  /** 学生人脸数据为空（getRunBegin）——建档硬门槛 */
  faceMissing: '888',
  /** 记录提交异常（sunRunExercises，任务未配置/数值不达标时） */
  submitRejected: '-11',
} as const

/** 统一响应信封（三轨并存，字段都可能缺；判定逻辑见 envelope.ts） */
export interface MpResponseHeader {
  /** 新式业务码：0 = 成功；-199 = 登录过期 */
  bizCode?: number | string
  code?: number | string
  msg?: string
  message?: string
  [key: string]: unknown
}

export interface MpResponse<T = unknown> {
  /** '00' / '200' 表示成功（sunrun、sunrunFace、h5 系列） */
  status?: string
  /** 0 / '0' / '200' 表示成功（serverlist、mornSign、getRunBegin、人脸系列） */
  code?: number | string
  msg?: string
  message?: string
  /** 新式信封头（登录态失效时出现） */
  header?: MpResponseHeader
  /** 业务数据体的三个常见落点（逐端点不同，勿全局兜底） */
  body?: T
  obj?: T
  data?: T
  list?: T
  [key: string]: unknown
}

/**
 * 业务负载位置规格（**逐端点**声明，替代旧的 `body ?? obj ?? data` 全局兜底）。
 *
 * 取值写法：
 *   - `'none'` —— 明确无业务负载（只看状态码）
 *   - `'top'`  —— 负载就是整个响应对象（含顶层散字段，如 `getRunBegin.scantronId`）
 *   - 其余字符串 —— 顶层字段名；`|` 分隔多个字段表示**按序兜底**；
 *     `#n` 表示取该顶层数组的第 n 项（如 `'getSunrunPaperResponseList#0'`）
 *
 * 例：`'obj'`、`'body'`、`'termList'`、`'data|body|list|obj'`、`'getSunrunPaperResponseList#0'`
 */
export type MpPayloadSpec = 'none' | 'top' | (string & {})

/** 端点元数据（路径 / HTTP 方法 / 负载位置 / 是否必须有有效 token） */
export interface MpEndpointMeta {
  /** 上游真实路径（含 `/wxxcx` 或 `/wxapi` 前缀，不含 host） */
  path: string
  method: 'GET' | 'POST'
  /** 业务负载位置（默认 `'top'`：拿不准时给出整个响应，由调用方按字段读） */
  payload: MpPayloadSpec
  /** 是否需要有效 token：登录前必调的 7 个端点为 false（实测） */
  needToken: boolean
  /** 备注（多为源码/实测证据，便于下轮核对） */
  note?: string
}

/**
 * 端点元数据表（**唯一事实来源**）。
 * 新增端点时只在这里加一行，wrapper 通过 `MP_ENDPOINTS[key]` 取路径与方法。
 */
export const MP_ENDPOINTS = {
  // ---------- 学校 / 登录（7 个免鉴权端点） ----------
  schoolList: {
    path: '/wxapi/platform/active/getSunRunSchoolList',
    method: 'POST',
    payload: 'body',
    needToken: false,
    note: '裸 wx.request，硬编码共享域；响应 {body:[{schoolCode,schoolName,domainUrl}]}；多租户基址来源',
  },
  firstConfiguration: {
    path: '/wxxcx/sunrun/getSunRunFirstConfiguration',
    method: 'POST',
    payload: 'obj',
    needToken: false,
    note: '只读 obj.studentNameLoginType（1=姓名登录，隐藏短信验证码）',
  },
  selectSunRunStudent: {
    path: '/wxxcx/platform/serverlist/selectSunRunStudent',
    method: 'POST',
    payload: 'none',
    needToken: false,
    note: '只看 code==0',
  },
  bindLogin: {
    path: '/wxxcx/platform/serverlist/bindLogin',
    method: 'POST',
    payload: 'none',
    needToken: false,
    note: '字段逐字为 vertificationCode（服务端错拼，勿纠正）；password 固定 "123456"',
  },
  verificationCode: {
    path: '/wxxcx/platform/serverlist/getVerificationCode',
    method: 'POST',
    payload: 'none',
    needToken: false,
    note: '源码成功判定疑似写反（1==+code 当失败），实现时不要照抄',
  },
  lesseeServerByNewDecode: {
    path: '/wxxcx/platform/serverlist/getLesseeServerByNewDecode',
    method: 'POST',
    payload: 'top',
    needToken: false,
    note: 'token 在响应【顶层】res.token；code=="-6001" = 学生未注册',
  },
  studentInfo: {
    path: '/wxxcx/platform/serverlist/GetStudentInfo',
    method: 'POST',
    payload: 'obj',
    needToken: false,
    note: '免鉴权且字段骨架含 PII（idNumber/phoneNumber/faceData）——纪律：绝不查询非本人数据',
  },
  studentInfoByToken: {
    path: '/wxxcx/platform/serverlist/GetStudentInfoByToken',
    method: 'GET',
    payload: 'obj',
    needToken: true,
    note: 'schoolCampusCode 是 getSunrunPaper 的必需入参 campusId',
  },
  unBindInfo: {
    path: '/wxxcx/platform/serverlist/unBindInfo',
    method: 'GET',
    payload: 'none',
    needToken: true,
    note: '⚠️ 写操作，会真解绑账号（探针曾误触，见 ERROR.md E21）；只在用户明确要求登出时调用',
  },
  appFrontPage: {
    path: '/wxxcx/platform/serverlist/getAppFrontPage',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '顶层散字段（含 sunRunFreeType 免跑标记）',
  },

  // ---------- 跑步主流程 ----------
  runBegin: {
    path: '/wxxcx/sunrun/getRunBegin',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '成功 → 顶层 scantronId（形如 sunrunId20260911217）；未建档 → code:"888"',
  },
  saveScores: {
    path: '/wxxcx/sunrun/sunRunExercises',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '18 字段提交；成功 status=="00"（新版）或 code==0（旧版）；被拒 status:"-11"',
  },
  saveScoreDetail: {
    path: '/wxxcx/platform/recrecord/sunRunExercisesDetail',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '轨迹明细；顺序上必须在 saveScores 之后',
  },
  runPointList: {
    path: '/wxxcx/sunrun/getRunPointList',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '整个响应对象即负载（sunRunStatus/sunRunMsg/allCount/nullCount/alreadyCount）',
  },
  runPointListAbnormal: {
    path: '/wxxcx/sunrun/getRunPointListAbnormal',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '顶层 abnormalPointType（0=正常）',
  },
  checkisshoujidaka: {
    path: '/wxxcx/sunrun/checkisshoujidaka',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '顶层 isOpen（是否开启手机打卡）',
  },
  submitshoujidaka: {
    path: '/wxxcx/sunrun/submitshoujidaka',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '随机人脸抽查上报（打卡点手机打卡）',
  },

  // ---------- 任务 / 学期 / 归档 ----------
  sunrunPaper: {
    path: '/wxxcx/sunrun/getSunrunPaper',
    method: 'POST',
    payload: 'getSunrunPaperResponseList#0',
    needToken: true,
    note: '入参必须带 campusId（= schoolCampusCode），否则必报「该校区阳光跑任务未设置」',
  },
  sunrunPaperList: {
    path: '/wxxcx/sunrun/getSunrunPaperList',
    method: 'POST',
    payload: 'sunrunTaskList',
    needToken: true,
    note: '源码调用不带 token（只传 stuNumber/snCode）',
  },
  schoolTerm: {
    path: '/wxxcx/sunrun/getSchoolTerm',
    method: 'POST',
    payload: 'obj',
    needToken: true,
    note: 'obj.name / obj.id（termId）',
  },
  termList: {
    path: '/wxxcx/sunrun/getTermList',
    method: 'POST',
    payload: 'termList',
    needToken: true,
    note: '元素含 id/name/isActive（1=当前学期）',
  },
  schoolMonthByTerm: {
    path: '/wxxcx/sunrun/getSchoolMonthByTerm',
    method: 'POST',
    payload: 'monthList',
    needToken: true,
    note: '源码不带 termId；元素含 monthId/monthName/ifCurrent',
  },
  sunrunArch: {
    path: '/wxxcx/sunrun/getSunrunArch',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '顶层 data[] 成绩数组 + 同级汇总（requireNumber/completedTimes/incompleteTimes/totalMileage）',
  },
  sunrunArchDetail: {
    path: '/wxxcx/sunrun/getSunrunArchDetail',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: 'body.pointList[]（源码调用不带 token）',
  },
  sunRunDayScantronList: {
    path: '/wxxcx/sunrun/selectSunRunDayScantronList',
    method: 'POST',
    payload: 'data|body|list|obj',
    needToken: true,
    note: '【唯一】源码使用 data??body??list??obj 兜底链的端点（申诉记录列表）',
  },

  // ---------- 申诉 ----------
  appealList: {
    path: '/wxxcx/sunrun/getAppealList',
    method: 'POST',
    payload: 'recordVos',
    needToken: true,
    note: '顶层 recordVos[]',
  },
  appealById: {
    path: '/wxxcx/sunrun/getAppealById',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '顶层平铺（appealStatus/paperId/scantronId/…），不在 body 里',
  },
  submitAppeal: {
    path: '/wxxcx/sunrun/submitAppeal',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '成功 status=="00"',
  },
  appealSunRunFaceOn: {
    path: '/wxxcx/platform/sunrunFace/appealSunRunFaceOn',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: '源码请求体不带 token/snCode（但 Authorization 头始终带）；body.sunrunAppealFaceOn / sunrunAppealFaceTime',
  },
  checkFaceAppealSunRun: {
    path: '/wxxcx/platform/sunrunFace/checkFaceAppealSunRun',
    method: 'POST',
    payload: 'obj',
    needToken: true,
    note: '源码请求体不带 token（入参 snCode+faceData）；obj = faceDataTzFour；成功 status=="00"',
  },

  // ---------- 人脸 / 抽查 ----------
  sunRunStartConfiguration: {
    path: '/wxxcx/platform/sunrunFace/selectSunRunStartConfiguration',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: 'body.{sunrunPointShowOff,sunrunStartFace,sunrunPointRandom}（"1"=开启）',
  },
  sunRunRandomConfiguration: {
    path: '/wxxcx/platform/sunrunFace/selectSunRunRandomConfiguration',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: 'body.{startDistance,checkDistance,offsetDistance}；只传 lineId+token',
  },
  faceCheck: {
    path: '/wxxcx/platform/sunrunFace/checkFace',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '顶层 faceCodeEntityList；成功 status=="00"',
  },
  faceCheckSave: {
    path: '/wxxcx/platform/sunrunFace/checkFaceSave',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '⚠️ 人脸建档（写操作）；源码 URL 尾部带空格，已剔除',
  },
  faceCheckStartSunRun: {
    path: '/wxxcx/platform/sunrunFace/checkFaceStartSunRun',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '开场人脸比对；判据 "00"!=status && 0!=code && "200"!=code → 失败',
  },
  faceMiddleStatus: {
    path: '/wxxcx/platform/sunrunFace/selectFaceMiddleStatus',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: 'body 为布尔字符串（"1"=本次需抽查）；成功 status=="00"',
  },
  faceMiddleStart: {
    path: '/wxxcx/platform/sunrunFace/faceMiddleStart',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '抽查开始上报（totalRun/snCode/scantronId/studentName）',
  },
  faceMiddleCheck: {
    path: '/wxxcx/platform/sunrunFace/checkFaceMiddleSunRun',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '抽查人脸比对（faceData/snCode/totalRun/scantronId/经纬度）',
  },
  startUpNote: {
    path: '/wxxcx/platform/sunrunFace/startUpNote',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '开跑前调用；响应含顶层 faceCodeEntityList（实测曾为 null）',
  },

  // ---------- 相机 / 过点 ----------
  cameraConfig: {
    path: '/wxxcx/platform/camera/getCameraConfig',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note:
      '⚠️ 2026-09-15 修正：**flag 在 `body` 里**（`body.flag`），摄像头列表在同级 `data[]`。' +
      '依据：小程序源码 `getCameraConfig` → `CameraConfigFlag: t.body?.flag`（逐字）；第三方实现也读 `camera.body?.flag`。' +
      '此前误登记为 `top` → 读 `data.flag` 恒为 undefined → 门禁永远判定"摄像头杆未读取"（见 ERROR.md E30）。',
  },
  cameraPolling: {
    path: '/wxxcx/platform/camera/getCameraPolling',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: 'body.isPoint（isPoint==0 时播「抬头看摄像头」）',
  },
  cameraTimeMillis: {
    path: '/wxxcx/platform/camera/currentTimeMillis',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: '服务端毫秒时间戳；响应尾部会暴露任务约束字段名（实测发现点）',
  },

  // ---------- 公告 / 首页 / H5 ----------
  sunRunNote: {
    path: '/wxxcx/platform/note/selectSunRunNote',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: 'body 可能是对象也可能是数组（实测空时为 []）',
  },
  freeAndDelay: {
    path: '/wxxcx/platform/h5/getFreeAndDelayt',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: '免跑/缓跑申请（注意端点名拼写 Delayt）',
  },
  projectFreeAndDelayList: {
    path: '/wxxcx/platform/h5/getProjectFreeAndDelayList',
    method: 'POST',
    payload: 'data',
    needToken: true,
    note: '顶层 data',
  },
  saveSunAppealInfoList: {
    path: '/wxxcx/platform/h5/saveSunAppealInfoList',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '成功 status=="00"',
  },
  additionalCardBySnCode: {
    path: '/wxxcx/platform/h5/selectAdditionalCardBySnCode',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: '—',
  },
  uploadFileSunRunScan: {
    path: '/wxxcx/platform/h5/uploadFileSunRunScan',
    method: 'POST',
    payload: 'body#0',
    needToken: true,
    note: 'multipart 上传（wx.uploadFile，URL 为拼接式），响应体需 JSON.parse；body[0].url',
  },

  // ---------- 早操签到（南航实测：本学校无需签到） ----------
  mornSignPaper: {
    path: '/wxxcx/platform/mornSign/getMornSignPaper',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '顶层 signPointList/offsetRange/dayCompSignCount；成功 status==="00"',
  },
  morningExercises: {
    path: '/wxxcx/platform/mornSign/morningExercises',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '唯一使用加密参的端点（{encryptParams}）；成功 code==0',
  },
  mornSignArchDetail: {
    path: '/wxxcx/platform/mornSign/getMornSignArchDetail',
    method: 'POST',
    payload: 'top',
    needToken: true,
    note: '顶层 scoreList/completedTimes',
  },

  // ---------- 教师端 / 其他 ----------
  teacherStudentClass: {
    path: '/wxxcx/platform/teacherCon/selectStudentClass',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: 'body 为数组',
  },
  teacherStudentNum: {
    path: '/wxxcx/platform/teacherCon/selectStudentNum',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: 'body.{allNum,scanNum,dayNum,studentInfo}',
  },
  teacherStudentTermCount: {
    path: '/wxxcx/platform/teacherCon/selectStudentTermCount',
    method: 'POST',
    payload: 'body',
    needToken: true,
    note: 'body.studentInfo',
  },
  studySave: {
    path: '/wxxcx/platform/study/save',
    method: 'POST',
    payload: 'none',
    needToken: true,
    note: '未见判定',
  },
  systemporductList: {
    path: '/wxxcx/sunrun/systemporductList',
    method: 'GET',
    payload: 'top',
    needToken: true,
    note: '【裸数组】响应无信封；源码取到后被前端硬编码忽略',
  },
  ossAccessId: {
    path: '/oss/getAccessId',
    method: 'GET',
    payload: 'top',
    needToken: true,
    note: 'OBS 直传签名（expire/accessid/policy/signature/dir/host）',
  },
} as const satisfies Record<string, MpEndpointMeta>

export type MpEndpointKey = keyof typeof MP_ENDPOINTS

/** 取端点元数据（返回只读表项） */
export const mpEndpoint = <K extends MpEndpointKey>(key: K): (typeof MP_ENDPOINTS)[K] => MP_ENDPOINTS[key]

// ---------- 数据模型 ----------

/** `getSunRunSchoolList` 的一所学校（多租户基址来源） */
export interface MpSchool {
  schoolCode: string
  schoolName: string
  /** API 基址：源码里改名为 baseUrl 并写入 storage schoolBaseUrl / globalData.host */
  domainUrl: string
  /** 专属小程序域名（非空 = 该校有专属小程序，本项目明确不支持） */
  domainUrlSon?: string
  [key: string]: unknown
}

/** 登录后本地保存的用户档案（小程序 storage: userInfo） */
export interface MpUserInfo {
  snCode: string
  studentName?: string
  name?: string
  schoolCode?: string
  schoolName?: string
  /** 校区编码，同时是 getSunrunPaper 的必需入参 campusId（实测样例 fask_campus_01） */
  schoolCampusCode?: string
  schoolCampusName?: string
  [key: string]: unknown
}

/** 会话（本地持久化 token；源码无 refresh token、无 expires） */
export interface MpSession {
  token: string
  /** 多租户基址（该校 domainUrl）；缺省用共享域 */
  baseUrl?: string
  userInfo?: MpUserInfo
}

/** 跑步类型：小程序用 0=阳光跑，2=自由跑；提交时 2 会被转成 1 */
export type MpRunType = 0 | 2

/** 提交给 sunRunExercises 的 runType（源码：2 -> 1，其余原样） */
export const toSubmitRunType = (runType: MpRunType): number => (runType === 2 ? 1 : runType)

/** getRunBegin 入参 */
export interface MpRunBeginRequest {
  runType: number
  /** 微信基础库版本（源码取 systemInfo.version；实测样例 "4.1.12.55"） */
  version: string
  /** 源码拼接为 brand&model&system；实测真包为纯品牌串（`||` 优先级 bug），建议按三段式发送 */
  phoneInfo: string
  /** 阳光跑任务 id（任务未配置时为空串） */
  paperId: string
  /** 路线 id（源码用 columnsLine[i].pointId） */
  lineId: string
  /** 人脸数据（已建档后可为空串；未建档时服务端直接拒绝 code:"888"） */
  faceBase64: string
  /** 服务端要 body 里也带一份 token（实测） */
  token?: string
}

/** getRunBegin 返回（scantronId 在**顶层**，实测确认） */
export interface MpRunBeginResponse extends MpResponse {
  scantronId?: string
}

/** sunRunExercises 入参（18 字段，实测真包逐字确认） */
export interface MpScoreRequest {
  scantronId: string
  stuNumber: string
  schoolCode: string
  runType: number
  /** 公里数，字符串 2 位小数，如 "3.21" */
  km: string
  /** 时长，HH:mm:ss */
  usedTime: string
  /** 轨迹拟合度：**0~1 两位小数字符串**（实测 "0.00"，非 0~100） */
  fitDegree: string
  /** 平均配速，形如 `M'SS"`（实测 `0'00"`） */
  avgSpeed: string
  /** 源码全工程无赋值 → 实测恒为 "" */
  steps: string
  /** 请求体里再传一份 token（实测确认） */
  token: string
  version: string
  phoneInfo: string
  /** create_time_data 按 `T` 拆分的第 0 段（YYYY-MM-DD） */
  evaluateDate: string
  /** end_time_data 按 `T` 拆分的第 1 段（HH:mm:ss） */
  endTime: string
  /** create_time_data 按 `T` 拆分的第 1 段（HH:mm:ss） */
  startTime: string
  taskId: string
  /** 阳光跑：官方路线点列（无任务时为空数组） */
  sunrunPathPointList: unknown[]
  /** 固定 '1' */
  flag: string
  [key: string]: unknown
}

/** sunRunExercisesDetail（轨迹明细）入参 */
export interface MpScoreDetailRequest {
  pointList: { latitude: number; longitude: number }[]
  /** 客户端本就只发空数组（源码硬编码），故 cheatCode 无法被服务端复算 */
  gyroscope: unknown[]
  accelerometer: unknown[]
  /** 运动分析结论（合法值见 MP_CHEAT_CODE） */
  cheatCode: string
  scantronId: string
  token: string
  [key: string]: unknown
}

/** 线路上的一个打卡点（`sunrunTaskList[].runPointList[]` / `getSunrunPaper.runPointList[]`） */
export interface MpRunLine {
  /** 线路 id（提交 getRunBegin 的 `lineId`，源码用 `columnsLine[i].pointId`） */
  pointId: string
  /** 所属任务 id（提交 getRunBegin 的 `paperId` / sunRunExercises 的 `taskId`；实测 9-14 同值） */
  taskId?: string
  pointName: string
  /** 线路点列（提交成绩的 `sunrunPathPointList` 就是它） */
  pointList: { latitude: string | number; longitude: string | number }[]
  [key: string]: unknown
}

/**
 * 阳光跑任务与约束（`getSunrunPaper` → `getSunrunPaperResponseList[i]`，即源码里的 `sunrunlimiting`）。
 *
 * 字段名来自 `camera/currentTimeMillis` 响应尾部**实测暴露**的约束字段全集
 * （`_mp-analyze/开跑前实测结论.md` §3）；**真实取值需 9-14 任务下发后确认**。
 * ⚠️ `minSpeed`/`maxSpeed` 的**单位与语义尚未实测**（推断为配速上下限），故类型放宽为 number|string。
 */
export interface MpSunrunTask {
  /** 任务名 */
  paperName: string
  /** 任务 id（提交成绩的 taskId） */
  taskId: string
  /** 目标里程（公里） */
  mileage: number
  /** 配速/速度下限（语义待实测） */
  minSpeed?: number | string
  /** 配速/速度上限（语义待实测） */
  maxSpeed?: number | string
  /** 时长下限（秒？待实测） */
  minTime?: number | string
  /** 时长上限（秒？待实测） */
  maxTime?: number | string
  /** 拟合度阈值（服务端执行，默认 0.6） */
  fitDegree?: number | string
  /** 任务有效期（YYYY-MM-DD） */
  startDate?: string
  endDate?: string
  /** 生效时段（HH:mm:ss） */
  startTime?: string
  endTime?: string
  /** 允许跑步的时段规则 */
  runTimeRuleList?: { startTime: string; endTime: string }[]
  /** 可选线路（含线路点列） */
  runPointList: MpRunLine[]
  /** 人脸标记（语义待实测） */
  faceFlag?: string | number
  /** 今日是否已跑 */
  ifHasRun?: string | number
  /** 步数约束（推断） */
  minWalkTotal?: number
  maxWalkTotal?: number
  [key: string]: unknown
}

/**
 * `getSunrunArch` 返回的一条成绩记录。
 * ⚠️ 字段名逐字照抄源码与模板：`startTmie` / `endTmie` 是**服务端的拼写错误**，勿"纠正"。
 */
export interface MpRunRecord {
  scoreId: string
  /** 任务 id（申诉跳转参数 taskId） */
  paperId: string
  /** 日期 YYYY-MM-DD */
  runTime: string
  /** 开始时间 HH:mm:ss（源码拼写 Tmie） */
  startTmie?: string
  /** 结束时间 HH:mm:ss（源码拼写 Tmie） */
  endTmie?: string
  /** 0 无效 / 1 有效 / 2 申诉有效 / 3 补录有效 */
  scorePassType: number | string
  /** 无效原因文案（仅 scorePassType=='0' 时渲染） */
  scorePassRemark?: string
  /** 里程（km，字符串） */
  mileage?: string
  usedTime?: string
  /** 轨迹拟合度 */
  trajectorySimilary?: string | number
  /** 0 阳光跑 / 1 自由跑 */
  runType?: number
  /** 成绩来源：1 补录 / 2 小程序申诉 / 3 App 申诉 / 4 补卡机 */
  flag?: number
  [key: string]: unknown
}

/** 成绩状态：0 无效 / 1 有效 / 2 申诉有效 / 3 补录有效（getSunrunArch.scorePassType） */
export const MP_SCORE_STATUS = {
  0: '无效',
  1: '有效',
  2: '申诉有效',
  3: '补录有效',
} as const

/**
 * 异常类型映射表（源码 `SetwarnType`）。
 * ⚠️ 该表**只被定义、从未在模板中被索引**（页面实际渲染 `scorePassRemark`）；
 * 其键来自哪个响应字段源码无法确认，需抓包（见深挖 D §5.2）。
 */
export const MP_WARN_TYPE = {
  1: '步数异常',
  2: '人脸异常',
  3: '拟合度异常',
} as const

/** MotionAnalyzer 的 6 个合法中文结论 */
export const MP_CHEAT_CODE = [
  '正常跑步',
  '疑似使用代步工具',
  '长时间静止',
  '运动轨迹异常',
  '疑似全程走路',
  '未开启加速器',
] as const

export type MpCheatCode = (typeof MP_CHEAT_CODE)[number]

/** 提交成绩的时间字段基准（本地时间，`T` 分隔、无时区） */
export interface MpTimestampParts {
  /** YYYY-MM-DD */
  date: string
  /** HH:mm:ss */
  time: string
}
