import ky from 'ky'
import { encryptRequestContent } from '../utils/encryptRequestContent'
import { ApiError, FreeRunErrorHandler, NetworkError } from '../classes/FreeRunErrorHandler'

/** 龙猫校园通用返回 */
export interface TotoroResponse<T = unknown> {
  status?: string
  code?: string
  message?: string
  data?: T
  ifHasRun?: string
  [key: string]: unknown
}

/** 基础请求参数（登录后取得） */
export interface BasicReq {
  token?: string
  stuNumber?: string
  schoolId?: string
  campusId?: string
  [key: string]: unknown
}

/** 自由跑提交参数 */
export interface FreeRunData {
  startTime: string
  endTime: string
  duration: number
  distance: number
  avgSpeed: number
  steps?: number
  mac?: string
  deviceInfo?: string
  routeId?: string
  taskId?: string
  stuNumber: string
  token: string
}

export interface BatchRunOptions {
  concurrency?: number
  delayMs?: number
}

export interface BatchRunResult {
  index: number
  success: boolean
  recordId?: string
  error?: string
}

export interface BatchSubmitResult {
  totalSubmitted: number
  successCount: number
  failureCount: number
  results: BatchRunResult[]
}

export interface FreeRunRecord {
  recordId: string
  distance: string
  duration: string
  calorie: string
  avgSpeed: string
  steps?: string
  startTime: string
  endTime: string
  evaluateDate?: string
  status?: string
  mac?: string
  phoneInfo?: string
  routeId?: string
  runType?: string
  usedTime?: string
  [key: string]: unknown
}

const APP_VERSION = '1.2.14'
const DEVICE_TYPE = '2'

/**
 * ky 需要绝对 base（相对 prefixUrl 在 Node/undici 下解析失败）
 * - 浏览器：指向本机 Nitro 的 /api/totoro 通用代理
 * - 服务器：回环到本地代理（可用 TOTORO_INTERNAL_BASE 覆盖，默认 127.0.0.1:3000）
 */
const resolvePrefixUrl = (): string => {
  if (import.meta.server) {
    const internal = process.env.TOTORO_INTERNAL_BASE
    if (internal) return `${internal.replace(/\/$/, '')}/api/totoro/`
    const port = process.env.PORT || process.env.NITRO_PORT || '3000'
    return `http://127.0.0.1:${port}/api/totoro/`
  }
  const origin = import.meta.env?.VITE_TOTORO_PROXY_BASE || window.location.origin
  return `${origin}/api/totoro/`
}

/**
 * 龙猫校园 App 接口封装（与原版行为一致）
 * - 所有请求体先用内置 RSA 私钥按 pkcs1 加密为文本
 * - ky prefixUrl 指向本地 Nitro 的 /api/totoro 通用代理
 * - 断网/超时/5xx 自动指数退避重试
 */
