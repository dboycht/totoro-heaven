/**
 * 小程序后端代理：把 /api/mp/** 转发到 https://wxxcx.xtotoro.com/wxxcx/**
 *
 * 与旧 App 代理的区别：
 *   - 不注入 Cookie（小程序用 `Authorization: Bearer <token>`）
 *   - 请求体是**明文 JSON**，原样透传，不做任何加密
 *   - 支持 GET / POST（旧 App 代理写死了 post）
 *
 * ⚠️ 抓包落地后需核对：
 *   - 是否需要透传特定 header（如 `Referer: https://servicewechat.com/...`）
 *   - 是否存在必须由客户端生成的签名 header（若有，需在此或 wrapper 内实现）
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const baseUrl = ((config.mp as { baseUrl?: string } | undefined)?.baseUrl || 'https://wxxcx.xtotoro.com').replace(/\/$/, '')

  const method = event.method.toUpperCase()
  const query = getQuery(event)
  const qs = new URLSearchParams(query as Record<string, string>).toString()

  // /api/mp/sunrun/getRunBegin -> /wxxcx/sunrun/getRunBegin
  const suffix = event.path.replace(/^\/api\/mp/, '')
  const target = `${baseUrl}/wxxcx${suffix}${qs ? `?${qs}` : ''}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json',
    // 与小程序端 wx.request 的默认 UA 保持一致（部分网关会识别）
    'User-Agent': event.node.req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MicroMessenger/miniProgram',
  }

  const auth = event.node.req.headers.authorization
  if (auth) headers.Authorization = auth

  let body: string | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readRawBody(event, 'utf8')
    body = typeof raw === 'string' ? raw : undefined
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
