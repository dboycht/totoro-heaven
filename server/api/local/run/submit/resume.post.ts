/**
 * `POST /api/local/run/submit/resume` —— **继续上次没跑完的提交**（进程级续跑；2026-10-08 用户要求）
 *
 * ## 为什么入参里要带 token / 学号 / 轨迹点 / 官方线路点列
 * 落盘文件**故意不含**这几样（用户 2026-10-08 拍板的落盘边界，见 `utils/mp/runResume.ts`）：
 *   · **token**：项目红线（任何形态不落盘）；
 *   · **轨迹点**（用户的）：由浏览器 `localStorage` 存（沿用「补交轨迹」那套口径）；
 *   · **官方线路点列**（🆕 2026-10-10 E76）：`sunrunPathPointList` 逐字取自它，
 *     而"点列不落盘"同一条边界 ⇒ 同样由浏览器补交（磁盘上只留**点数**用于核验）；
 *   · **学号**：与诊断包"学号打码"同一套口径。
 * ⇒ 恢复这一刻由**浏览器**把它们补交回来（它自己有会话、有 localStorage）。
 *
 * ## 三条去向（判据在 `utils/mp/runResume.ts` 的 `decideResume()`，纯函数有单测）
 *   · 还没到原定提交时刻 ⇒ **接着等**完再提交；
 *   · 已过原定时刻、且仍落在**任务允许的时长区间**内 ⇒ **立即提交**（时长按真实间隔算）；
 *   · 超出区间 ⇒ **作废，不提交**（免得留下时间不对的异常记录）。
 *
 * ⚠️ 纪律不变：**由用户点一次发起一次**（没有定时器、没有后台重试、不批量）。
 * 🔒 日志里**绝不出现** token / 学号 / 轨迹点（只记动作与原因）。
 */
import { assertLocalRequest, localCallbackOrigin } from '../../../../utils/tokenScanState'
import { resumeRunSubmitJob } from '../../../../utils/runSubmitJob'
import { logInfo, logWarn } from '../../../../utils/logger'

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)
  const body = (await readBody(event)) as
    | { token?: unknown; snCode?: unknown; points?: unknown; linePointList?: unknown }
    | undefined

  /**
   * 自调用地址**按请求实际来的地址族**拼（`localCallbackOrigin`）——
   * dev 只监听 `::1` 时写死 `127.0.0.1` 会连不上自己（`ERROR.md` E59 的同类坑）。
   */
  const hostHeader = String(event.node?.req?.headers?.host || '')
  const port = /:(\d+)$/.exec(hostHeader)?.[1] || process.env.NITRO_PORT || process.env.PORT || '3000'
  const origin = localCallbackOrigin(hostHeader, port)

  const points = Array.isArray(body?.points)
    ? (body.points as { latitude?: unknown; longitude?: unknown }[]).filter(
        (p) => p && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)),
      )
    : []

  /**
   * 🆕 2026-10-10（E76）：**官方线路点列**（首发时 `line.pointList` 的原样副本）。
   * 这里只做"是不是数组"的粗筛，**形状与数量的核验在 `resumeRunSubmitJob()` 里**
   * （唯一出口 `checkResumeLinePoints()`，纯函数有单测）—— 端点不做第二套判据。
   */
  const linePointList = Array.isArray(body?.linePointList) ? body.linePointList : []

  const out = resumeRunSubmitJob(
    {
      token: typeof body?.token === 'string' ? body.token : '',
      snCode: typeof body?.snCode === 'string' ? body.snCode : '',
      points: points as { latitude: number; longitude: number }[],
      linePointList,
    },
    origin,
  )

  /** ⚠️ 只记**动作与原因**，不记 token / 学号 / 轨迹点 / 线路点列（只记点数 —— 它不敏感） */
  const payload = { action: out.action, ok: out.ok, points: points.length, linePoints: linePointList.length }
  if (out.ok) logInfo('run', `续跑请求已受理：${out.message}`, payload)
  else logWarn('run', `续跑请求被拒：${out.message}`, payload)
  return out
})
