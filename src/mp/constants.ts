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

/**
 * 上游路径的**已知命名空间前缀**（带尾斜杠）。
 *
 * 用途：代理决定"请求路径已经是完整上游路径"还是"旧写法、需要补 `/wxxcx`"——
 * 见 `server/api/mp/[...slug].ts`。**这是唯一来源**：以前代理自己又写了一份数组（D 轮收口），
 * 两处一旦不同步就会出现"某些端点被补错前缀"的隐蔽 bug。
 */
export const MP_PATH_PREFIXES = [MP_API_PREFIX + '/', MP_WXAPI_PREFIX + '/', '/oss/'] as const

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

// ⚠️ 2026-09-17（D 轮）删除 `MP_CHEAT_CODE` / `MpCheatCode`：它们**全仓零引用**，
//    而"MotionAnalyzer 的 6 个合法中文结论"这一事实已由 `_mp-analyze/深挖/C-风控与人脸.md` 与
//    `ERROR.md` E33 留档（明细报文只发 3 个字段，本就不带 cheatCode）。
//    需要时从那里查，别在代码里留一个没人用的导出（它会让人以为我们还在上报该字段）。
