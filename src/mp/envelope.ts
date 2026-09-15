/**
 * 响应信封判定 + 逐端点负载解包（**纯函数，零依赖，有单测**）
 *
 * 存在意义（实测结论，见 `_mp-analyze/深挖/D-配置与归档数据模型.md` §0.2/§0.3）：
 *   1. 后端**没有统一信封**——`status` / `code` / `header.bizCode` 三轨并存；
 *   2. 业务负载**逐端点漂移**——`obj` / `body` / `data` / 裸顶层 / 顶层具名字段 / 裸数组都有；
 *   3. 登录态失效的判据是 **`header.bizCode == -199`**，不是 HTTP 401。
 *
 * 因此：任何「全局 body ?? obj ?? data 兜底」都是错的，负载位置必须由
 * `MP_ENDPOINTS[key].payload` 逐端点声明后交给这里解包。
 */
import { MP_CODES, type MpPayloadSpec, type MpResponse } from './types'

export type MpVerdictKind =
  /** 业务成功（且负载符合端点规格） */
  | 'ok'
  /** 登录态失效：`header.bizCode == -199` */
  | 'expired'
  /** 业务失败：服务端明确返回了失败码（'01' / '1' / '888' / '-11' / '-6001' …） */
  | 'business'
  /** 传输层/代理层异常（响应为空、非对象） */
  | 'system'
  /** 状态码是成功，但按端点规格应有负载却为空（如「没有阳光跑任务！」） */
  | 'empty'
  /** 既无状态码也无负载，无法识别 */
  | 'unknown'

export interface MpVerdict {
  ok: boolean
  kind: MpVerdictKind
  /** 服务端业务码（status / code / header.bizCode 中最先命中的那个） */
  code?: string
  /** 服务端消息（msg ?? message ?? header 内消息 ?? 兜底文案） */
  message: string
}

/** 判定为「成功」的业务码：'00'（sunrun/sunrunFace/h5）、'0'（serverlist/mornSign）、'200'（人脸系列） */
const OK_CODES = new Set(['0', '00', '200'])

/** 信封自身的字段名——判断「裸顶层」负载是否为空时要排除掉它们 */
const ENVELOPE_KEYS = new Set(['status', 'code', 'msg', 'message', 'header', 'success', 'timestamp', 'serverTime'])

/** 解析负载规格：`'a|b#0'` → `[{field:'a'},{field:'b',index:0}]` */
export interface MpPayloadField {
  field: string
  index?: number
}

export function parsePayloadSpec(spec: MpPayloadSpec): MpPayloadField[] {
  if (spec === 'none' || spec === 'top') return []
  const out: MpPayloadField[] = []
  for (const raw of spec.split('|')) {
    const part = raw.trim()
    if (!part) continue
    const [field, indexText] = part.split('#')
    if (!field) continue
    if (indexText === undefined) {
      out.push({ field })
      continue
    }
    const index = Number.parseInt(indexText, 10)
    out.push(Number.isFinite(index) ? { field, index } : { field })
  }
  return out
}

const toCode = (value: unknown): string | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  return undefined
}

