/**
 * 小程序后端代理：把 `/api/mp/**` 转发到**该学校自己的 API 基址**（多租户，不硬编码）
 *
 * 与旧 App 代理的区别：
 *   - **多租户**：上游基址来自 `MpApiWrapper.resolveSchoolBaseUrl(schoolCode)`（= `getSunRunSchoolList`
 *     的 `domainUrl`），由请求头 `x-mp-upstream` 传入；缺省回落共享域 `wxxcx.xtotoro.com`。
 *   - 不注入 Cookie（小程序用 `Authorization: Bearer <token>`）；但缺省补 `Bearer null`，
 *     因为鉴权过滤器**只检查头是否存在**：不带该头 → 401（见 ERROR.md E16）。
 *   - 请求体是**明文 JSON**，原样透传，不做任何加密。
 *   - 支持 GET / POST（旧 App 代理写死了 post），并按端点真实方法转发。
 *
 * 🔒 **安全边界（2026-09-15 加固，防 SSRF）**：
 *   上游基址来自**调用方可控的请求头**，若不限制，任何能访问本服务的东西都能借它去请求任意主机
 *   （并把响应的内容读回去），同时还会把调用方的 `Authorization` 一起转发 —— 典型的 SSRF + 凭据转发。
 *   因此这里强制两条：
 *     ① **主机白名单**：只允许供应商自有域（`*.xtotoro.com`）；
 *     ② **必须 HTTPS**：绝不把 token 以明文 HTTP 发出去。
 *   不满足则**回落到缺省共享域**（而不是拒绝整条请求），保证配置写错时仍可用。
 *   另：原先的 `?__upstream=` 调试后门**已删除**（前端从未使用，且是同一 SSRF 面）。
 *
 * 路径规则：
 *   `/api/mp/wxxcx/sunrun/getRunBegin` → `<base>/wxxcx/sunrun/getRunBegin`
 *   `/api/mp/wxapi/platform/active/getSunRunSchoolList` → `<base>/wxapi/platform/active/getSunRunSchoolList`
 *   兼容旧写法：`/api/mp/sunrun/getRunBegin` → `<base>/wxxcx/sunrun/getRunBegin`（自动补 `/wxxcx`）
 */
import { MP_API_PREFIX, MP_HOST, MP_PATH_PREFIXES, MP_UPSTREAM_HEADER } from '../../../src/mp/types'
import { summarizeUpstream } from '../../../utils/mp/logFormat'
import { RESP_BODY_MAX_BYTES, convergeLogLine, knownValuePairs, summarizeRespShape, summarizeResponseBody, unpackNote } from '../../../utils/mp/responseRecord'
import { logError, logRawLine, summarizeRequestBody, logWarn } from '../../utils/logger'
import { CAPTURE_MAX_BYTES, writeCapture } from '../../utils/captureStore'
import { fingerprintOf } from '../../utils/tokenScanState'

// ⚠️ 2026-09-17（D 轮）收口：**不再在本文件重复声明**前缀数组 —— 唯一来源是
//    `src/mp/constants.ts` 的 `MP_PATH_PREFIXES`（由 MP_API_PREFIX / MP_WXAPI_PREFIX 推导）。
//    两处各写一份时，一旦不同步就会出现"某些端点被补错前缀"的隐蔽 bug。

/** 🔒 允许的上游主机后缀（供应商自有域；见文件头"安全边界"） */
const ALLOWED_UPSTREAM_SUFFIXES = ['xtotoro.com']

/**
 * 上游请求超时（毫秒）。
 * 取 20 秒：比本项目其余上游调用（15–20 秒）一致，且明显长于正常响应（实测多为 200–600 ms），
 * 只在"网络/校方接口真的卡住"时才触发，避免误杀慢响应。
 */
const UPSTREAM_TIMEOUT_MS = 40_000

/** 主机是否在白名单内（`xtotoro.com` 及其子域） */
const isAllowedUpstreamHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  return ALLOWED_UPSTREAM_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/** 解析请求体文本（坏 JSON / 空 ⇒ undefined）——「全记录」要从它取"已知敏感原值"的对照表 */
const safeParseJson = (text: string | undefined): unknown => {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    // 请求体不是 JSON（上游本就接受明文 JSON，这里只用于脱敏对照表）：拿不到对照表也不影响其它记录
    return undefined
  }
}

