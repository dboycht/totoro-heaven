/**
 * 小程序后端契约：端点元数据表（路径 / 方法 / 负载位置 / 是否需要 token）
 *
 * 本文件由原 `src/mp/types.ts` 按职责拆分而来（对外入口仍是 `src/mp/types.ts` 这个 barrel）。
 *
 * 事实来源（2026-09-11 研究轮，均已实测/源码逐字确认）：
 *   - 端点清单：对解包产物全量扫描 `url:"/..."`（当时扫到 **56 处**：54 个字面端点 + 1 个拼接端点 + 1 个裸 `wx.request`）
 *   - ⚠️ **本表现有 57 个 key**（2026-09-19 实测复核：`needToken:false` 7 个 + `true` 50 个，无重复 key；
 *     全部 57 个 key 的 `path` 都是字面量）——比当年扫描口径多 1 条，说明**有 1 条是后补登记的**。
 *     三处旧数字（本行原写 56、`HANDOVER.md` 曾写 58）已按实测统一为 **57**。
 *   - 信封与负载位置：`_mp-analyze/深挖/D-配置与归档数据模型.md` §0.3 逐端点表
 *   - 登录链路 / 人脸门槛 / 提交报文：`_mp-analyze/开跑前实测结论.md`
 */
import type { MpPayloadSpec } from './models'

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
      '⚠️ 2026-09-15 修正：flag 在 `body` 里（`body.flag`），摄像头列表在同级 `data[]`。' +
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
