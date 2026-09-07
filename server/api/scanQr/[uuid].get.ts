/**
 * 轮询微信扫码结果，从返回中提取 oauth code
 */
export default defineEventHandler(async (event) => {
  try {
    const { uuid } = getRouterParams(event)
    const scanResult = await $fetch<string>(
      `https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=${uuid}&f=url`,
    )
    const reg = new RegExp(/:\/\/oauth\?code=(\w+)&/)
    const res = reg.exec(scanResult)
    if (res === null) throw new Error('no code')
    return { message: null, code: res[1] }
  } catch (e) {
    console.log(e)
    return { message: '扫码失败', code: null }
  }
})