const pickMessage = (env: MpResponse): string => {
  const candidates = [env.msg, env.message, env.header?.msg, env.header?.message]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/**
 * 按端点规格取出业务负载。
 * - `'none'` → 永远 undefined（该端点本就无负载）
 * - `'top'`  → 整个响应对象（含顶层散字段）
 * - 其余     → 顶层字段，`|` 按序兜底，`#n` 取数组第 n 项
 */
export function unwrapMpResponse<T = unknown>(res: unknown, spec: MpPayloadSpec = 'top'): T | undefined {
  if (res === null || res === undefined) return undefined
  if (spec === 'none') return undefined
  if (Array.isArray(res)) return res as T
  if (typeof res !== 'object') return undefined
  if (spec === 'top') return res as T

  const env = res as Record<string, unknown>
  for (const { field, index } of parsePayloadSpec(spec)) {
    const value = env[field]
    if (value === undefined || value === null) continue
    if (index === undefined) return value as T
    if (!Array.isArray(value)) continue
    const item = value[index]
    if (item === undefined || item === null) continue
    return item as T
  }
  return undefined
}

/** 负载是否「有内容」（用于把 `status:"00"` 但空负载的伪成功识别成 empty） */
export function hasBusinessPayload(res: unknown, spec: MpPayloadSpec): boolean {
  if (res === null || res === undefined) return false
  if (spec === 'none') return false
  const payload = unwrapMpResponse(res, spec)
  if (payload === undefined) return false
  if (spec !== 'top') return true
  if (Array.isArray(payload)) return payload.length > 0
  if (typeof payload !== 'object' || payload === null) return false
  return Object.keys(payload as Record<string, unknown>).some((key) => !ENVELOPE_KEYS.has(key))
}

/**
 * 判定一次响应。
 * @param spec 该端点的负载规格（取自 `MP_ENDPOINTS[key].payload`）；
 *             传 `'none'` 时只判状态码，不做负载非空校验。
 */
export function judgeMpResponse(res: unknown, spec: MpPayloadSpec = 'top'): MpVerdict {
  if (res === null || res === undefined) {
    return { ok: false, kind: 'system', message: '响应为空（网络或代理异常）' }
  }
  if (typeof res !== 'object') {
    return { ok: false, kind: 'unknown', message: '无法识别的响应类型' }
  }

  const env = res as MpResponse
  const bizCode = toCode(env.header?.bizCode ?? env.header?.code)
  const status = toCode(env.status)
  const code = toCode(env.code)
  const message = pickMessage(env)

  // 1) 登录态失效优先（判据是 header.bizCode == -199，不是 401）
  if (bizCode === MP_CODES.expired) {
    return { ok: false, kind: 'expired', code: bizCode, message: message || '登录过期，请重新登录' }
  }

  const firstCode = status ?? code ?? bizCode
  const hasPayload = hasBusinessPayload(res, spec)
  const okByCode = [status, code, bizCode].some((value) => value !== undefined && OK_CODES.has(value))

  // 2) 明确成功 → 仍要按端点规格校验负载非空（服务端存在「00 + 没有任务！」这类伪成功）
  if (okByCode) {
    if (!hasPayload && spec !== 'none') {
      return { ok: false, kind: 'empty', code: firstCode, message: message || '接口返回成功，但业务负载为空' }
    }
    return { ok: true, kind: 'ok', code: firstCode, message }
  }

  // 3) 明确失败
  const failCode = code ?? status ?? bizCode
  if (failCode !== undefined) {
    return { ok: false, kind: 'business', code: failCode, message: message || `业务失败（code=${failCode}）` }
  }

  // 4) 无任何状态码：源码里大量端点根本不判定状态，此时有负载即放行
  if (hasPayload) return { ok: true, kind: 'ok', message }
  return { ok: false, kind: 'unknown', message: message || '无法识别的响应（既无状态码也无负载）' }
}

// ---------- 便捷判定（兼容旧 API） ----------

/**
 * 是否成功。
 * @param spec 默认 `'none'`（只判状态码，与旧实现语义一致）；传端点规格则同时校验负载非空。
 */
export const isMpOk = (res: unknown, spec: MpPayloadSpec = 'none'): boolean => judgeMpResponse(res, spec).ok

/** 是否为「登录过期」（header.bizCode == -199） */
export const isMpExpired = (res: unknown): boolean => judgeMpResponse(res, 'none').kind === 'expired'

/**
 * 是否是「token 过期 / 失效」类响应（用于给用户**可操作**的提示）。
 *
 * 覆盖两种实测表达（缺一不可）：
 *   ① 新式拦截：`header.bizCode == -199`（`kind === 'expired'`）；
 *   ② **业务失败**：`status:"01"` / `code:"1"` 且 `msg` 含"失效/过期" ——
 *      `GetStudentInfoByToken` 实测回的是 `{"status":"01","code":"1","msg":"token失效，注册失败"}`（2026-09-15）。
 */
export function looksLikeTokenExpired(res: unknown): boolean {
  if (isMpExpired(res)) return true
  if (!res || typeof res !== 'object') return false
  const r = res as MpResponse
  const text = `${r.msg ?? ''} ${r.message ?? ''}`
  const statusFail = r.status != null && String(r.status) !== '00' && String(r.status) !== '200'
  const codeFail = r.code != null && String(r.code) !== '0' && String(r.code) !== '200'
  return (statusFail || codeFail) && /(失效|过期|重新登录|expire|invalid token)/i.test(text)
}

/** 是否为「学生人脸数据为空，请补充」（getRunBegin 的建档硬门槛，code=="888"） */
export const isFaceNotRegistered = (verdict: MpVerdict): boolean => verdict.code === MP_CODES.faceMissing

/** 是否为「学生未注册」（getLesseeServerByNewDecode，code=="-6001"） */
export const isStudentUnregistered = (verdict: MpVerdict): boolean => verdict.code === MP_CODES.unregistered

/** 组装 Authorization 头值：**无 token 时也必须发** `Bearer null`，否则被鉴权过滤器 401 拦下 */
export function buildBearerValue(token?: string | null): string {
  const trimmed = typeof token === 'string' ? token.trim() : ''
  return `Bearer ${trimmed === '' ? 'null' : trimmed}`
}
