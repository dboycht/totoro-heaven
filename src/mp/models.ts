/**
 * 小程序后端契约：数据模型与请求 / 响应类型
 *
 * 本文件由原 `src/mp/types.ts` 按职责拆分而来（对外入口仍是 `src/mp/types.ts` 这个 barrel）。
 *
 * ⚠️ 三条**必须遵守**的实测结论（旧实现曾全部搞错）：
 *   1. **没有统一信封**：`status`（sunrun/sunrunFace/h5）、`code`（serverlist/mornSign）、
 *      `header.bizCode`（登录态失效拦截）三轨并存 → 见 `envelope.ts`，禁止全局 `body ?? obj ?? data` 兜底。
 *   2. **负载位置逐端点漂移**：`obj` / `body` / `data` / 裸顶层 / 顶层具名字段 / 裸数组都有 →
 *      一律查 `MP_ENDPOINTS[key].payload`（见 `./endpoints`）。
 *   3. **请求必须始终带 `Authorization` 头**：鉴权过滤器只检查头是否存在；
 *      不带 → 401；带 `Bearer null` → 正常进入业务逻辑（登录态看 `header.bizCode == -199`）。
 */

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

/** 提交给 sunRunExercises 的 runType（源码：2 -> 1，其余原样）。
 *  返回类型收紧到 `0 | 1`（2026-09-17）：它是 `buildScoreRequest` 的入参类型，
 *  收紧后"自由跑口径"能在编译期被检查，而不是靠运行时猜。 */
export const toSubmitRunType = (runType: MpRunType): 0 | 1 => (runType === 2 ? 1 : runType)

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

/** sunRunExercisesDetail（轨迹明细）入参 —— 小程序只发这 3 个字段 */
export interface MpScoreDetailRequest {
  /** 轨迹点：**必须带 `time`（HH:mm:ss）**，否则服务端判「GPS位置为空！」整条拒收（2026-09-16 查实） */
  pointList: { latitude: number; longitude: number; time: string }[]
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

/** 提交成绩的时间字段基准（本地时间，`T` 分隔、无时区） */
export interface MpTimestampParts {
  /** YYYY-MM-DD */
  date: string
  /** HH:mm:ss */
  time: string
}
