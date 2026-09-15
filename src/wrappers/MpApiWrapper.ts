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

/** ky 需要绝对 base（相对 prefixUrl 在 Node/undici 下解析失败），与旧 wrapper 同策略 */
const resolvePrefixUrl = (): string => {
  try {
    if (import.meta.server) {
      const internal = process.env.TOTORO_INTERNAL_BASE
      if (internal) return `${internal.replace(/\/$/, '')}/api/mp/`
      const port = process.env.NITRO_PORT || process.env.PORT || '3000'
      const portNum = parseInt(port, 10)
      if (Number.isNaN(portNum) || portNum <= 0 || portNum > 65535) return 'http://127.0.0.1:3000/api/mp/'
      return `http://127.0.0.1:${portNum}/api/mp/`
    }
    const origin = (import.meta as { env?: Record<string, string> }).env?.VITE_MP_PROXY_BASE || window.location.origin
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
}

/** 一次判定的调用结果 */
export interface MpCall<T = unknown> extends MpVerdict {
  /** 按端点规格解包后的业务负载（`payload: 'none'` 的端点为 undefined） */
  data?: T
  /** 原始信封（排错用；可能含 PII，勿入库） */
  raw?: MpResponse
}

/** 传输层失败（非 JSON / 空响应 / 网络异常）→ 统一成 system 判定 */
const transportFailure = (message: string): MpCall<never> => ({ ok: false, kind: 'system', message })

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
): Promise<{ raw?: MpResponse; error?: string }> {
  const meta = MP_ENDPOINTS[key]
  const path = meta.path.replace(/^\//, '')
  const headers = buildHeaders(options)

  try {
    const response =
      meta.method === 'GET'
        ? await MpApiWrapper.client.get(path, { headers, signal: options.signal })
        : await MpApiWrapper.client.post(path, { json: body ?? {}, headers, signal: options.signal })

    const text = await response.text()
    if (!text.trim()) return { error: `空响应（HTTP ${response.status}）` }
    try {
      return { raw: JSON.parse(text) as MpResponse }
    } catch {
      return { error: `响应不是 JSON（HTTP ${response.status}）` }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : '请求失败' }
  }
}

// ---------- 多租户基址解析（免鉴权，可在拿到 token 之前调用） ----------

/** 学校清单缓存（同一个进程内复用；清单很短且极少变动） */
const schoolListCache = { at: 0, list: [] as MpSchool[] }
const SCHOOL_LIST_TTL_MS = 30 * 60 * 1000

export const MpApiWrapper = {
  client: ky.create({
    prefixUrl: resolvePrefixUrl(),
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
    },
    timeout: 15000,
    // ⚠️ ky 默认会对 POST 重试 → 写操作（提交成绩/申诉/建档）可能被重复提交。
    //    这里只对 GET 重试一次（读操作幂等）。
    retry: { limit: 1, methods: ['get'] },
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
    const { raw, error } = await rawRequest(key, data, options)
    if (!raw) return transportFailure(error || '请求失败')

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
