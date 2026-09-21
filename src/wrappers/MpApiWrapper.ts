/**
 * 小程序后端（wxxcx.xtotoro.com）接口封装
 *
 * 与原 App 版 `TotoroApiWrapper` 的本质区别（详见 `_mp-analyze/开跑前实测结论.md`）：
 *   1. **多租户基址**：host 来自 `getSunRunSchoolList` 的 `domainUrl`（存 `schoolBaseUrl`），
 *      共享域 `wxxcx.xtotoro.com` 只是其中一所学校的值 → **不能硬编码**；
 *   2. 鉴权：`Authorization: Bearer <token>`，且**必须始终发送**（无 token 时发 `Bearer null`，
 *      否则被鉴权过滤器 401 拦下）；登录态失效的表现是 `header.bizCode == -199`；
 *   3. 请求体：**明文 JSON**（不加密；App 版用 RSA 私钥加密为 text/plain）；
 *   4. 响应：**没有统一信封**，负载位置逐端点漂移 → 判定/解包一律走 `src/mp/envelope.ts`
 *      + `MP_ENDPOINTS[key].payload`，禁止全局 `body ?? obj ?? data` 兜底。
 *
 * 本文件只负责「请求 + 判定 + 解包」；业务编排（登录链路、跑步流程、页面）待下一轮。
 */
import ky from 'ky'
import {
  MP_ENDPOINTS,
  MP_HOST,
  MP_UPSTREAM_HEADER,
  type MpEndpointKey,
  type MpResponse,
  type MpRunBeginRequest,
  type MpRunBeginResponse,
  type MpSchool,
  type MpScoreDetailRequest,
  type MpScoreRequest,
} from '../mp/types'
import { buildBearerValue, judgeMpResponse, unwrapMpResponse, type MpVerdict } from '../mp/envelope'

/**
 * Nuxt 在 `import.meta` 上注入 `server` / `env`，但**本模块不只被 Nuxt 使用**
 * （server 端点与单测都会 import 它，而后者的 tsconfig 不含 Nuxt 全局类型）。
 * 因此这里**显式声明**，不再隐式依赖 Nuxt 的类型扩充 —— 运行时行为不变。
 */
interface MpImportMeta {
  server?: boolean
  env?: Record<string, string | undefined>
}
const META = import.meta as unknown as MpImportMeta

/** ky 需要绝对 base（相对 prefixUrl 在 Node/undici 下解析失败），与旧 wrapper 同策略 */
const resolvePrefixUrl = (): string => {
  try {
    if (META.server) {
      const internal = process.env.TOTORO_INTERNAL_BASE
      if (internal) return `${internal.replace(/\/$/, '')}/api/mp/`
      const port = process.env.NITRO_PORT || process.env.PORT || '3000'
      const portNum = parseInt(port, 10)
      const safePort = Number.isNaN(portNum) || portNum <= 0 || portNum > 65535 ? '3000' : String(portNum)
      /**
       * ⚠️ 2026-09-20（`ERROR.md` E59）：**自调用地址的地址族必须与服务的绑定一致**。
       * 原来这里写死 `127.0.0.1` —— 服务若只绑 IPv6 回环（`NITRO_HOST=::1`）就会连不上，
       * 与「一键获取 token」那次故障是同一个类（回调/自调用地址与服务地址族不匹配）。
       * 现在按绑定地址推导：`::1` 用 IPv6 字面量；`0.0.0.0` / `::`（所有接口）用 IPv4 回环最稳。
       */
      const boundHost = String(process.env.NITRO_HOST || process.env.HOST || '127.0.0.1').trim()
      const loopback = boundHost === '::1' || boundHost === '[::1]' ? '[::1]' : '127.0.0.1'
      return `http://${loopback}:${safePort}/api/mp/`
    }
    const origin = META.env?.VITE_MP_PROXY_BASE || window.location.origin
    if (!origin || !origin.startsWith('http')) return 'http://localhost:3000/api/mp/'
    return `${origin}/api/mp/`
  } catch {
    return 'http://127.0.0.1:3000/api/mp/'
  }
}

