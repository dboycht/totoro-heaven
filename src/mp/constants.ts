/**
 * 小程序后端契约：传输 / 编码层常量
 *
 * 本文件由原 `src/mp/types.ts` 按职责拆分而来（对外入口仍是 `src/mp/types.ts` 这个 barrel）。
 * 这里只放「与具体业务模型无关」的常量：基址、路由前缀、上游请求头、业务码表、
 * 以及数据映射表 / 已停用但仍作为源码留档的常量数组。
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

/**
 * MotionAnalyzer 的 6 个合法中文结论。
 * ⚠️ 仅留档：该值**当前不上报**（成绩/明细报文里都不再携带），保留数组是为了不丢掉
 * 「原小程序源码里存在这套结论口径」这一事实，供后续核对时参照。
 */
export const MP_CHEAT_CODE = [
  '正常跑步',
  '疑似使用代步工具',
  '长时间静止',
  '运动轨迹异常',
  '疑似全程走路',
  '未开启加速器',
] as const

export type MpCheatCode = (typeof MP_CHEAT_CODE)[number]
