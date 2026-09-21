/**
 * 小程序后端代理：把 `/api/mp/**` 转发到**该学校自己的 API 基址**（多租户，不硬编码）
 *
 * 与旧 App 代理的区别：
 *   - **多租户**：上游基址来自 `MpApiWrapper.resolveSchoolBaseUrl(schoolCode)`（= `getSunRunSchoolList`
 *     的 `domainUrl`），由请求头 `x-mp-upstream` 传入；缺省回落共享域 `wxxcx.xtotoro.com`。
 *   - 不注入 Cookie（小程序用 `Authorization: Bearer <token>`）；但缺省补 `Bearer null`，
 *     因为鉴权过滤器**只检查头是否存在**：不带该头 → 401（见 ERROR.md E16）。
 *   - 请求体是**明文 JSON**，原样透传，不做任何加密。
 *   - 支持 GET / POST（旧 App 代理写死了 post），并按端点真实方法转发。
 *
 * 🔒 **安全边界（2026-09-15 加固，防 SSRF）**：
 *   上游基址来自**调用方可控的请求头**，若不限制，任何能访问本服务的东西都能借它去请求任意主机
 *   （并把响应的内容读回去），同时还会把调用方的 `Authorization` 一起转发 —— 典型的 SSRF + 凭据转发。
 *   因此这里强制两条：
 *     ① **主机白名单**：只允许供应商自有域（`*.xtotoro.com`）；
 *     ② **必须 HTTPS**：绝不把 token 以明文 HTTP 发出去。
 *   不满足则**回落到缺省共享域**（而不是拒绝整条请求），保证配置写错时仍可用。
 *   另：原先的 `?__upstream=` 调试后门**已删除**（前端从未使用，且是同一 SSRF 面）。
 *
 * 路径规则：
 *   `/api/mp/wxxcx/sunrun/getRunBegin` → `<base>/wxxcx/sunrun/getRunBegin`
 *   `/api/mp/wxapi/platform/active/getSunRunSchoolList` → `<base>/wxapi/platform/active/getSunRunSchoolList`
 *   兼容旧写法：`/api/mp/sunrun/getRunBegin` → `<base>/wxxcx/sunrun/getRunBegin`（自动补 `/wxxcx`）
 */
import { MP_API_PREFIX, MP_HOST, MP_PATH_PREFIXES, MP_UPSTREAM_HEADER } from '../../../src/mp/types'
import { summarizeUpstream } from '../../../utils/mp/logFormat'
import { logError, logInfo, summarizeRequestBody, logWarn } from '../../utils/logger'
import { fingerprintOf } from '../../utils/tokenScanState'

// ⚠️ 2026-09-17（D 轮）收口：**不再在本文件重复声明**前缀数组 —— 唯一来源是
//    `src/mp/constants.ts` 的 `MP_PATH_PREFIXES`（由 MP_API_PREFIX / MP_WXAPI_PREFIX 推导）。
//    两处各写一份时，一旦不同步就会出现"某些端点被补错前缀"的隐蔽 bug。

/** 🔒 允许的上游主机后缀（供应商自有域；见文件头"安全边界"） */
const ALLOWED_UPSTREAM_SUFFIXES = ['xtotoro.com']

/**
 * 上游请求超时（毫秒）。
 * 取 20 秒：比本项目其余上游调用（15–20 秒）一致，且明显长于正常响应（实测多为 200–600 ms），
 * 只在"网络/校方接口真的卡住"时才触发，避免误杀慢响应。
 */
const UPSTREAM_TIMEOUT_MS = 40_000

/** 主机是否在白名单内（`xtotoro.com` 及其子域） */
const isAllowedUpstreamHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  return ALLOWED_UPSTREAM_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * 只接受 **HTTPS + 无凭据 + 白名单主机** 的基址；非法则回落缺省值。
 * （回落而不是报错：配置写错时仍能工作，且攻击者拿不到任意主机的访问能力。）
 */