/** 请求选项：token 可显式给，也可走调用方传入的会话 */
export interface MpRequestOptions {
  token?: string | null
  /**
   * 多租户基址（该校 `domainUrl`）。缺省用共享域 `MP_HOST`。
   * 由代理通过 `x-mp-upstream` 头转发到对应学校域名。
   */
  baseUrl?: string
  signal?: AbortSignal
  /** 本次请求的超时（毫秒）。缺省按方法取：GET = 读口径、POST = 写口径（见 `timeoutForMethod`） */
  timeout?: number
}

/** 一次判定的调用结果 */
export interface MpCall<T = unknown> extends MpVerdict {
  /** 按端点规格解包后的业务负载（`payload: 'none'` 的端点为 undefined） */
  data?: T
  /** 原始信封（排错用；可能含 PII，勿入库） */
  raw?: MpResponse
  /**
   * 是否是**超时**导致的失败（2026-09-21 修 issue #11）。
   * ⚠️ 语义是"**结果未知**"：请求可能已经到达服务端并写入成功，只是响应没等到
   * ⇒ 调用方**不要**当成"确定失败"，要去核实（见 `utils/mp/writeOutcome.ts`）。
   */
  timedOut?: boolean
}

/** 传输层失败（非 JSON / 空响应 / 网络异常）→ 统一成 system 判定 */
const transportFailure = (message: string, timedOut = false): MpCall<never> => ({
  ok: false,
  kind: 'system',
  message,
  ...(timedOut ? { timedOut: true } : {}),
})

/** 请求选项：把 baseUrl 变成代理可识别的上游头 */
const buildHeaders = (options: MpRequestOptions): Record<string, string> => {
  const headers: Record<string, string> = {
    // ⚠️ 必须始终带（无 token 时 `Bearer null`）——鉴权过滤器只检查头是否存在
    Authorization: buildBearerValue(options.token),
  }
  if (options.baseUrl) headers[MP_UPSTREAM_HEADER] = options.baseUrl
  return headers
}

