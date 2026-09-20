/**
 * `POST /api/local/token-scan/start` —— 开始一次「一键获取 token」
 *
 * 流程：本机校验 → 生成一次性 nonce → 启动内存扫描器（异步）→ 返回 nonce 供前端轮询。
 * 扫描器稍后会把候选 POST 到 `/api/local/token-import`（带同一个 nonce）。
 */
import { assertLocalRequest, beginScan, localCallbackOrigin } from '../../../utils/tokenScanState'
import { launchTokenScanner } from '../../../utils/tokenScanRunner'
import { logInfo } from '../../../utils/logger'

export default defineEventHandler((event) => {
  assertLocalRequest(event)

  /**
   * 回传地址**按请求实际来的地址族**拼（`localCallbackOrigin`，纯函数、有单测）——
   * ⚠️ 以前这里写死 `http://127.0.0.1`，dev 只监听 `::1` 时回传 POST 会被拒 ⇒
   * 扫描器 `exit 1`、界面报"扫描器未回传结果"（`ERROR.md` E59）。现在两种地址族都不会再断。
   */
  const hostHeader = String(event.node?.req?.headers?.host || '')
  const port = /:(\d+)$/.exec(hostHeader)?.[1] || process.env.NITRO_PORT || process.env.PORT || '3000'
  const endpoint = `${localCallbackOrigin(hostHeader, port)}/api/local/token-import`

  const st = beginScan()
  launchTokenScanner(endpoint, st.nonce)
  logInfo('token', '开始扫描微信小程序进程内存', { port, callback: endpoint.replace(/\/api\/local\/.*$/, '') })

  return {
    ok: true,
    nonce: st.nonce,
    message: '已开始扫描；请确保电脑版微信已打开并登录「龙猫体育锻炼」',
  }
})