const normalizeBase = (raw: string | undefined | null, fallback: string): string => {
  if (!raw) return fallback
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return fallback // ① 绝不走明文 HTTP
    if (url.username || url.password) return fallback // ② 不允许带凭据
    if (!isAllowedUpstreamHost(url.hostname)) return fallback // ③ 主机白名单
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return fallback
  }
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const defaultBase = normalizeBase(
    (config.mp as { baseUrl?: string } | undefined)?.baseUrl || MP_HOST,
    MP_HOST,
  )

  const method = event.method.toUpperCase()
  const query = { ...(getQuery(event) as Record<string, string>) }
  const qs = new URLSearchParams(query).toString()

  const headerBase = event.node.req.headers[MP_UPSTREAM_HEADER]
  const base = normalizeBase(Array.isArray(headerBase) ? headerBase[0] : headerBase, defaultBase)

  // /api/mp/wxxcx/sunrun/getRunBegin -> /wxxcx/sunrun/getRunBegin
  const raw = event.path.replace(/^\/api\/mp/, '') || '/'
  const suffix = MP_PATH_PREFIXES.some((prefix) => raw.startsWith(prefix)) ? raw : `${MP_API_PREFIX}${raw}`
  const target = `${base}${suffix}${qs ? `?${qs}` : ''}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json',
    // 与小程序端 wx.request 的默认 UA 保持一致（部分网关会识别）
    'User-Agent': event.node.req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MicroMessenger/miniProgram',
    // ⚠️ 始终带 Authorization：缺头发 `Bearer null`（鉴权过滤器只查存在性；E16）
    'Authorization': event.node.req.headers.authorization || 'Bearer null',
  }

  let body: string | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const rawBody = await readRawBody(event, 'utf8')
    body = typeof rawBody === 'string' ? rawBody : undefined
  }

  // 日志用：token 只留指纹，请求体只留字段摘要（见 logger.ts，绝不落盘 token）
  const authHeader = String(headers.Authorization || '')
  const tokenRaw = authHeader.replace(/^Bearer\s+/i, '').trim()
  const authFp = tokenRaw && tokenRaw !== 'null' ? fingerprintOf(tokenRaw) : '(无 token)'
  const startedAt = Date.now()

  let res: Response
  let text: string
  try {
    /**
     * ⚠️ **必须带超时**（2026-09-19 自查补上）：这是**主数据通道**（读任务/成绩/记录全走这里），
     * 而它原先**没有超时** —— 上游 TCP 卡住时 `fetch` 会一直挂着，界面表现为**无限转圈**
     * （用户只能强杀程序）。其余 4 处上游调用早就带了 15–20 秒超时，这里是漏网的一处。
     * 判据：**任何出网请求都要有上限**；超时后给出可读原因，而不是抛一个看不懂的裸 AbortError。
     *
     * ⚠️ **2026-09-21 调整 20s → 40s（修 issue #11 的一部分）**：这个上限**必须大于**
     * 客户端写操作超时（`src/wrappers/MpApiWrapper.ts` 的 `MP_WRITE_TIMEOUT_MS = 30s`），
     * 否则代理先放弃、客户端永远走不到"超时→核实是否已入库"那条路径（实测厂商 `sunRunExercises`
     * 正常就能跑 15.4 秒，20 秒的上限余量太薄）。这里放宽到 40 秒作为**最后兜底**，
     * 让"等待上限"由离用户最近的那一层（客户端）决定、语义单一。
     */
    res = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
    text = await res.text()
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    logError('proxy', `${method} ${suffix} 请求失败`, {
      upstream: new URL(base).hostname,
      ms: Date.now() - startedAt,
      auth: authFp,
      body: summarizeRequestBody(suffix, body),
      error: err instanceof Error ? err.message : String(err),
      ...(isTimeout ? { timeoutMs: UPSTREAM_TIMEOUT_MS } : {}),
    })
    if (isTimeout) {
      throw createError({
        statusCode: 504,
        statusMessage: `上游 ${UPSTREAM_TIMEOUT_MS / 1000} 秒无响应（网络/校方接口慢或不通）——请稍后重试`,
      })
    }
    throw err
  }

  let parsed: unknown = undefined
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const upstream = parsed !== undefined ? summarizeUpstream(parsed) : { kind: 'non-json', bytes: text.length }
  const line = {
    endpoint: suffix,
    http: res.status,
    ms: Date.now() - startedAt,
    bytes: text.length,
    auth: authFp,
    upstream,
    body: summarizeRequestBody(suffix, body),
  }
  // 上游明确的业务失败或网络层错误 → warn/error，正常 → info（便于在日志里一眼筛出问题）
  const bizFail = upstream && typeof upstream === 'object' && 'status' in upstream && String((upstream as Record<string, unknown>).status) !== '00'
  if (res.status >= 400 || (parsed === undefined && text.length > 0)) logError('proxy', `${method} ${suffix}`, line)
  else if (bizFail) logWarn('proxy', `${method} ${suffix}`, line)
  else logInfo('proxy', `${method} ${suffix}`, line)

  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', res.headers.get('content-type') || 'application/json; charset=utf-8')

  // 尽量按 JSON 返回，失败则原样返回文本
  return parsed !== undefined ? parsed : text
})