export const TotoroApiWrapper = {
  client: ky.create({
    prefixUrl: resolvePrefixUrl(),
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Host': 'app.xtotoro.com',
      'Connection': 'Keep-Alive',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'okhttp/4.9.0',
    },
  }),

  errorHandler: new FreeRunErrorHandler(),

  // ---------- 登录 / 平台 ----------

  async getRegisterUrl(): Promise<TotoroResponse> {
    return this.client.post('platform/serverlist/getRegisterUrl').json() as Promise<TotoroResponse>
  },

  async getLesseeServer(code: string): Promise<TotoroResponse> {
    return this.client
      .post('platform/serverlist/getLesseeServer', { body: encryptRequestContent({ code }) })
      .json() as Promise<TotoroResponse>
  },

  async getAppAd(code: string): Promise<TotoroResponse> {
    return this.client
      .post('platform/serverlist/getAppAd', { body: encryptRequestContent({ code }) })
      .json() as Promise<TotoroResponse>
  },

  async login({ token }: { token: string }): Promise<TotoroResponse> {
    return this.client
      .post('platform/login/login', {
        body: encryptRequestContent({
          code: '',
          latitude: '',
          loginWay: '',
          longitude: '',
          password: '',
          phoneNumber: '',
          token,
        }),
      })
      .json() as Promise<TotoroResponse>
  },

  async getAppSlogan(req: unknown): Promise<TotoroResponse> {
    return this.client
      .post('platform/serverlist/getAppSlogan', { body: encryptRequestContent(req) })
      .json() as Promise<TotoroResponse>
  },

  async getAppFrontPage(req: unknown): Promise<TotoroResponse> {
    return this.client
      .post('platform/login/getAppFrontPage', { body: encryptRequestContent(req) })
      .json() as Promise<TotoroResponse>
  },

  async updateAppVersion(breq: BasicReq): Promise<TotoroResponse> {
    const req = {
      campusId: breq.campusId,
      schoolId: breq.schoolId,
      token: breq.token,
      version: APP_VERSION,
      deviceType: DEVICE_TYPE,
      stuNumber: breq.stuNumber,
    }
    return this.client
      .post('platform/serverlist/updateAppVersion', { body: encryptRequestContent(req) })
      .json() as Promise<TotoroResponse>
  },

  async getAppNotice(req: unknown): Promise<TotoroResponse> {
    return this.client
      .post('platform/serverlist/getAppNotice', {
        body: encryptRequestContent({ ...(req as object), version: '' }),
      })
      .json() as Promise<TotoroResponse>
  },

  // ---------- 阳光跑 ----------

  async getSunRunPaper(req: unknown): Promise<TotoroResponse> {
    return this.client
      .post('sunrun/getSunrunPaper', { body: encryptRequestContent(req) })
      .json() as Promise<TotoroResponse>
  },

  async getRunBegin(req: unknown): Promise<TotoroResponse> {
    return await this.client
      .post('sunrun/getRunBegin', { body: encryptRequestContent(req) })
      .json() as Promise<TotoroResponse>
  },

  async sunRunExercises(req: unknown): Promise<TotoroResponse> {
    return this.client
      .post('platform/recrecord/sunRunExercises', { body: encryptRequestContent(req) })
      .json() as Promise<TotoroResponse>
  },

  async sunRunExercisesDetail(data: {
    pointList: unknown[]
    scantronId: string
    breq: BasicReq
  }): Promise<TotoroResponse> {
    const req = {
      pointList: data.pointList,
      scantronId: data.scantronId,
      stuNumber: data.breq.stuNumber,
      token: data.breq.token,
    }
    // 注意：此接口原版用 json（未加密）
    return this.client.post('platform/recrecord/sunRunExercisesDetail', { json: req }).json() as Promise<TotoroResponse>
  },

  async getSchoolTerm(breq: BasicReq): Promise<TotoroResponse> {
    const req = { schoolId: breq.schoolId, token: breq.token }
    return this.client
      .post('platform/course/getSchoolTerm', { body: encryptRequestContent(req) })
      .json() as Promise<TotoroResponse>
  },

  async getSchoolMonthByTerm(termId: string, breq: BasicReq): Promise<TotoroResponse> {
    const req = {
      schoolId: breq.schoolId,
      stuNumber: breq.stuNumber,
      token: breq.token,
      termId,
    }
    return this.client
      .post('platform/course/getSchoolMonthByTerm', { body: encryptRequestContent(req) })
      .json() as Promise<TotoroResponse>
  },

  async getSunRunArch(monthId: string, termId: string, breq: BasicReq): Promise<TotoroResponse> {
    const req = { ...breq, runType: '0', monthId, termId }
    return this.client
      .post('sunrun/getSunrunArch', { body: encryptRequestContent(req) })
      .json() as Promise<TotoroResponse>
  },

  async getSunRunArchDetail(scoreId: string, breq: BasicReq): Promise<TotoroResponse> {
    const req = { scoreId, token: breq.token }
    return this.client
      .post('sunrun/getSunrunArchDetail', { body: encryptRequestContent(req) })
      .json() as Promise<TotoroResponse>
  },

  // ---------- 自由跑 ----------

  async submitFreeRun(data: FreeRunData): Promise<TotoroResponse> {
    return this.errorHandler.handleApiCall(async () => {
      try {
        const startDate = new Date(data.startTime)
        const endDate = new Date(data.endTime)
        const formatTime = (date: Date) => {
          const hours = date.getHours().toString().padStart(2, '0')
          const minutes = date.getMinutes().toString().padStart(2, '0')
          const seconds = date.getSeconds().toString().padStart(2, '0')
          return `${hours}:${minutes}:${seconds}`
        }
        const formatDateTime = (date: Date) => {
          const year = date.getFullYear()
          const month = (date.getMonth() + 1).toString().padStart(2, '0')
          const day = date.getDate().toString().padStart(2, '0')
          return `${year}-${month}-${day} ${formatTime(date)}`
        }
        const durationSeconds = parseInt(String(data.duration), 10)
        const hours = Math.floor(durationSeconds / 3600)
        const minutes = Math.floor((durationSeconds % 3600) / 60)
        const seconds = durationSeconds % 60
        const usedTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`

        const routeId = data.routeId || 'freerun_' + Date.now()
        const taskId = data.taskId || 'freerun_task_' + Date.now()

        const fullRequest = {
          LocalSubmitReason: '',
          avgSpeed: data.avgSpeed,
          baseStation: '',
          endTime: formatTime(endDate), // HH:mm:ss
          evaluateDate: formatDateTime(endDate), // yyyy-MM-dd HH:mm:ss
          fitDegree: '1',
          flag: '1',
          headImage: '',
          ifLocalSubmit: '0',
          km: data.distance,
          mac: data.mac || '',
          phoneInfo: data.deviceInfo || '$CN11/iPhone15,4/17.4.1',
          phoneNumber: '',
          pointList: '',
          routeId,
          runType: '1', // '1' = 自由跑/累计跑步（独立于阳光跑）
          sensorString: '',
          startTime: formatTime(startDate), // HH:mm:ss
          steps: data.steps || 0,
          stuNumber: data.stuNumber,
          taskId,
          token: data.token,
          usedTime,
          version: APP_VERSION,
          warnFlag: '0',
          warnType: '',
          faceData: '',
        }

        const response = await this.client
          .post('platform/recrecord/sunRunExercises', {
            body: encryptRequestContent(fullRequest),
          })
          .json() as TotoroResponse
        if (response.status !== '00' && response.message) {
          throw new ApiError(response.message, response.code || 'API_ERROR')
        }
        return response
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes('401')) {
            throw new ApiError('认证失败，请重新登录', 'INVALID_TOKEN', 401)
          } else if (error.message.includes('400')) {
            throw new ApiError('请求参数错误', 'INVALID_PARAMS', 400)
          } else if (error.message.includes('500')) {
            throw new ApiError('服务器内部错误', 'SERVER_ERROR', 500)
          } else if (error.message.includes('timeout') || error.message.includes('fetch')) {
            throw new NetworkError(error.message)
          }
        }
        throw error
      }
    }, 'submitFreeRun')
  },

  async getFreeRunRecords(
    breq: BasicReq,
    filters?: { startDate?: string; endDate?: string; limit?: number },
  ): Promise<{ data: FreeRunRecord[] }> {
    return this.errorHandler.handleApiCall(async () => {
      const req = {
        ...breq,
        runType: '1', // 自由跑标识
        ...filters,
      }
      try {
        const response = await this.client
          .post('platform/recrecord/getFreeRunRecords', { body: encryptRequestContent(req) })
          .json() as TotoroResponse<FreeRunRecord[]>
        if (response.status !== '00' && response.message) {
          throw new ApiError(response.message, response.code || 'API_ERROR')
        }
        return { data: response.data || [] }
      } catch (error) {
        if (error instanceof Error && error.message.includes('401')) {
          throw new ApiError('认证失败，请重新登录', 'INVALID_TOKEN', 401)
        }
        throw error
      }
    }, 'getFreeRunRecords')
  },

  async getFreeRunDetail(recordId: string, breq: BasicReq): Promise<{ data: FreeRunRecord }> {
    return this.errorHandler.handleApiCall(async () => {
      const req = { recordId, token: breq.token }
      try {
        const response = await this.client
          .post('platform/recrecord/getFreeRunDetail', { body: encryptRequestContent(req) })
          .json() as TotoroResponse<FreeRunRecord>
        if (response.status !== '00' && response.message) {
          throw new ApiError(response.message, response.code || 'API_ERROR')
        }
        if (!response.data) {
          throw new ApiError('记录不存在或已被删除', 'RECORD_NOT_FOUND', 404)
        }
        return { data: response.data }
      } catch (error) {
        if (error instanceof Error && error.message.includes('401')) {
          throw new ApiError('认证失败，请重新登录', 'INVALID_TOKEN', 401)
        }
        throw error
      }
    }, 'getFreeRunDetail')
  },

  async submitBatchRuns(dataList: FreeRunData[], options?: BatchRunOptions): Promise<BatchSubmitResult> {
    return this.errorHandler.handleApiCall(async () => {
      const concurrency = options?.concurrency || 3
      const delayMs = options?.delayMs || 1000
      const results: BatchRunResult[] = []
      let successCount = 0
      let failureCount = 0

      for (let i = 0; i < dataList.length; i += concurrency) {
        const batch = dataList.slice(i, i + concurrency)
        const batchPromises = batch.map(async (data, batchIndex) => {
          const globalIndex = i + batchIndex
          try {
            if (globalIndex > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs))
            }
            const response = await this.submitFreeRun(data)
            if (response.data) {
              successCount++
              return {
                index: globalIndex,
                success: true,
                recordId: (response.data as { recordId: string }).recordId,
              } as BatchRunResult
            } else {
              failureCount++
              return { index: globalIndex, success: false, error: 'No data returned from server' } as BatchRunResult
            }
          } catch (error) {
            failureCount++
            const errorHandler = new FreeRunErrorHandler()
            let errorMessage = 'Unknown error'
            if (error instanceof ApiError) {
              errorMessage = errorHandler.handleApiError(error).message
            } else if (error instanceof NetworkError) {
              errorMessage = errorHandler.handleNetworkError(error).message
            } else if (error instanceof Error) {
              errorMessage = error.message
            }
            return { index: globalIndex, success: false, error: errorMessage } as BatchRunResult
          }
        })
        const batchResults = await Promise.all(batchPromises)
        results.push(...batchResults)
      }

      return {
        totalSubmitted: dataList.length,
        successCount,
        failureCount,
        results,
      }
    }, 'submitBatchRuns')
  },
}