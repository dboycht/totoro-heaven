/**
 * 小程序后端（wxxcx.xtotoro.com）接口契约与类型定义 —— **对外唯一入口（barrel）**
 *
 * 本文件**只做再导出**，不再承载具体定义（2026-09 按职责拆分，避免单文件继续膨胀）：
 *   - `./constants` —— 传输 / 编码层常量（基址、路由前缀、上游请求头、业务码表、留档常量）
 *   - `./models`    —— 数据模型与请求 / 响应类型（`MpResponse` / `MpSchool` / `MpScoreRequest` …）
 *   - `./endpoints` —— 端点元数据表 `MP_ENDPOINTS` + `MpEndpointKey` / `MpEndpointMeta`
 *
 * ⚠️ 新增常量 / 类型时请加到上面对应的文件，**不要再往本文件里堆东西**；
 *    全仓的 `from '~/src/mp/types'` / `'../../src/mp/types.ts'` 引用依赖这里再导出，请保持符号不变。
 */

export * from './constants'
export * from './models'
export * from './endpoints'
