/**
 * 通用代理：把 /api/totoro/** 原样转发到 https://app.xtotoro.com/app/**
 * 透传浏览器 Cookie，UA 伪装龙猫 App（iPhone）
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Host': 'app.xtotoro.com',
    'Connection': 'keep-alive',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'TotoroSchool/1.2.14 (iPhone; iOS 17.4.1; Scale/3.00)',
    'Cookie': event.node.req.headers.cookie || '',
    'Accept': 'application/json',
  }

  const path = event.path.replace('/api/totoro/', '/app/')
  const config = useRuntimeConfig()
  const baseUrl = (config.totoro as { baseUrl: string }).baseUrl

  return fetch(`${baseUrl}${path}`, {
    method: 'post',
    headers: { ...headers },
    body,
  })
})