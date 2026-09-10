/**
 * 小程序后端（wxxcx.xtotoro.com）接口封装
 *
 * 与原 App 版 `TotoroApiWrapper` 的本质区别（详见 `_mp-analyze/小程序逆向分析.md`）：
 *   1. 域名：`wxxcx.xtotoro.com`（路径前缀 `/wxxcx`）
 *   2. 鉴权：`Authorization: Bearer <token>`
 *   3. 请求体：**明文 JSON**（不加密；App 版用 RSA 私钥加密为 text/plain）
 *   4. 成功判定：`status === '00'` 或 `code === 0`
 *
 * ⚠️ 当前状态：字段与路径来自**源码逆向**，尚未经真实抓包验证。
 *    抓包后重点核对（见 `_mp-analyze/疑难与决策清单.md` Q1–Q8）：
 *      - 是否有额外签名 header
 *      - `sunRunExercises` 必填字段全集
 *      - 时间字段格式（是否 T 分隔 / 带时区）
 */
import ky from 'ky'
import {
  MP_ENDPOINTS,
  type MpResponse,
  type MpRunBeginRequest,
  type MpRunBeginResponse,
  type MpScoreDetailRequest,
  type MpScoreRequest,
  type MpSession,
} from '../mp/types'

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

/** 请求选项：token 可显式给，也可走客户端本地存储兜底 */
export interface MpRequestOptions {
  token?: string
  signal?: AbortSignal
}

/** 判定小程序后端是否成功 */
export function isMpOk(res: MpResponse | undefined | null): boolean {
  if (!res) return false
  if (typeof res.status === 'string') return res.status === '00'
  if (res.code !== undefined) return String(res.code) === '0' || res.code === 0
  return false
}

/** 取业务数据体（不同接口分别放在 body / obj / data） */
export function mpPayload<T>(res: MpResponse<T> | undefined | null): T | undefined {
  if (!res) return undefined
  return (res.body ?? res.obj ?? res.data) as T | undefined
}

/** 拼接手机信息（对齐源码 phoneInfo 字段；源码 operator 优先级疑似有 bug，TODO(verify)） */
export function buildPhoneInfo(brand: string, model: string, system: string): string {
  return [brand, model, system].filter(Boolean).join('&')
}

export const MpApiWrapper = {
  client: ky.create({
    prefixUrl: resolvePrefixUrl(),
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
    },
    timeout: 15000,
    retry: { limit: 2, methods: ['post', 'get'] },
  }),

  /** 统一请求入口：注入 Bearer，POST 明文 JSON */
  async post<T = unknown>(endpoint: string, data: unknown, options: MpRequestOptions = {}): Promise<MpResponse<T>> {
    const headers: Record<string, string> = {}
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    return this.client
      .post(endpoint.replace(/^\//, ''), {
        json: data ?? {},
        headers,
        signal: options.signal,
      })
      .json() as Promise<MpResponse<T>>
  },

  /** GET 请求 */
  async get<T = unknown>(endpoint: string, options: MpRequestOptions = {}): Promise<MpResponse<T>> {
    const headers: Record<string, string> = {}
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    return this.client
      .get(endpoint.replace(/^\//, ''), { headers, signal: options.signal })
      .json() as Promise<MpResponse<T>>
  },

  // ---------- 平台 / 登录 ----------

  /** 微信登录换服务列表（入参为 wx.login() 的 code） */
  async getLesseeServerByNewDecode(code: string, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.lesseeServerByNewDecode, { code }, options)
  },

  /** 解绑 / 登出 */
  async unbindInfo(options?: MpRequestOptions) {
    return this.get(MP_ENDPOINTS.unbindInfo, options)
  },

  /** 首配置（决定登录方式：是否需要短信验证码） */
  async getSunRunFirstConfiguration(schoolCode: string, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.firstConfiguration, { schoolCode }, options)
  },

  // ---------- 跑步主流程 ----------

  /** 开始跑步：返回 scantronId（提交成绩的必需 ID） */
  async getRunBegin(body: MpRunBeginRequest, options?: MpRequestOptions): Promise<MpRunBeginResponse> {
    return this.post<unknown>(MP_ENDPOINTS.runBegin, body, options) as Promise<MpRunBeginResponse>
  },

  /** 提交成绩 */
  async saveScores(body: MpScoreRequest, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.saveScores, body, options)
  },

  /** 提交轨迹明细 */
  async saveScoreDetail(body: MpScoreDetailRequest, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.saveScoreDetail, body, options)
  },

  /** 打卡点列表 */
  async getRunPointList(scantronId: string, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.runPointList, { scantronId }, options)
  },

  // ---------- 归档 / 查询 ----------

  async getSchoolTerm(schoolId: string, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.schoolTerm, { schoolId }, options)
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
    options?: MpRequestOptions,
  ) {
    return this.post(MP_ENDPOINTS.sunrunArch, { projectName: '阳光跑', ...params }, options)
  },

  async getSunrunArchDetail(scoreId: string, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.sunrunArchDetail, { scoreId }, options)
  },

  // ---------- 人脸 / 抽查 ----------

  /** 开场人脸是否开启等配置 */
  async getSunRunStartConfiguration(snCode: string, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.sunRunStartConfiguration, { snCode }, options)
  },

  /** 人脸比对 */
  async checkFace(faceData: string, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.faceCheck, { faceData }, options)
  },

  /** 人脸建档 */
  async checkFaceSave(baseFace: string, extra: Record<string, unknown> = {}, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.faceCheckSave, { baseFace, ...extra }, options)
  },

  /** 随机抽查：服务端是否要求本次打卡 */
  async selectFaceMiddleStatus(
    body: { totalRun: string; snCode: string; scantronId: string },
    options?: MpRequestOptions,
  ) {
    return this.post(MP_ENDPOINTS.faceMiddleStatus, body, options)
  },

  /** 随机抽查上报 */
  async submitPhoneCheck(body: { faceBase64: string; scantronId: string }, options?: MpRequestOptions) {
    return this.post(MP_ENDPOINTS.submitPhoneCheck, body, options)
  },
}

/** 便捷：从会话取 token 发起请求 */
export const mpFetchWithSession = <T>(
  session: MpSession | null | undefined,
  fn: (options: MpRequestOptions) => Promise<T>,
): Promise<T> => fn({ token: session?.token })
