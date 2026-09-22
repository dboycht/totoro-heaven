/**
 * `POST /api/local/task-unpack` —— 把"**任务解包退化了**"这件事写进**服务端日志**（2026-09-22）
 *
 * ## 为什么需要它（issue #12 的教训）
 * `getSunrunPaper` 的负载规格是 `getSunrunPaperResponseList#0`；真实用户的响应里这个字段缺失，
 * 任务本体在 `data` / `sunrunTaskList[0]` / 顶层自己 ⇒ 客户端走了**兜底解包**。
 * 这种"我们悄悄换了一条路径"如果只记在浏览器里，**诊断包的主力证据（服务端日志）就看不到** ——
 * 以后没人知道"我们解包退化过"，于是又会把"读到的 0 条线路"当成事实去分析（本次正是这样被带偏的）。
 *
 * ## 口径
 *   · **只写一行日志**，不落盘任何任务内容、不碰任何上游；请求体只收几个**非敏感**字段
 *     （来源层名 / 线路条数 / 候选层 / 上游判定），其余字段一律忽略；
 *   · 与其它 `server/api/local/**` 同规矩：`assertLocalRequest`（只允许本机、拒绝跨站来源）；
 *     `logger` 按字段名掩码，这里的字段里本来就没有 token / 学号；
 *   · 调用方（`composables/real/data.ts` 的 `noteUnpackDegraded()`）是**尽力而为**：
 *     这个接口失败**不影响**任务读取，那边只记一条 warn。
 *
 * 用法（前端自动调用，不需要人工）：
 * ```jsonc
 * POST /api/local/task-unpack
 * { "endpoint": "sunrunPaper", "where": "read", "source": "data", "lineCount": 1, "adoptedFrom": "(none)" }
 * ```
 */
import { assertLocalRequest } from '../../utils/tokenScanState'
import { logInfo } from '../../utils/logger'

/** 允许出现在日志里的字段（**白名单**：别把整个 body 摊进日志） */
const TEXT_KEYS = ['endpoint', 'where', 'source', 'adoptedFrom', 'candidates', 'verdict', 'specData'] as const

const shortText = (v: unknown, max = 60): string => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, max) : '')
const shortCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : -1)

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)
  const body = (await readBody(event).catch(() => ({}))) as Record<string, unknown>

  const safe: Record<string, unknown> = {}
  for (const key of TEXT_KEYS) {
    const text = shortText(body?.[key])
    if (text) safe[key] = text
  }
  safe.lineCount = shortCount(body?.lineCount)
  if (typeof body?.envelope === 'boolean') safe.envelope = body.envelope

  // 一行留痕：形如 `unpack degraded: sunrunPaper via data`
  logInfo('ui', `unpack degraded: ${safe.endpoint || 'unknown'} via ${safe.source || 'unknown'}`, safe)
  return { ok: true }
})
