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
 * 路径规则：
 *   `/api/mp/wxxcx/sunrun/getRunBegin` → `<base>/wxxcx/sunrun/getRunBegin`
 *   `/api/mp/wxapi/platform/active/getSunRunSchoolList` → `<base>/wxapi/platform/active/getSunRunSchoolList`
 *   兼容旧写法：`/api/mp/sunrun/getRunBegin` → `<base>/wxxcx/sunrun/getRunBegin`（自动补 `/wxxcx`）
 */
import { MP_HOST, MP_UPSTREAM_HEADER } from '../../../src/mp/types'

/** 上游路径的已知命名空间前缀（不在其中则按旧写法自动补 `/wxxcx`） */
const KNOWN_PREFIXES = ['/wxxcx/', '/wxapi/', '/oss/']

/** 只接受 http(s) 且不带凭据的基址；非法则回落缺省值 */
const normalizeBase = (raw: string | undefined | null, fallback: string): string => {
  if (!raw) return fallback
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback
    if (url.username || url.password) return fallback
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
  const upstreamQuery = query.__upstream // 仅供直接调试用；正常走请求头
  delete query.__upstream
  const qs = new URLSearchParams(query).toString()

  const headerBase = event.node.req.headers[MP_UPSTREAM_HEADER]
  const base = normalizeBase(
    (Array.isArray(headerBase) ? headerBase[0] : headerBase) || upstreamQuery || defaultBase,
    defaultBase,
  )

  // /api/mp/wxxcx/sunrun/getRunBegin -> /wxxcx/sunrun/getRunBegin
  const raw = event.path.replace(/^\/api\/mp/, '') || '/'
  const suffix = KNOWN_PREFIXES.some((prefix) => raw.startsWith(prefix)) ? raw : `/wxxcx${raw}`
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

  const res = await fetch(target, { method, headers, body })
  const text = await res.text()

  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', res.headers.get('content-type') || 'application/json; charset=utf-8')

  // 尽量按 JSON 返回，失败则原样返回文本
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
})
