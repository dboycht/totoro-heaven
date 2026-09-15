/**
 * `POST /api/local/token-scan/start` —— 开始一次「一键获取 token」
 *
 * 流程：本机校验 → 生成一次性 nonce → 启动内存扫描器（异步）→ 返回 nonce 供前端轮询。
 * 扫描器稍后会把候选 POST 到 `/api/local/token-import`（带同一个 nonce）。
 */
import { assertLocalRequest, beginScan } from '../../../utils/tokenScanState'
import { launchTokenScanner } from '../../../utils/tokenScanRunner'

export default defineEventHandler((event) => {
  assertLocalRequest(event)

  const hostHeader = String(event.node?.req?.headers?.host || '')
  const port = /:(\d+)$/.exec(hostHeader)?.[1] || process.env.NITRO_PORT || process.env.PORT || '3000'
  const endpoint = `http://127.0.0.1:${port}/api/local/token-import`

  const st = beginScan()
  launchTokenScanner(endpoint, st.nonce)

  return {
    ok: true,
    nonce: st.nonce,
    message: '已开始扫描；请确保电脑版微信已打开并登录「龙猫体育锻炼」',
  }
})