/**
 * 只接受 **HTTPS + 无凭据 + 白名单主机** 的基址；非法则回落缺省值。
 * （回落而不是报错：配置写错时仍能工作，且攻击者拿不到任意主机的访问能力。）
 */
const normalizeBase = (raw: string | undefined | null, fallback: string): string => {
  if (!raw) return fallback
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return fallback // ① 绝不走明文 HTTP
    if (url.username || url.password) return fallback // ② 不允许带凭据
    if (!isAllowedUpstreamHost(url.hostname)) return fallback // ③ 主机白名单
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return fallback
  }
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const defaultBase = normalizeBase(
    (config.mp as { baseUrl?: string } | undefined)?.baseUrl || MP_HOST,
    MP_HOST,
  )

  const method = event.method.toUpperCase()
  const query = { ...(getQuery(event) as Record<string, string>) }
  const qs = new URLSearchParams(query).toString()

  const headerBase = event.node.req.headers[MP_UPSTREAM_HEADER]
  const base = normalizeBase(Array.isArray(headerBase) ? headerBase[0] : headerBase, defaultBase)

  // /api/mp/wxxcx/sunrun/getRunBegin -> /wxxcx/sunrun/getRunBegin
  const raw = event.path.replace(/^\/api\/mp/, '') || '/'
  const suffix = MP_PATH_PREFIXES.some((prefix) => raw.startsWith(prefix)) ? raw : `${MP_API_PREFIX}${raw}`
  const target = `${base}${suffix}${qs ? `?${qs}` : ''}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json',
    // 与小程序端 wx.request 的默认 UA 保持一致（部分网关会识别）
    'User-Agent': event.node.req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MicroMessenger/miniProgram',
    // ⚠️ 始终带 Authorization：缺头发 `Bearer null`（鉴权过滤器只查存在性；E16）
    'Authorization': event.node.req.headers.authorization || 'Bearer null',
  }

  let body: string | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const rawBody = await readRawBody(event, 'utf8')
    body = typeof rawBody === 'string' ? rawBody : undefined
  }

  // 日志用：token 只留指纹，请求体只留字段摘要（见 logger.ts，绝不落盘 token）
  const authHeader = String(headers.Authorization || '')
  const tokenRaw = authHeader.replace(/^Bearer\s+/i, '').trim()
  const authFp = tokenRaw && tokenRaw !== 'null' ? fingerprintOf(tokenRaw) : '(无 token)'
  const startedAt = Date.now()

  let res: Response
  let text: string
  try {
    /**
     * ⚠️ **必须带超时**（2026-09-19 自查补上）：这是**主数据通道**（读任务/成绩/记录全走这里），
     * 而它原先**没有超时** —— 上游 TCP 卡住时 `fetch` 会一直挂着，界面表现为**无限转圈**
     * （用户只能强杀程序）。其余 4 处上游调用早就带了 15–20 秒超时，这里是漏网的一处。
     * 判据：**任何出网请求都要有上限**；超时后给出可读原因，而不是抛一个看不懂的裸 AbortError。
     *
     * ⚠️ **2026-09-21 调整 20s → 40s（修 issue #11 的一部分）**：这个上限**必须大于**
     * 客户端写操作超时（`src/wrappers/MpApiWrapper.ts` 的 `MP_WRITE_TIMEOUT_MS = 30s`），
     * 否则代理先放弃、客户端永远走不到"超时→核实是否已入库"那条路径（实测厂商 `sunRunExercises`
     * 正常就能跑 15.4 秒，20 秒的上限余量太薄）。这里放宽到 40 秒作为**最后兜底**，
     * 让"等待上限"由离用户最近的那一层（客户端）决定、语义单一。
     */
    res = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
    text = await res.text()
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    logError('proxy', `${method} ${suffix} 请求失败`, {
      upstream: new URL(base).hostname,
      ms: Date.now() - startedAt,
      auth: authFp,
      body: summarizeRequestBody(suffix, body),
      error: err instanceof Error ? err.message : String(err),
      ...(isTimeout ? { timeoutMs: UPSTREAM_TIMEOUT_MS } : {}),
    })
    if (isTimeout) {
      throw createError({
        statusCode: 504,
        statusMessage: `上游 ${UPSTREAM_TIMEOUT_MS / 1000} 秒无响应（网络/校方接口慢或不通）——请稍后重试`,
      })
    }
    throw err
  }

  let parsed: unknown = undefined
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  /**
   * 🆕 2026-09-22「**全记录**」（用户原话）：把**响应的结构 + 脱敏后的内容**也记进服务端日志。
   * 为什么加（真实用户那次的关键事实在日志里看不见）：此前只记响应的 `bytes` 与信封标量，
   * "响应其实是个信封、真正的任务在 `data` 里"完全看不出来，只能靠客户端快照的 `task.raw`（还一度读错层）。
   *
   * 隐私顺序（**落盘前必须已脱敏**，见 `utils/mp/responseRecord.ts` 文件头）：
   *   ① 字段名（`SENSITIVE_KEYS`）→ ② 已知原值（从**请求体**里取到的学号/姓名/手机）→
   *   ③ token 样式串 → ④ 8~18 位纯数字（**字符串与数字两种形态**）。
   *
   * `known` 从**请求体**里取：服务端没有客户端 profile，而请求体里通常正带着 `stuNumber`/`snCode` 等，
   * 于是它成了"同一批值在别处出现"的对照表。
   * ⚠️ 2026-09-22 审计修正：`upstream`（信封标量里的 `msg`/`message` 是自由文本）与
   * `respShape.envelope` **也必须**用这张对照表脱敏，否则同一行里会出现"respBody 掩了、envelope 没掩"。
   */
  /**
   * 🔴 **整段响应记录都在 try/catch 里**（闸门复验第二轮必修）：
   * ① 老实现把 `knownValuePairs()` / `summarizeUpstream()` **留在 try 之外** ⇒ 它们抛错照样 500；
   * ② 记录失败**绝不能影响上游数据返回** —— 只写一条 warn，然后照常 `return parsed/text`；
   * ③ 行文本由 `convergeLogLine()` 统一产出：按**整行**（含 `{t,level,cat,msg}` 包装）字节收敛，
   *    **每降一档都复检**；`respShape` 与 `respBody` 都在收敛范围内
   *    （复验实测：只缩 respBody 会得到"已省略响应内容"却仍有 44 KB 的行）。
   */
  const LINE_MAX_BYTES = RESP_BODY_MAX_BYTES + 4096
  const t0 = Date.now()
  const nowIso = new Date().toISOString()
  let lineText = ''
  let bizFail = false
  try {
    /**
     * 🧪 **故障注入**（闸门复验要求"加一条'记录环节抛错不影响响应'的断言"）：
     * 只有显式设置 `TOTORO_FAULT_RECORD=1` 时才抛 —— 用来**实测**"记录环节炸了，路由照样把上游数据返给用户"。
     * 生产/日常不会有人设这个变量；即便设了，影响也只是"日志少一条"。
     */
    if (process.env.TOTORO_FAULT_RECORD === '1') throw new Error('注入的故障：响应记录环节（仅 TOTORO_FAULT_RECORD=1 时）')
    const known = knownValuePairs(safeParseJson(body))
    const upstream = parsed !== undefined ? summarizeUpstream(parsed, known) : { kind: 'non-json', bytes: text.length }
    const respShape = parsed !== undefined ? summarizeRespShape(parsed, {}, known) : undefined
    /**
     * 🆕 2026-09-23 **响应原文单独留档**（用户要求"完整可分析、不裁单条"）：
     *   ① `respBody`（**给日志行**）＝ 小而可读的摘要（32 KB 上限，**行为与以前逐字不变**）；
     *   ② `captureBody`（**给 captures**）＝ 同一套脱敏产物，但上限换成 `CAPTURE_MAX_BYTES`（64 MB）且非 JSON 记全文
     *      ⇒ 正常**永不裁**（`truncated=false`），写一份到 `captures/`，日志行里只留一个**指针**。
     * 体积由"总量预算 + 淘汰记账"兜（见 `server/utils/captureStore.ts`）。
     * ⚠️ 两次调用**共用同一套脱敏**（同一个函数、同一份 known）—— 只是"裁不裁"不同，绝不另写一份脱敏口径。
     */
    const respBody = summarizeResponseBody(text, parsed, known, undefined, res.headers.get('content-type') || '')
    const captureBody = summarizeResponseBody(text, parsed, known, undefined, res.headers.get('content-type') || '', {
      bodyMaxBytes: CAPTURE_MAX_BYTES,
      textWhole: true,
    })
    const unpack = parsed !== undefined ? unpackNote(parsed) : undefined
    const captureName = captureBody
      ? writeCapture({
          endpoint: suffix,
          http: res.status,
          ms: t0 - startedAt,
          originalBytes: captureBody.originalBytes,
          payload: captureBody,
          unpack: unpack ? (unpack.status === 'suspect' ? `suspect: ${unpack.hint}` : 'ok') : undefined,
        })
      : null
    const entry = {
      t: nowIso,
      level: (res.status >= 400 || (parsed === undefined && text.length > 0) ? 'error' : 'info') as 'info' | 'warn' | 'error',
      cat: 'proxy',
      msg: `${method} ${suffix}`,
      data: {
        endpoint: suffix,
        http: res.status,
        ms: t0 - startedAt,
        bytes: text.length,
        auth: authFp,
        upstream,
        /** 🆕 响应**结构**摘要（只记键名与数组长度，不记值；**自带上限**） */
        ...(respShape ? { respShape } : {}),
        /**
         * 🆕 响应**内容摘要**（已脱敏；**仍然小而可读**，超上限会按字节预算逐键填充并在 note 里注明）。
         * 🆕 `capture` = **该请求完整原文的留档文件名**（相对 `captures/`；要分析就去那儿拿原文）。
         * 没有这个字段 = 留档失败或响应为空（此时只有摘要可看）。
         */
        ...(respBody ? { respBody: captureName ? { ...respBody, capture: captureName } : respBody } : {}),
        /** 🆕 解包退化留痕（负载疑似藏在信封里时就写 `suspect: …`；正常时写 `ok`） */
        ...(unpack ? { unpack: unpack.status === 'suspect' ? `suspect: ${unpack.hint}` : 'ok', ...(unpack.status === 'suspect' ? { unpackDetail: { payloadKeys: unpack.payloadKeys, envelopeField: unpack.envelopeField } } : {}) } : {}),
        body: summarizeRequestBody(suffix, body),
      } as Record<string, unknown>,
    }
    bizFail = upstream && typeof upstream === 'object' && 'status' in upstream && String((upstream as Record<string, unknown>).status) !== '00'
    if (bizFail && entry.level === 'info') entry.level = 'warn'
    const converged = convergeLogLine(entry, LINE_MAX_BYTES)
    lineText = converged.text
    // 收敛后**复检**（`convergeLogLine` 内部已保证；这里再核一次，核不过就只写元数据）
    if (Buffer.byteLength(lineText, 'utf8') > LINE_MAX_BYTES) {
      lineText = JSON.stringify({ t: nowIso, level: 'warn', cat: 'proxy', msg: `${method} ${suffix}`, data: { endpoint: suffix, http: res.status, ms: t0 - startedAt, bytes: text.length, auth: authFp, note: '日志行收敛失败，只保留元数据' } })
    }
    if (converged.degraded.length) {
      logWarn('proxy', `${method} ${suffix} 日志行已降级收敛`, { degraded: converged.degraded, lineBytes: Buffer.byteLength(lineText, 'utf8') })
    }
  } catch (err) {
    // 记录环节任何异常都不许影响上游返回：退化成"只有元数据"的一行
    logWarn('proxy', `${method} ${suffix} 响应记录失败（不影响上游返回）`, {
      error: err instanceof Error ? err.message : String(err),
      upstreamBytes: text.length,
    })
    lineText = JSON.stringify({ t: nowIso, level: 'warn', cat: 'proxy', msg: `${method} ${suffix}`, data: { endpoint: suffix, http: res.status, ms: t0 - startedAt, bytes: text.length, auth: authFp, note: '响应记录失败（详见上一条 warn）' } })
  }
  // 写**已收敛好的整行文本**（不再让 logger 包一层 —— 那会改变被量的对象）
  logRawLine(bizFail ? 'warn' : 'info', 'proxy', lineText)

  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', res.headers.get('content-type') || 'application/json; charset=utf-8')

  // 尽量按 JSON 返回，失败则原样返回文本
  return parsed !== undefined ? parsed : text
})
