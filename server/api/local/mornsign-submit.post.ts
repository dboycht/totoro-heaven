/**
 * `POST /api/local/mornsign-submit` —— 早操签到**提交**（本地专用通道）
 *
 * ## ⚠️ 这是一条显式的越线实现（用户 2026-09-19 明确要求）
 * 厂商的签到 = "定位在点位范围内" + "**扫到点位上贴的二维码**"，扫码是它用来证明"人到了现场"的设计。
 * 而 `qrCode` 由**服务端下发**，小程序只是拿"扫码结果"与它做**本地字符串比对**
 * （`_mp-analyze/第三方9_17-早签模块分析.md` §5.2）⇒ 提交时把下发值填进去，服务端**分辨不出**
 * 是"人真扫到"还是"程序填的"。本端点走的就是这条路径。
 * **它由用户单击触发（不是定时器/后台）**，且**失败不重试**（写操作非幂等）。
 *
 * ## 为什么要服务端加密
 * `morningExercises` 的请求体只有 `{ encryptParams }`，明文要经 **RSA/PKCS#1 v1.5 分段加密**
 * （1024-bit ⇒ 每段 ≤117 字节）。私钥无关、公钥硬编码，所以放服务端最简单也最安全
 * （token 不离开本机、不进浏览器可见状态）。加密实现见 `utils/mp/mornSignCrypto.ts`（有离线单测）。
 *
 * ## 安全设计
 * - `assertLocalRequest`：**只接受本机请求**（与 `local/token-*` 同款守卫）；
 * - 不落盘、不打印 token 与密文（日志只留字段摘要）；
 * - **一次调用只发一次上游请求**，无重试、无循环。
 */
import { MP_ENDPOINTS, MP_HOST } from '../../../src/mp/types'
import { encryptLong } from '../../../utils/mp/mornSignCrypto'
import { normalizeMornSignPaper } from '../../../utils/mp/morningSign'
import {
  COORD_JITTER_RADIUS_M,
  buildMornSignPayload,
  coordOffsetMeters,
  evaluateMornSignWindow,
  judgeMornSignSubmit,
} from '../../../utils/mp/mornSignSubmit'
import { judgeMpResponse, unwrapMpResponse } from '../../../src/mp/envelope'
import { logInfo, logWarn } from '../../utils/logger'
import { assertLocalRequest } from '../../utils/tokenScanState'