/** 低层请求：按端点元数据选 GET/POST，返回原始信封（不抛 HTTP 错误，交给判定层） */
async function rawRequest(
  key: MpEndpointKey,
  body: unknown,
  options: MpRequestOptions,
): Promise<{ raw?: MpResponse; error?: string; timedOut?: boolean }> {
  const meta = MP_ENDPOINTS[key]
  const path = meta.path.replace(/^\//, '')
  const headers = buildHeaders(options)
  /** 读 15 s / 写 30 s（写操作上游实测能到 15.4 s，见 `MP_WRITE_TIMEOUT_MS` 的注释） */
  const timeout = options.timeout ?? timeoutForMethod(meta.method)

  try {
    const response =
      meta.method === 'GET'
        ? await MpApiWrapper.client.get(path, { headers, signal: options.signal, timeout })
        : await MpApiWrapper.client.post(path, { json: body ?? {}, headers, signal: options.signal, timeout })

    const text = await response.text()
    /**
     * ⚠️ **504 必须最先判**（2026-09-21 审计 B5）：504 可能带**空体或非 JSON 体**，
     * 若放在 JSON 解析之后，这种 504 会落进"空响应 / 非 JSON ⇒ 确定失败"，又会诱导用户重试。
     */
    const upstreamTimedOut = response.status === 504
    /**
     * ⚠️ **写操作的"空响应 / 非 JSON 响应"也是"结果未知"**（2026-09-21 审计 B4）：
     * 上游可能**已经写入**，只是回了个空体、或回了一页 HTML（WAF / 网关错误页）。
     * 原先这两条 return 不带 `timedOut` ⇒ 被当成"确定失败" ⇒ 跳过轨迹明细 + 诱导重试 ⇒ 可能多录一条成绩。
     */
    const unknownForWrite = upstreamTimedOut || meta.method !== 'GET'
    if (!text.trim()) {
      return {
        error: upstreamTimedOut
          ? `上游超时（HTTP 504：${meta.method} ${meta.path}）`
          : `空响应（HTTP ${response.status}）`,
        ...(unknownForWrite ? { timedOut: true } : {}),
      }
    }
    let parsed: MpResponse
    try {
      parsed = JSON.parse(text) as MpResponse
    } catch {
      return {
        error: upstreamTimedOut
          ? `上游超时（HTTP 504：${meta.method} ${meta.path}）`
          : `响应不是 JSON（HTTP ${response.status}）`,
        ...(unknownForWrite ? { timedOut: true } : {}),
      }
    }
    /**
     * ⚠️ **HTTP 504 也按"超时/结果未知"处理**（2026-09-21 修 issue #11）：
     * 504 来自①本机代理等上游等到 `UPSTREAM_TIMEOUT_MS` 后放弃，或②上游网关自己超时 ——
     * 两种情况都只是"**我们没等到答复**"，**不等于上游没写入**。
     * 文案优先用对方给的可读原因（代理写的是中文）。
     */
    if (upstreamTimedOut) {
      const reason = String((parsed as { statusMessage?: unknown }).statusMessage ?? '').trim()
      return {
        error: reason || `上游超时（HTTP 504：${meta.method} ${meta.path}）`,
        timedOut: true,
      }
    }
    return { raw: parsed }
  } catch (err) {
    /**
     * ⚠️ 2026-09-21 修 issue #11：**超时要单独标出来**。
     * 超时的语义是"**结果未知**"（请求可能已经写入服务端，只是响应没等到）——
     * 原先它和"网络断了"共用一条 `system` 失败路径，导致 `submit.ts` 把"晚到 404 毫秒的成功"当成失败，
     * 于是跳过轨迹明细、还诱导用户重试。文案也换成中文并把方法/端点/秒数写清楚（英文的
     * `Request timed out: POST http://…` 对用户毫无信息量）。
     */
    if (isTimeoutError(err)) {
      return {
        error: `请求超时：${Math.round(timeout / 1000)} 秒内未收到响应（${meta.method} ${meta.path}）`,
        timedOut: true,
      }
    }
    return { error: await describeTransportError(err) }
  }
}

/**
 * 把传输层异常转成**给人看的中文原因**。
 *
 * ⚠️ 2026-09-19 自查补上：`ky` 对非 2xx 抛的是 `HTTPError`，其 `message` 是英文的
 * `Request failed with status code 504` —— 而我们在服务端辛苦写的中文原因
 * （例如代理超时那条"上游 20 秒无响应（网络/校方接口慢或不通）——请稍后重试"）
 * **用户根本看不到**。这里改成优先读响应体里的 `statusMessage`/`message`。
 * 判据：**服务端给出的可读原因必须能穿到界面上**，否则等于白写。
 */
async function describeTransportError(err: unknown): Promise<string> {
  const fallback = err instanceof Error ? err.message : '请求失败'
  const response = (err as { response?: Response })?.response
  if (!response) return fallback
  try {
    const body = await response.clone().text()
    let reason = ''
    try {
      const j = JSON.parse(body) as Record<string, unknown>
      reason = String(j.statusMessage ?? j.message ?? '')
    } catch {
      reason = body.slice(0, 160)
    }
    reason = reason.replace(/\s+/g, ' ').trim()
    return reason ? `HTTP ${response.status}：${reason}` : `HTTP ${response.status}：${fallback}`
  } catch {
    return `HTTP ${response.status}：${fallback}`
  }
}

// ---------- 多租户基址解析（免鉴权，可在拿到 token 之前调用） ----------

/** 学校清单缓存（同一个进程内复用；清单很短且极少变动） */
const schoolListCache = { at: 0, list: [] as MpSchool[] }
const SCHOOL_LIST_TTL_MS = 30 * 60 * 1000

/**
 * ⚠️ **写操作绝不重试**（接线契约，有单测 `tests/mp/wrapper.test.ts`）：
 *   ky 默认会对 POST 重试 → 提交成绩 / 申诉 / 人脸建档这类**非幂等写操作**可能被重复提交。
 *   这里只允许 `get`（读操作幂等）。
 *
 * ⚠️ **已知例外（显式记录，勿误以为"GET 都安全"）**：`unBindInfo`（解绑账号）**用 GET 表达**，
 *   因此它**会被**这条 retry 规则重试。我们只在用户明确登出时调用它，风险低；
 *   单测里把这个事实**固定住**，防止有人据此推断"GET 一定只读"。
 */
export const MP_RETRY_CONFIG: { limit: number; methods: ['get'] } = { limit: 1, methods: ['get'] }

/**
 * 超时口径（**2026-09-21 修 GitHub issue #11**）：
 * - **读**：15 秒 —— 上游读接口实测都在 100~300 ms 量级，足够；
 * - **写**：30 秒 —— 实测厂商 `sunRunExercises` **正常就能跑 14.8~15.4 秒**
 *   （09-18 我们实测「服务端处理 14.8 秒」；09-21 用户实测日志 `ms:15404`）。
 *   原先读写共用一个 15 秒 ⇒ **余量只剩 0.2~0.4 秒**，于是必然出现"响应刚到、客户端已放弃"的假报错：
 *   界面说失败、**轨迹明细被跳过**，而成绩其实已经入库。
 * 判据：**写操作的超时必须大于上游最慢耗时的实测上界**（留约 2 倍余量）。
 */
export const MP_READ_TIMEOUT_MS = 15000
export const MP_WRITE_TIMEOUT_MS = 30000
export const timeoutForMethod = (method: 'GET' | 'POST'): number =>
  method === 'GET' ? MP_READ_TIMEOUT_MS : MP_WRITE_TIMEOUT_MS

/**
 * 是不是"超时"这一类异常（ky 抛 `TimeoutError`；少数环境抛带 `ETIMEDOUT` 的错误）。
 * 判据：**超时必须能被单独识别** —— 它的语义是"**结果未知**"而不是"失败"
 * （见 `utils/mp/writeOutcome.ts`：超时后要去服务端核实，绝不能诱导用户重试）。
 */
export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: unknown; code?: unknown }
  return e.name === 'TimeoutError' || e.code === 'ETIMEDOUT'
}

