/**
 * 生成微信开放平台登录二维码：返回 uuid + 二维码图片地址
 */
export default defineEventHandler(async () => {
  const config = useRuntimeConfig()
  const appId = (config.totoro as { wechatAppId: string }).wechatAppId

  const html = await $fetch<string>(
    `https://open.weixin.qq.com/connect/app/qrconnect?appid=${appId}&bundleid=(com.totoro.school)&scope=snsapi_userinfo&state=&from=message&isappinstalled=0`,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) Mobile/12A365 MicroMessenger/5.4.1 NetType/WIFI WebView/doc',
      },
    },
  )
  const uuid = html.split('uuid: "')[1].split('"')[0]
  const imgUrl = html.split('auth_qrcode" src="')[1].split('"')[0]
  return { uuid, imgUrl }
})