/** 先读一次任务，按 pointId 取回该点位的完整资料（taskId/坐标/qrCode） */
async function fetchPoint(input: { snCode: string; token: string }, pointId: string) {
  const res = await fetch(`${MP_HOST}${MP_ENDPOINTS.mornSignPaper.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', Authorization: `Bearer ${input.token}` },
    body: JSON.stringify({ stuNumber: input.snCode, token: input.token }),
    signal: AbortSignal.timeout(15000),
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!json) throw new Error('读取签到任务失败：响应不是 JSON')
  const verdict = judgeMpResponse(json, MP_ENDPOINTS.mornSignPaper.payload)
  if (!verdict.ok) throw new Error(`读取签到任务失败：${verdict.message || '接口未返回成功'}`)
  const raw = unwrapMpResponse<Record<string, unknown>>(json, MP_ENDPOINTS.mornSignPaper.payload)
  const list = Array.isArray(raw?.signPointList) ? (raw.signPointList as Record<string, unknown>[]) : []
  const hit = list.find((p) => String(p?.pointId) === String(pointId))
  if (!hit) throw new Error(`点位 ${pointId} 不在当前签到任务里`)
  return {
    /** 原始任务对象（由调用方用 `normalizeMornSignPaper` 归一化成有类型的任务） */
    raw: raw ?? {},
    point: {
      taskId: String(hit.taskId ?? ''),
      pointId: String(hit.pointId ?? ''),
      pointName: String(hit.pointName ?? ''),
      latitude: String(hit.latitude ?? ''),
      longitude: String(hit.longitude ?? ''),
      qrCode: String(hit.qrCode ?? ''),
    },
  }
}

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)

  const body = (await readBody(event).catch(() => ({}))) as {
    snCode?: string
    token?: string
    pointId?: string
    phoneInfo?: string
  }
  const snCode = String(body?.snCode ?? '').trim()
  const token = String(body?.token ?? '').trim()
  const pointId = String(body?.pointId ?? '').trim()
  if (!snCode) throw createError({ statusCode: 400, statusMessage: '缺少学号（snCode）' })
  if (!token) throw createError({ statusCode: 400, statusMessage: '缺少 token' })
  if (!pointId) throw createError({ statusCode: 400, statusMessage: '缺少签到点位（pointId）' })

  // ① 提交前**重读一次**点位资料（吸取 E21/E33 的教训：绝不拿旧快照去写）
  const { raw: taskRaw, point } = await fetchPoint({ snCode, token }, pointId)

  /**
   * ①' **纵深防御：服务端侧复查时段**（2026-09-19 审计 M3）。
   * 界面只在窗口内放开「提交签到」，但用户完全可能**在窗口内打开确认框、拖到窗口外再点确认**
   * —— 那时界面的 `canSubmit` 已不参与（确认按钮只判"是否正在提交"），唯一执行点就被绕过。
   * 这里用**服务端下发的时段**再判一次（`evaluateMornSignWindow`，与界面同一个纯函数），
   * 窗口外就**不发上游请求**（服务端本来也会拒，但没必要替用户发一次注定失败的写请求）。
   *
   * ⚠️ 用 `normalizeMornSignPaper` 归一化后再判：这样拿到的是**有类型的** `MpMornSignTask`，
   *    不用 `as never` 硬转（审计指出过 `buildMornSignPayload` 的 `task` 参数其实没被用到，
   *    所以这里也不再把 task 传给它）。
   */
  const norm = normalizeMornSignPaper(taskRaw)
  if (norm.kind !== 'ok') {
    return { ok: false, accepted: false, message: `未提交：读不到签到任务（${norm.message}）`, raw: '' }
  }
  const task = norm.task
  const windowState = evaluateMornSignWindow(task, Date.now())
  if (!windowState.known) {
    return { ok: false, accepted: false, message: `无法确认签到时段：${windowState.reason}`, raw: '' }
  }
  if (!windowState.inside) {
    logWarn('morn', '提交被本地时段复查拦下（未发上游请求）', {
      pointId: point.pointId,
      window: `${task.startTime}~${task.endTime}`,
      reason: windowState.reason,
    })
    return { ok: false, accepted: false, message: `未提交：${windowState.reason}`, raw: '' }
  }
  // ①'' 今日已签够也不再发（避免无意义的重复写请求）
  const needCount = Number(task.dayNeedSignCount)
  const doneCount = Number(task.dayCompSignCount)
  if (Number.isFinite(needCount) && needCount > 0 && Number.isFinite(doneCount) && doneCount >= needCount) {
    return { ok: false, accepted: false, message: `未提交：今日已签满（${doneCount}/${needCount} 次）`, raw: '' }
  }

  // ② 组装 16 字段（缺四要素会在这里抛错）
  // ⚠️ 坐标会做 ≤`COORD_JITTER_RADIUS_M`（默认 5 m）的随机抖动 —— 理由见 `mornSignSubmit.ts`：
  //    真手机定位必有抖动，把服务端下发的坐标**逐位原样回传**是最典型的程序痕迹。
  //    **点位标识字段（taskId/pointId/qrCode）一律原样**，抖动只作用于坐标。
  const payload = buildMornSignPayload({
    point,
    snCode,
    token,
    phoneInfo: body?.phoneInfo,
  })

  // ③ 加密（唯一使用加密参的端点）
  const encryptParams = encryptLong(JSON.stringify(payload))
  /** 本次坐标相对点位中心的偏移量（米），用于日志/对账；**不打印坐标本身**（与隐私口径一致） */
  const offsetM = coordOffsetMeters(point.latitude, point.longitude, payload.latitude, payload.longitude)
  logInfo('morn', '早操签到提交（用户单击触发，不重试）', {
    pointId: point.pointId,
    pointName: point.pointName,
    signDate: payload.signDate,
    coordOffsetM: Number(offsetM.toFixed(2)),
    coordJitterRadiusM: COORD_JITTER_RADIUS_M,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    cipherB64Len: encryptParams.length,
  })

  // ④ 发一次上游请求（**仅一次**；非幂等写操作，绝不重试）
  let rawText = ''
  try {
    const res = await fetch(`${MP_HOST}${MP_ENDPOINTS.morningExercises.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ encryptParams }),
      signal: AbortSignal.timeout(20000),
    })
    rawText = await res.text()
  } catch (err) {
    logWarn('morn', '早操签到提交请求异常', { message: (err as Error).message })
    return { ok: false, accepted: false, message: `请求异常：${(err as Error).message}`, raw: '' }
  }

  const outcome = judgeMornSignSubmit(rawText)
  if (outcome.accepted) logInfo('morn', '早操签到被服务端接受', { pointId: point.pointId })
  else logWarn('morn', '早操签到被服务端拒绝', { message: outcome.message, raw: rawText.slice(0, 200) })

  return {
    ok: true,
    accepted: outcome.accepted,
    message: outcome.message,
    raw: outcome.raw,
    pointName: point.pointName,
    signDate: payload.signDate,
  }
})
