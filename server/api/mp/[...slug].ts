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
import { MP_HOST, MP_UPSTREAM_HEADER } from '../../../src/mp/types'

/** 上游路径的已知命名空间前缀（不在其中则按旧写法自动补 `/wxxcx`） */
const KNOWN_PREFIXES = ['/wxxcx/', '/wxapi/', '/oss/']

/** 🔒 允许的上游主机后缀（供应商自有域；见文件头"安全边界"） */
const ALLOWED_UPSTREAM_SUFFIXES = ['xtotoro.com']

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