export const MpApiWrapper = {
  client: ky.create({
    prefixUrl: resolvePrefixUrl(),
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
    },
    timeout: MP_READ_TIMEOUT_MS,
    retry: MP_RETRY_CONFIG,
    // HTTP 错误码也交给判定层（后端用业务码而非 HTTP 状态表达失败）
    throwHttpErrors: false,
  }),

  /** 低层：按端点元数据发请求，返回原始信封 */
  async request(key: MpEndpointKey, data?: unknown, options: MpRequestOptions = {}): Promise<MpResponse | undefined> {
    return (await rawRequest(key, data, options)).raw
  },

  /**
   * 判定式请求（**推荐入口**）：请求 + 双信封判定 + 按端点规格解包。
   * 调用方只需看 `ok / kind / message / data`。
   */
  async call<T = unknown>(key: MpEndpointKey, data?: unknown, options: MpRequestOptions = {}): Promise<MpCall<T>> {
    const meta = MP_ENDPOINTS[key]
    const { raw, error, timedOut } = await rawRequest(key, data, options)
    if (!raw) return transportFailure(error || '请求失败', timedOut)

    const verdict = judgeMpResponse(raw, meta.payload)
    const payload = unwrapMpResponse<T>(raw, meta.payload)
    return { ...verdict, data: payload, raw }
  },

  // ---------- 多租户 / 登录链路 ----------

  /** 学校清单（免鉴权；**固定走共享域**——源码里这个 URL 是硬编码的） */
  async fetchSchoolList(options: Omit<MpRequestOptions, 'baseUrl'> = {}): Promise<MpCall<MpSchool[]>> {
    return this.call<MpSchool[]>('schoolList', {}, options)
  },

  /**
   * 按 `schoolCode` 解析该校 API 基址（= `domainUrl`，即源码里的 `schoolBaseUrl`）。
   * 命中缓存则不重复请求；清单拉取失败返回 undefined（调用方可回落共享域）。
   */
  async resolveSchoolBaseUrl(schoolCode: string, options: Omit<MpRequestOptions, 'baseUrl'> = {}): Promise<string | undefined> {
    const now = Date.now()
    if (schoolListCache.list.length === 0 || now - schoolListCache.at > SCHOOL_LIST_TTL_MS) {
      const res = await this.fetchSchoolList(options)
      if (!res.ok || !Array.isArray(res.data)) return undefined
      schoolListCache.list = res.data
      schoolListCache.at = now
    }
    const school = schoolListCache.list.find((item) => String(item.schoolCode) === String(schoolCode))
    return school?.domainUrl || undefined
  },

  /** 清空学校清单缓存（换校/排错时用） */
  clearSchoolListCache(): void {
    schoolListCache.list = []
    schoolListCache.at = 0
  },

  /** 首配置（免鉴权，决定登录方式：`obj.studentNameLoginType == 1` = 姓名登录） */
  async getSunRunFirstConfiguration(schoolCode: string) {
    return this.call<{ studentNameLoginType?: number | string }>('firstConfiguration', { schoolCode })
  },

  /** 微信 code 换 token：**token 在响应顶层** `res.token` */
  async lesseeServerByNewDecode(code: string, options: MpRequestOptions = {}) {
    return this.call<MpResponse & { token?: string }>('lesseeServerByNewDecode', { code }, options)
  },

  /** 学生档案（`obj.schoolCampusCode` 即 `getSunrunPaper` 必需的 `campusId`） */
  async getStudentInfoByToken(options: MpRequestOptions = {}) {
    return this.call<Record<string, unknown>>('studentInfoByToken', undefined, options)
  },

  /**
   * 解绑 / 登出。
   * ⚠️ **写操作**：真会解绑账号（探针曾误触，见 `ERROR.md` E21）。
   * 只在用户明确要求登出时调用，绝不在探活/遍历里调。
   */
  async unbindInfo(options: MpRequestOptions = {}) {
    return this.call('unBindInfo', undefined, options)
  },

  // ---------- 任务 / 学期 / 归档 ----------

  /** 任务与路线（**必须带 campusId**，否则必报「该校区阳光跑任务未设置」） */
  async getSunrunPaper(
    params: { stuNumber: string; campusId: string; token?: string },
    options: MpRequestOptions = {},
  ) {
    return this.call<Record<string, unknown>>('sunrunPaper', { ...params }, options)
  },

  async getSunrunPaperList(params: { stuNumber: string; snCode: string }, options: MpRequestOptions = {}) {
    return this.call<Record<string, unknown>[]>('sunrunPaperList', { ...params }, options)
  },

  // ---------- 早操签到（**只读**；不实现提交，理由见 `MpMornSignTask` 的注释） ----------

  /**
   * 早操签到任务 + 点位表。
   * ⚠️ body 需要 `stuNumber`（学号）**和** `token` 两个字段（实测口径，第三方源码同）。
   * ⚠️ **"本学校无需签到"是正常返回**（`message` 有值 + `signPointList: null`）；
   *    判定与归一化交给 `utils/mp/morningSign.ts` 的纯函数，这里只负责发请求。
   */
  async getMornSignPaper(params: { stuNumber: string; token?: string }, options: MpRequestOptions = {}) {
    return this.call<Record<string, unknown>>('mornSignPaper', { ...params }, options)
  },

  /**
   * 早操签到记录（只读：`scoreList` / `completedTimes`）。
   * ⚠️ **当前无消费者**（页面没做"签到历史"，2026-09-18 审计指出）—— 保留是为了让"早操签到"这块的
   *    只读能力成体系（任务/点位/记录），将来要加历史页时直接可用；**它不是写端点**，无副作用。
   */
  async getMornSignArchDetail(params: { stuNumber: string; token?: string }, options: MpRequestOptions = {}) {
    return this.call<Record<string, unknown>>('mornSignArchDetail', { ...params }, options)
  },


  async getSchoolTerm(options: MpRequestOptions = {}) {
    return this.call<{ id?: string; name?: string }>('schoolTerm', {}, options)
  },

  async getTermList(options: MpRequestOptions = {}) {
    return this.call<Record<string, unknown>[]>('termList', {}, options)
  },

  async getSchoolMonthByTerm(options: MpRequestOptions = {}) {
    return this.call<Record<string, unknown>[]>('schoolMonthByTerm', {}, options)
  },

  async getSunrunArch(
    params: {
      projectName?: string
      monthId?: string
      termId?: string
      paperId?: string
      stuNumber?: string
      snCode?: string
      pageNumber?: number
      rowNumber?: number
    },
    options: MpRequestOptions = {},
  ) {
    return this.call<MpResponse>('sunrunArch', { projectName: '阳光跑', ...params }, options)
  },

  async getSunrunArchDetail(scoreId: string, options: MpRequestOptions = {}) {
    return this.call<{ pointList?: { latitude: number; longitude: number }[] }>('sunrunArchDetail', { scoreId }, options)
  },

  // ---------- 跑步主流程 ----------

  /** 开始跑步：成功 → 顶层 `scantronId`；未建档 → `code:"888"`（见 `isFaceNotRegistered`） */
  async getRunBegin(body: MpRunBeginRequest, options: MpRequestOptions = {}) {
    return this.call<MpRunBeginResponse>('runBegin', body, options)
  },

  /** 提交成绩（18 字段，见 `MpScoreRequest`） */
  async saveScores(body: MpScoreRequest, options: MpRequestOptions = {}) {
    return this.call('saveScores', body, options)
  },

  /** 提交轨迹明细（必须在 `saveScores` 成功之后） */
  async saveScoreDetail(body: MpScoreDetailRequest, options: MpRequestOptions = {}) {
    return this.call('saveScoreDetail', body, options)
  },

  /** 过点信息（轮询；`sunRunStatus == 0` 表示成绩无效） */
  async getRunPointList(scantronId: string, options: MpRequestOptions = {}) {
    return this.call<Record<string, unknown>>('runPointList', { scantronId }, options)
  },

  // ---------- 配置 / 人脸 ----------

  /** 跑步开关配置：`{sunrunPointShowOff, sunrunStartFace, sunrunPointRandom}`（"1" = 开启） */
  async getSunRunStartConfiguration(snCode: string, options: MpRequestOptions = {}) {
    return this.call<Record<string, string>>('sunRunStartConfiguration', { snCode }, options)
  },

  async getSunRunRandomConfiguration(lineId: string, options: MpRequestOptions = {}) {
    return this.call<Record<string, string>>('sunRunRandomConfiguration', { lineId }, options)
  },

  /** 人脸比对（开场/抽查共用入口的前置校验） */
  async checkFace(faceData: string, options: MpRequestOptions = {}) {
    return this.call<Record<string, unknown>>('faceCheck', { faceData }, options)
  },

  /** ⚠️ 人脸建档（写操作；学生本人一次性动作） */
  async checkFaceSave(baseFace: string, extra: Record<string, unknown> = {}, options: MpRequestOptions = {}) {
    return this.call('faceCheckSave', { baseFace, ...extra }, options)
  },

  /** 随机抽查：服务端是否要求本次打卡（`body` 为 "1" 时需拍脸） */
  async selectFaceMiddleStatus(
    body: { totalRun: string | number; snCode: string; scantronId: string },
    options: MpRequestOptions = {},
  ) {
    return this.call<Record<string, unknown>>('faceMiddleStatus', body, options)
  },

  /** 抽查上报（手机打卡） */
  async submitPhoneCheck(body: { faceBase64: string; scantronId: string }, options: MpRequestOptions = {}) {
    return this.call('submitshoujidaka', body, options)
  },
}

/** 便捷：默认共享域基址（`header.bizCode == -199` 时可用于回落重登） */
export const MP_DEFAULT_BASE_URL = MP_HOST
