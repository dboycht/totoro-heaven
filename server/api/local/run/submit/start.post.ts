/**
 * `POST /api/local/run/submit/start` —— **启动一次服务端提交作业**（防 kill；2026-10-07 用户要求）
 *
 * 前端只负责：过门禁 → `getRunBegin` 拿场次号 → **把报文算好传进来**（口径与以前逐字一致）
 * → 调本端点 → 轮询 `status` 展示进度。**等待与两次写请求由服务端发出**，页面被冻结/关闭都不影响。
 *
 * ⚠️ 纪律：**用户点一次发起一次**（没有定时器、没有后台重试、不批量）。
 * 🔒 token 只在作业内存里用，绝不落盘、绝不进日志（logger 双重脱敏）。
 */
import { assertLocalRequest, localCallbackOrigin } from '../../../../utils/tokenScanState'
import { startRunSubmitJob, type RunSubmitJobInput } from '../../../../utils/runSubmitJob'
import { logInfo } from '../../../../utils/logger'

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)
  const body = (await readBody(event)) as RunSubmitJobInput

  /**
   * 自调用地址**按请求实际来的地址族**拼（`localCallbackOrigin`，纯函数、有单测）——
   * dev 只监听 `::1` 时写死 `127.0.0.1` 会连不上自己（`ERROR.md` E59 的同类坑）。
   */
  const hostHeader = String(event.node?.req?.headers?.host || '')
  const port = /:(\d+)$/.exec(hostHeader)?.[1] || process.env.NITRO_PORT || process.env.PORT || '3000'
  const origin = localCallbackOrigin(hostHeader, port)

  const out = startRunSubmitJob(body, origin)
  logInfo('run', out.ok ? '已受理提交作业（编排在服务端，页面只做展示）' : `拒绝启动提交作业：${out.message}`, {
    runId: out.id,
    km: body?.meta?.km,
    line: body?.meta?.lineName,
    plannedSeconds: body?.plannedSeconds,
  })
  return out
})
