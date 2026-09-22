/**
 * 「**全记录**」上游响应（结构 + 脱敏后的内容）—— 2026-09-22 新增（用户原话："全记录"）
 *
 * ## 为什么要有它（真实用户那次"日志里看不出关键事实"）
 * 研究生院「研途健行」用户的诊断包暴露：**日志里完全看不到**"响应其实是个信封、真正的任务在 `data` 里"
 * 这件事 —— 因为代理日志此前只记：
 *   · 响应的 `bytes` 与信封标量（`summarizeUpstream()` → `{status,code,msg,message,total}`）；
 *   · 请求体的 `body:{bytes,keys}`（那是**请求**，不是响应）。
 * 于是"任务到底下发了几条线路"只能靠客户端快照里那份 `task.raw` 才看出来（还一度被读错层）。
 * 用户的要求很直接：**结构 + 内容都记下来**。
 *
 * ## 三件产物（进了服务端文件日志的每一行）
 * 1. **`respShape`**：响应**结构摘要** —— 顶层键名（排序）+ 嵌套 2~3 层的键名 + **数组长度** + 信封标量。
 *    **只记键名与长度，不记这些键的值**（值归 `respBody` 管，且它已脱敏）。
 * 2. **`respBody`**：**响应体内容（脱敏后）**，本模块的主体；超上限截断并如实注明。
 * 3. **`unpack`**：**解包退化标记** —— 端点规格要求的负载字段没出现时显式写 `degraded: …`，
 *    以后"信封没按规格下发"这件事一眼可见（与解包兜底是同一条链的两侧，这里只负责留痕）。
 *
 * ## 🔴 隐私红线（判据可执行）
 * 落盘的**每一步都必须先脱敏**，顺序固定（见 `summarizeResponseBody()`）：
 *   ① **字段名**脱敏（`redactValue` / `SENSITIVE_KEYS`：token/auth/sncode/studentname/phone…）；
 *   ② **已知原值替换**（`knownValuePairs()`：从请求体里取到的学号/姓名/手机 → 掩码形态）；
 *   ③ **token 样式串**（`maskTokenLike`：`WXXCX…` 长串 → `[token len=N]`）；
 *   ④ **8~18 位纯数字**（`maskDigitRuns`，与诊断快照同一判据；窗口 id 例外也同源）。
 * 单测 `tests/mp/responseRecord.test.ts` 直接构造"响应里带真 token / 学号 / 姓名 / 手机"的用例，
 * 断言落盘文本**命中掩码且不含原值**（红线这条最怕"看起来在脱敏、其实漏了一路"）。
 *
 * ## 上限与轮转（口径写清楚，免得以后互相矛盾）
 * - **单条**响应的内容上限 `RESP_BODY_MAX_BYTES = 32 KB`（默认）：超出先"瘦身"（数组留头尾 + 记总长），
 *   仍超就只留顶层键名 + `truncated:true` + `originalBytes`。**结构与截断信息永不丢**。
 * - **文件轮转沿用现状**（`server/utils/logger.ts`：按天一个文件、保留 7 天 / 总量 20MB），
 *   本模块**不引入第二套轮转**；体积影响见 `DEVELOPMENT.md` 的那一节（实测对照）。
 *
 * ## 非 JSON 响应怎么记（取舍理由）
 * 记 **`content-type` + 前 `RESP_TEXT_PREVIEW_CHARS`（512）字符**的脱敏预览，而不是"只记 content-type"：
 * 上游偶发返回 HTML 错误页 / 纯文本报错（网关 502、鉴权拦截），**那几百个字符往往就是根因**；
 * 只记 `content-type` 等于把这些线索全丢掉。512 字符的上限保证它不会让日志失控。
 */
import { PERSON_NAME_KEY_RE, REDACTED_MARK, SENSITIVE_KEYS, knownValuePairs, maskTokenLike, redactValue } from './logFormat'
import { maskDigitRuns } from './diagnostics'

/** 单条响应的**内容**上限（字节，UTF-8）；超出即瘦身/截断并如实标记 */
export const RESP_BODY_MAX_BYTES = 32 * 1024
/** 非 JSON 响应最多记多少个字符（脱敏后） */
export const RESP_TEXT_PREVIEW_CHARS = 512

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

/** 对照表从 `logFormat` 统一出口转出（诊断与「全记录」共用一份判据，别处不要再抄） */
export { knownValuePairs }

/**
 * 坐标类字段名（**唯一一份**；界面与服务端都从这里 import，别处不要再抄一份）。
 *
 * ⚠️ 2026-09-22 审计（可疑 6）：原先界面 `DiagnosticsExportCard.vue` 里还有一份同名拷贝，
 * 注释却写"同一份名单" —— 两边各改一边时，"关掉坐标开关"就可能只剥掉一部分（隐私开关半失效）。
 * 现在只有这一处定义，界面通过 `~/utils/mp/responseRecord` import。
 */
export const COORD_KEYS = new Set(['latitude', 'longitude', 'lat', 'lng', 'pointList', 'sunrunPathPointList', 'routeItudes'])

/** `respShape.envelope` 里会照记的"信封标量"字段名（**值必须脱敏**，见 `summarizeRespShape`） */
const ENVELOPE_SCALAR_KEYS = ['status', 'code', 'msg', 'message', 'total', 'success', 'timestamp', 'serverTime'] as const

/**
 * 把「全记录」里的坐标字段剥掉（**导出时**按用户的「包含跑道/任务坐标」开关决定要不要调）。
 *
 * 为什么需要：`respBody` 是**响应原文的脱敏副本**，而任务/线路响应里就带着经纬度
 * （`pointList[].latitude/longitude`）。用户在界面上关掉"包含坐标"时，包里**不该**还有坐标 ——
 * 否则那个开关只是"少给你自己的轨迹"，却把**服务端日志里的坐标**照发出去，名不副实。
 *
 * 判据（可执行）：递归地把 `COORD_KEYS` 里的键**整键删除**（不是置空），其余字段一个不动；
 * 非 JSON 的 `respBody.text` 走**字符串级**替换（`"latitude":"…"` → `"latitude":"[坐标已按开关省略]"`）。
 *
 * @param record `respBody` 那个对象（原样传入，不改原值；返回新对象）
 */
export function stripGeometryFromRespBody(record: unknown): unknown {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip)
    if (!isObj(v)) return v
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      if (COORD_KEYS.has(k)) continue
      out[k] = strip(val)
    }
    return out
  }
  if (!isObj(record)) return record
  const out: Record<string, unknown> = { ...record }
  if (out.body !== undefined) out.body = strip(out.body)
  if (typeof out.text === 'string') {
    let t = out.text
    for (const k of COORD_KEYS) {
      t = t.replace(new RegExp(`"${k}"\\s*:\\s*("[^"]*"|\\[[^\\]]*\\]|[^,}\\s]+)`, 'g'), `"${k}":"[坐标已按开关省略]"`)
    }
    out.text = t
  }
  return out
}

/**
 * **唯一的脱敏出口**：任意值 → 可落盘的文本/结构。
 * 顺序见文件头（字段名 → 已知原值 → token 样式 → 数字串），四步都由契约层/纯逻辑层实现，不在这里另写一套。
 *
 * ⚠️ 深度上限**高于** `redactValue` 默认的 4 层（见 `logFormat.ts`，`[deep]` 会**整段丢掉内容**）：
 * 「全记录」的意义就是"内容也留下"，实测中 `data.runPointList[0].pointList` 这种第 4~5 层
 * 在默认深度下会变成 `[deep]`（坐标与线路点列全没了 ⇒ 又变成"看不出关键事实"）。
 * 这里放宽到 8 层；真正的体积约束由**字节上限**负责（`RESP_BODY_MAX_BYTES`），不靠砍层数。
 */
export const RECORD_REDACT_MAX_DEPTH = 8
/** `redactForRecord()` 的产物：脱敏后的值 + **脱敏阶段丢掉了什么**（如实上报，不静默） */
export interface RecordRedactResult {
  value: unknown
  /** 被脱敏阶段裁掉的元素个数（`redactValue` 的数组上限 20；0 = 没裁） */
  droppedItems: number
  /** 被裁过的路径（供 `note` 里解释"为什么这里的数组变短了"） */
  trimmedPaths: string[]
}
export function redactForRecordWithStats(
  value: unknown,
  known: { raw: string; masked: string }[] = [],
  maxDepth = RECORD_REDACT_MAX_DEPTH,
  arrayCap = 20,
): RecordRedactResult {
  const trimmedPaths: string[] = []
  let droppedItems = 0
  /**
   * 🔴 **键名也要脱敏**（2026-09-22 审计 B5）：实测 `{"data":{"2021101234":{…},"张小明":{…}}}`
   * 这种"把学号/姓名当键"的响应，键名在 `respBody` 与 `respShape.nested` **两处**原样落盘。
   * 判据：键名同样跑"token 样式 + 已知原值 + 数字兜底"，**只改文本、不合并键**（结构不变）。
   */
  /** 字段名是否敏感（含"看起来就是人名"的键 —— 审计 B5） */
  const isSensitiveKey = (k: string): boolean => PERSON_NAME_KEY_RE.test(k) || SENSITIVE_KEYS.test(k)
  /**
   * 键名脱敏：**只改文本、不合并键**（结构不变）。
   * ⚠️ "看起来就是人名"的键**换成固定占位**，不能只是把值掩掉 ——
   * 审计 B5 的原话是"学号/姓名在 `respBody` 与 `respShape.nested` 两处原样"，
   * 键名留着 `张小明` 本身就等于把姓名写进了包（实测：`{"张小明":"[masked len=8]"}` 仍然带着姓名）。
   */
  const maskKey = (k: string): string => {
    const s = String(k)
    if (PERSON_NAME_KEY_RE.test(s)) return '[姓名已掩码]'
    let out = maskTokenLike(s)
    for (const p of known) out = out.split(p.raw).join(p.masked)
    return maskDigitRuns(out)
  }
  /**
   * ④ 数字串兜底：**字符串与数字都要判**（审计 B4）。
   * 实测 `{"list":[2021101234,13812345678]}` 是 JSON **number**，只判 `typeof === 'string'` 会原样落盘。
   * 判据：8~18 位**整数**（无小数/无科学计数）才当学号/手机处理；其它数字原样（别把 3.14 掩了）。
   */
  const maskDigits = (v: unknown): unknown => {
    if (typeof v === 'string') return maskDigitRuns(v)
    if (typeof v === 'number' && Number.isInteger(v)) {
      const s = String(v)
      if (s.length >= 8 && s.length <= 18) return maskDigitRuns(s)
      return v
    }
    if (Array.isArray(v)) return v.map(maskDigits)
    if (!isObj(v)) return v
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[maskKey(k)] = maskDigits(val)
    return out
  }
  /**
   * 脱敏主流程：**只做掩码，不做"字节瘦身"**（那是 `summarizeResponseBody()` 的阶段）。
   * 这里对超长数组的裁剪**必须留下"原共 N 项"**（而不是静默少给）——
   * 实测踩到：第一版静默裁到 20 项，于是"响应 300 条 → 日志 20 条"根本看不出来。
   */
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (depth > maxDepth) return v
    if (Array.isArray(v)) {
      if (v.length > arrayCap) {
        droppedItems += v.length - arrayCap
        trimmedPaths.push(path || '[]')
        const head = v.slice(0, arrayCap).map((item, i) => walk(item, `${path}[${i}]`, depth + 1))
        return [...head, `…[省略 ${v.length - arrayCap} 项，原共 ${v.length} 项]`]
      }
      return v.map((item, i) => walk(item, `${path}[${i}]`, depth + 1))
    }
    if (isObj(v)) {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        const safeKey = maskKey(k)
        const childPath = path ? `${path}.${safeKey}` : safeKey
        // 字段名敏感 ⇒ 交给 redactValue 统一掩码（口径单一来源）
        out[safeKey] = isSensitiveKey(safeKey) ? redactValue(safeKey, val, 0, known, maxDepth) : walk(val, childPath, depth + 1)
      }
      return out
    }
    if (typeof v === 'string') {
      let s = v
      for (const p of known) s = s.split(p.raw).join(p.masked)
      return maskTokenLike(s)
    }
    return v
  }
  // ① 字段名脱敏/② 已知原值/③ token 样式 都在 walk 里；④ 数字兜底整体再走一遍（顺序与模块头一致）
  const out = maskDigits(walk(value, '', 0))
  /**
   * 🔒 打上"**已经脱敏过**"的标记（非枚举 Symbol，不进 JSON）：`server/utils/logger.ts` 的
   * `redactObject()` 看到它就不再二次降深度（审计 B2：否则 `respBody` 在日志行根之下只剩 ~6 层，
   * `depth≥6` 的值被塌成 `[deep]`，"全记录"名不副实）。
   */
  if (isObj(out)) Object.defineProperty(out, REDACTED_MARK, { value: true, enumerable: false })
  return { value: out, droppedItems, trimmedPaths }
}

/**
 * **唯一的脱敏出口**：任意值 → 可落盘的文本/结构。
 * 顺序见文件头（字段名 → 已知原值 → token 样式 → 数字串），四步都由契约层/纯逻辑层实现，不在这里另写一套。
 *
 * ⚠️ 深度上限**高于** `redactValue` 默认的 4 层（见 `logFormat.ts`，`[deep]` 会**整段丢掉内容**）：
 * 「全记录」的意义就是"内容也留下"，实测中 `data.runPointList[0].pointList` 这种第 4~5 层
 * 在默认深度下会变成 `[deep]`（坐标与线路点列全没了 ⇒ 又变成"看不出关键事实"）。
 * 这里放宽到 8 层；真正的体积约束由**字节上限**负责（`RESP_BODY_MAX_BYTES`），不靠砍层数。
 */
export function redactForRecord(value: unknown, known: { raw: string; masked: string }[] = [], maxDepth = RECORD_REDACT_MAX_DEPTH): unknown {
  return redactForRecordWithStats(value, known, maxDepth).value
}

/** `respShape` 的形状（只记键名与长度，**不记这些键的值**） */
export interface RespShape {
  /** 顶层键名（排序；超出 `maxKeys` 时截断并在 `keysMore` 记差几个） */
  keys: string[]
  keysMore?: number
  /** 嵌套 2~3 层的键名路径，如 `["data","data.mileage","sunrunTaskList[0].runPointList"]` */
  nested: string[]
  /** 数组长度（**只记长度**）：路径 → 条数 */
  arrays: Record<string, number>
  /** 信封自身的标量（这几个是诊断最关心的状态码/消息，**不是**业务内容） */
  envelope: Record<string, unknown>
  [k: string]: unknown
}

/** `summarizeRespShape()` 的可选参数 */
export interface RespShapeOptions {
  /**
   * 嵌套层数上限（默认 **4** = 顶层 + 3 层嵌套）。
   * 为什么是 4 而不是 3：`data.runPointList[0].pointName` 这种"**数组元素里的键名**"要到第 4 层才走得到，
   * 而那正是最有用的一层（"每条线路里有哪些字段"）；只到 3 会把它漏掉（实测踩到）。
   */
  maxDepth?: number
  /** `keys` / `nested` 各自最多列多少个（默认 40） */
  maxKeys?: number
  /** 数组最多枚举几个元素来找嵌套结构（默认 2） */
  maxArrayProbe?: number
}

/**
 * **响应结构摘要**（纯函数）：顶层键名 + 嵌套键名 + 数组长度 + 信封标量。
 * ⚠️ 只产出**键名与长度**；`envelope` 里那几个"状态/消息"字段是**自由文本**，必须脱敏（见下）。
 *
 * 🔴 2026-09-22 审计 B3：`envelope.msg` 实测会写 `"未找到用户 2021101234 登录失败"` ⇒ 学号明文落盘
 * （而同一行的 `respBody.msg` 却是掩过的 —— 前后矛盾，且这正是"看着脱敏了其实漏一路"）。
 * 现在 envelope 的每个值都过 `redactValue` + `maskDigitRuns`；键名也过 `maskKey`。
 *
 * @param known 已知原值对照表（从请求体取到的学号/姓名/手机；`knownValuePairs()` 的产物）
 */
export function summarizeRespShape(json: unknown, opts: RespShapeOptions = {}, known: { raw: string; masked: string }[] = []): RespShape {
  const maxDepth = opts.maxDepth ?? 4
  const maxKeys = opts.maxKeys ?? 40
  const maxArrayProbe = opts.maxArrayProbe ?? 2
  /** 键名脱敏：结构不变，只把"像学号/token/人名 的键"掩掉（审计 B5 —— 学号/姓名可能被当成键） */
  const maskKey = (k: string): string => {
    const s = String(k)
    // 人名键换成固定占位（只掩值不够：键名本身就把姓名写进包了）
    if (PERSON_NAME_KEY_RE.test(s)) return '[姓名已掩码]'
    let out = maskTokenLike(s)
    for (const p of known) out = out.split(p.raw).join(p.masked)
    return maskDigitRuns(out)
  }
  /** 信封标量的值脱敏（自由文本走 `redactValue` + 数字兜底） */
  const maskScalar = (k: string, v: unknown): unknown => {
    if (typeof v === 'string') return maskDigitRuns(String(redactValue(k, v, 0, known)))
    if (typeof v === 'number' && Number.isInteger(v)) {
      const s = String(v)
      return s.length >= 8 && s.length <= 18 ? maskDigitRuns(s) : v
    }
    return v
  }
  if (!isObj(json)) {
    return { keys: [], nested: [], arrays: Array.isArray(json) ? { '[]': json.length } : {}, envelope: { kind: Array.isArray(json) ? 'array' : typeof json } }
  }
  const allKeys = Object.keys(json).sort() // **排序**：结构摘要要可 diff（同一响应每次落盘的键序一致）
  const top = allKeys.slice(0, maxKeys).map(maskKey)
  const nested: string[] = []
  const arrays: Record<string, number> = {}
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > maxDepth) return
    if (Array.isArray(v)) {
      arrays[path || '[]'] = v.length
      const probe = Math.min(v.length, maxArrayProbe)
      for (let i = 0; i < probe; i++) {
        if (isObj(v[i])) walk(v[i], `${path}[${i}]`, depth + 1)
      }
      return
    }
    if (!isObj(v)) return
    for (const k of Object.keys(v).slice(0, maxKeys)) {
      const safeKey = maskKey(k)
      const childPath = path ? `${path}.${safeKey}` : safeKey
      const child = v[k]
      if (nested.length < maxKeys * 3) nested.push(childPath)
      if (Array.isArray(child)) arrays[childPath] = child.length
      walk(child, childPath, depth + 1)
    }
  }
  for (const k of top) {
    const v = json[k]
    if (isObj(v) || Array.isArray(v)) walk(v, k, 1)
  }
  /** 信封标量：**值和键名都脱敏**（审计 B3 —— 这里是自由文本，实测带学号） */
  const envelope: Record<string, unknown> = {}
  for (const k of ENVELOPE_SCALAR_KEYS) {
    if (json[k] === undefined || json[k] === null || json[k] === '') continue
    envelope[k] = maskScalar(k, json[k])
  }
  return { keys: top, ...(allKeys.length > top.length ? { keysMore: allKeys.length - top.length } : {}), nested, arrays, envelope }
}

/**
 * `unpackNote()` 的结果：上游响应里"**负载没按规格出现在顶层、而是藏在信封里**"的**通用**检测。
 *
 * ## 为什么是"通用检测"而不是逐端点规格比对（取舍，别以为是漏了）
 * 逐端点比对需要 `MP_ENDPOINTS[key].payload`（`src/mp/endpoints.ts`），而本模块刻意**不**引端点表：
 *   ① 端点表属于契约层，且**另一个 agent 正在改解包兜底**（同一件事的两侧）——两边同时动它会互相打架；
 *   ② 代理进程里拿到的只有路径后缀，没有"路径 → 端点键"的反查表（要加就得改 `src/mp/endpoints.ts`）。
 * 于是这里只报**结构事实**（客观、不依赖规格）：
 *   · 响应顶层**除了信封字段（`status/code/msg/header/…`）之外什么都没有**；
 *   · 而它带着 `data` / `obj` / `body` / `result` 之一（或唯一那个非信封键**是个对象/数组**）。
 * 这种情况下"业务负载在信封里那一层"几乎是必然 —— 代理日志因此显式留痕 `suspect: …`。
 */
export interface UnpackNote {
  /** `'ok'` = 负载就在顶层（或响应本来就不是信封）；`'suspect'` = 疑似"负载在信封里" */
  status?: 'ok' | 'suspect'
  /** 非信封的顶层键（真正承载业务内容的候选） */
  payloadKeys: string[]
  /** 疑似承载负载的信封字段名（`data` / `obj` / `body` / `result`） */
  envelopeField: string
  /** 建议去看的路径（如 `data.runPointList`） */
  hint: string
}

/**
 * 信封自身的字段名（判断"顶层是不是只剩信封"时排除掉它们）。
 *
 * ⚠️ 含 `sunrunTaskList`：**这是真实用户那次的关键** —— `sunrunPaper` 的真实响应是
 * `{status, code, data:{runPointList:[…]}, sunrunTaskList:[…]}`，如果只把 `status/code/msg` 当信封，
 * 那个 `sunrunTaskList` 数组就会让 `topLevelHasPayload` 判真 ⇒ 检测失效、**一个 suspect 都不会报**。
 * 判据因此取"信封字段的**并集**"：信封标量 + 供应商的下发列表字段（`sunrun*List` / `getSunrunPaper*`）。
 */
const ENVELOPE_KEYS = new Set(['status', 'code', 'msg', 'message', 'header', 'success', 'timestamp', 'serverTime', 'total'])
/**
 * 供应商把"下发的任务/线路"挂在信封顶层的字段名（`sunrunTaskList` / `getSunrunPaperResponseList` …）。
 * ⚠️ 用**前缀 + 不区分大小写**判（第一版写成 `^sunrun[A-Za-z]*List$`，实际字段是 `sunrunTaskList`
 * 里的小写 `unrun`，正则匹配不上 ⇒ 检测整个失效、一个 suspect 都不报 —— 实测踩到）。
 */
const ENVELOPE_LIST_KEYS_RE = /^(sunrun|getsunrun)/i
/** 疑似承载业务负载的信封字段名（按优先级） */
const PAYLOAD_FIELDS = ['data', 'obj', 'body', 'result'] as const

/** 这个顶层键算不算"信封自己的"（不算业务负载） */
const isEnvelopeKey = (k: string): boolean => ENVELOPE_KEYS.has(k) || ENVELOPE_LIST_KEYS_RE.test(k)

/**
 * 🆕 2026-09-22（审计 可疑 2）：**判据收窄** —— 只在"结构上确实多包了一层"时才报 `suspect`。
 *
 * 老实现"有 `data/obj/body/result` 且顶层没有其它键"就报 suspect ⇒ **误报一片**：
 * 端点表里 57 个端点有 **23 个**的负载规格本来就是 `body` / `obj` / `data`
 * （例如 `selectSunRunStartConfiguration` 的规格就是 `body`）⇒ 正常响应也写 suspect，
 * 这个标记很快会失去信任（维护者会学会无视它，那就等于没有）。
 *
 * 现在的"多包一层"判据（**结构性事实**，不依赖端点表）：
 *   ① 顶层出现了**供应商自己的下发列表**（`sunrunTaskList` / `getSunrunPaperResponseList` …）⇒ 这本身就是信封特征；
 *   ② 或信封字段里装的是**业务数组**（`data.runPointList` 这种非空数组）而顶层一个数组都没有；
 *   ③ 或信封字段里的对象**看起来像任务本体**（`looksLikeTask` 那一套字段名）。
 * 命中任一条才算 suspect；其余一律 ok。
 */
export function unpackNote(json: unknown): UnpackNote {
  if (!isObj(json)) return { status: 'ok', payloadKeys: [], envelopeField: '', hint: '' }
  const keys = Object.keys(json)
  const payloadKeys = keys.filter((k) => !isEnvelopeKey(k))
  const envelopeField = PAYLOAD_FIELDS.find((f) => json[f] !== undefined && json[f] !== null) ?? ''
  if (!envelopeField) {
    // 没有承载字段 ⇒ 负载本来就该在顶层，一律 ok
    return { status: 'ok', payloadKeys, envelopeField: '', hint: '' }
  }
  const inner = json[envelopeField]
  const innerKeys = isObj(inner) ? Object.keys(inner) : []
  const innerArrays = isObj(inner) ? Object.entries(inner).filter(([, v]) => Array.isArray(v) && v.length > 0) : []
  /** ① 顶层有"供应商下发列表"（`sunrunTaskList` 之类）——这就是信封特征 */
  const vendorListAtTop = keys.some((k) => ENVELOPE_LIST_KEYS_RE.test(k) && Array.isArray(json[k]) && (json[k] as unknown[]).length > 0)
  /** ② 信封里是业务数组，而顶层一个非空数组都没有 */
  const topHasNonEmptyArray = keys.some((k) => Array.isArray(json[k]) && (json[k] as unknown[]).length > 0)
  /** ③ 信封里的对象看起来像**任务本体**（用 `runPointList`/`taskId` 这种"任务专属"字段判，别用 `paperName` —— 太宽） */
  const innerLooksLikeTask = isObj(inner) && ['runPointList', 'taskId'].some((k) => inner[k] !== undefined)
  const suspect = vendorListAtTop || (innerArrays.length > 0 && !topHasNonEmptyArray) || innerLooksLikeTask
  if (!suspect) return { status: 'ok', payloadKeys, envelopeField, hint: '' }
  const hint = innerArrays.length ? `${envelopeField}.${innerArrays[0]![0]}` : innerKeys.length ? `${envelopeField}.${innerKeys[0]}` : envelopeField
  return { status: 'suspect', payloadKeys, envelopeField, hint }
}

/** `respBody` 的形状 */
export interface RespBodyRecord {
  /** 落盘形态：`json`（已脱敏的对象）/ `text`（非 JSON 的前缀预览）/ `empty`（空响应） */
  kind: 'json' | 'text' | 'empty'
  /** 原始字节数（**截断前**） */
  originalBytes: number
  /** 落盘内容的字节数（截断后） */
  bytes: number
  /**
   * 是否被截断/瘦身。⚠️ 判据**包含脱敏阶段的裁剪**（长数组被裁到 20 项也算）：见 `droppedItems`。
   * 第一版只看"字节上限"，于是"响应 300 条记录 → 日志 20 条"这种情况 `truncated` 仍然是 false
   * ⇒ 维护者会以为"响应里本来就只有 20 条"（实测踩到）。现在两者都会翻成 `true`。
   */
  truncated: boolean
  /** 🆕 脱敏阶段丢掉的元素个数（长数组裁剪；0 = 没裁） */
  droppedItems?: number
  /** 🆕 被裁/被省略的路径（自报"哪里不完整"，审计 B2 要求） */
  trimmedPaths?: string[]
  /** 非 JSON 时记的 content-type */
  contentType?: string
  /** JSON 响应：脱敏后的对象（可能已瘦身） */
  body?: unknown
  /** 非 JSON 响应：脱敏后的前缀 */
  text?: string
  /** 截断说明（人话，落盘可见） */
  note?: string
}

/**
 * 数组瘦身：超过 `arrCap` 的数组只留**头 `head` 个 + 尾 `tail` 个**，中间替换成一句说明
 * （**保留总长度**，因为"一共几条"往往才是关键事实）。
 *
 * ⚠️ 深度上限必须够大（**实测踩到**）：第一版写 `depth > 4`，而 `data.runPointList[0].pointList`
 * 这种真实结构在第 5~7 层才碰到那个大数组 ⇒ 瘦身**根本没生效**，最后直接掉到"只留顶层键名"，
 * 维护者看到的是 `data:"[对象，键：runPointList]"`（连"一共几条"都没了）。
 * 体积约束由字节上限负责；这里只做"把大数组换成人话"，层数限制放宽到基本无感。
 */
function shrink(value: unknown, depth: number, arrCap: number, opts: { head: number; tail: number }): unknown {
  if (depth > 16) return value
  if (Array.isArray(value)) {
    if (value.length <= arrCap) return value.map((v) => shrink(v, depth + 1, arrCap, opts))
    const head = value.slice(0, opts.head).map((v) => shrink(v, depth + 1, arrCap, opts))
    const tail = opts.tail > 0 ? value.slice(-opts.tail).map((v) => shrink(v, depth + 1, arrCap, opts)) : []
    return [...head, `…[省略 ${value.length - head.length - tail.length} 项，原共 ${value.length} 项]`, ...tail]
  }
  if (!isObj(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = shrink(v, depth + 1, arrCap, opts)
  return out
}

/** 只留顶层键名（最后一道兜底；保证"结构与截断事实"仍然落盘） */
function keysOnly(value: unknown): unknown {
  if (Array.isArray(value)) return `[数组，共 ${value.length} 项]`
  if (!isObj(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = Array.isArray(v) ? `[数组，共 ${v.length} 项]` : isObj(v) ? `[对象，键：${Object.keys(v).slice(0, 12).join(',')}${Object.keys(v).length > 12 ? '…' : ''}]` : v
  }
  return out
}

/**
 * 🔴 **按字节预算重建**（2026-09-22 审计 B1：`maxBytes` 以前形同虚设）。
 *
 * 故障实测：顶层 40 个各 2 KB 的字符串 ⇒ 落盘 **80351 B**（上限 32768）；单个 100 KB 标量 ⇒ **100014 B**；
 * 真 logger 上跑一次 10 MB 响应 ⇒ 磁盘新增 **10000334 B**。原因：三档降级都只"瘦数组/只留键名"，
 * **没有任何一档按字节砍字符串值**，而顶层标量字符串直接原样进 JSON。
 *
 * 判据（可执行）：从根开始**按序填槽**，每个槽位的文本在写入前先算字节数；放不下就把**这个槽位**降级成
 * 一句说明（标量记 `N 字节已省略`、对象记键名、数组记条数），**绝不让落盘超过 `maxBytes`**。
 * 顺序：对象按 `Object.keys` 原序（信封标量通常在最前 ⇒ 状态码/消息优先保住），数组先头后尾。
 */
function budgetedFill(value: unknown, budget: number, depth = 0): { value: unknown; overflow: boolean } {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value) ?? 'null'
    const bytes = byteLen(text)
    if (bytes <= budget) return { value, overflow: false }
    return { value: `[标量 ${bytes} 字节已省略]`, overflow: true }
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    let used = 2
    let overflow = false
    let emitted = 0
    for (let i = 0; i < value.length; i++) {
      const filled = depth > 12 ? { value: '[层级过深]', overflow: true } : budgetedFill(value[i], Math.max(0, budget - used - 1), depth + 1)
      const bytes = byteLen(JSON.stringify(filled.value) ?? 'null') + 1
      if (used + bytes > budget) {
        overflow = true
        break
      }
      out.push(filled.value)
      emitted++
      used += bytes
      if (filled.overflow) overflow = true
    }
    // 尾巴也尽量留（"最新的几条"往往比中间的更值钱）
    let tailKept = false
    if (overflow && emitted < value.length && budget - used > 120) {
      const tailBudget = Math.min(budget - used - 40, 400)
      const tail = budgetedFill(value[value.length - 1], tailBudget, depth + 1)
      const tailBytes = byteLen(JSON.stringify(tail.value) ?? 'null') + 1
      if (used + tailBytes <= budget) {
        out.push(tail.value)
        tailKept = true
        used += tailBytes
      }
    }
    if (emitted < value.length) {
      const omitted = value.length - emitted - (tailKept ? 1 : 0)
      out.push(`…[省略 ${omitted} 项，原共 ${value.length} 项]`)
    }
    return { value: out, overflow: overflow || emitted < value.length }
  }
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  let used = 2
  let overflow = false
  for (const [k, v] of Object.entries(obj)) {
    const keyBytes = byteLen(JSON.stringify(k)) + 2
    const filled = depth > 12 ? { value: '[层级过深]', overflow: true } : budgetedFill(v, Math.max(0, budget - used - keyBytes), depth + 1)
    const valBytes = byteLen(JSON.stringify(filled.value) ?? 'null') + 1
    if (used + keyBytes + valBytes > budget) {
      overflow = true
      // 这个槽位放不下 ⇒ 换成一句"它有多大"的说明（结构还在，内容不再占字节）
      const brief = briefOf(v)
      const briefBytes = byteLen(JSON.stringify(brief)) + 1 + keyBytes
      if (used + briefBytes <= budget) {
        out[k] = brief
        used += briefBytes
      }
      continue
    }
    out[k] = filled.value
    used += keyBytes + valBytes
    if (filled.overflow) overflow = true
  }
  return { value: out, overflow }
}

/** 一个"放不下的槽位"的极简说明（结构信息优先：键名 / 条数 / 字节数） */
function briefOf(v: unknown): string {
  if (Array.isArray(v)) return `[数组，共 ${v.length} 项]`
  if (isObj(v)) return `[对象，键：${Object.keys(v).slice(0, 12).join(',')}${Object.keys(v).length > 12 ? '…' : ''}]`
  const text = JSON.stringify(v) ?? 'null'
  return `[标量 ${byteLen(text)} 字节已省略]`
}

/**
 * **响应体记录（"全记录"的主体）**：先脱敏、再按上限瘦身/截断，最后给出可落盘的结构。
 *
 * @param text      上游响应的**原始文本**
 * @param parsed    `JSON.parse(text)` 的结果；`undefined` = 非 JSON（此时只记前缀）
 * @param known     `knownValuePairs()` 的产物（从请求体取到的学号/姓名/手机）
 * @param maxBytes  单条内容上限（默认 `RESP_BODY_MAX_BYTES`）
 * @param contentType 上游 `content-type`（非 JSON 时记下来，便于判断是什么东西）
 */
export function summarizeResponseBody(
  text: string,
  parsed: unknown,
  known: { raw: string; masked: string }[] = [],
  maxBytes: number = RESP_BODY_MAX_BYTES,
  contentType = '',
): RespBodyRecord {
  const raw = String(text ?? '')
  const originalBytes = byteLen(raw)
  if (raw.trim() === '') return { kind: 'empty', originalBytes, bytes: 0, truncated: false, ...(contentType ? { contentType } : {}) }
  if (parsed === undefined) {
    /**
     * 非 JSON：只记脱敏后的前缀。
     *
     * 🔴 审计 B10：**顺序必须是"先脱敏整段、再截断"**。老实现先 `slice(0, 512)` 再脱敏 ⇒
     * 一个跨越第 512 字节的 token 会被切成 `WXXCXAb3kZ9_`（不匹配 token 正则、红线也不命中）**留在盘上**。
     * 现在：对"512 + 64 余量"的整段脱敏 → 截 512 → **末尾再补一次 `maskTokenLike`**（防边界残段）。
     */
    const PREVIEW = RESP_TEXT_PREVIEW_CHARS
    const SLACK = 64
    const head = raw.slice(0, PREVIEW + SLACK)
    let redacted = String(redactForRecord(head, known))
    // 再走一遍值级替换（`redactForRecord` 已做，这里是"边界残段"的第二道）
    redacted = maskTokenLike(redacted)
    const clipped = redacted.length > PREVIEW ? redacted.slice(0, PREVIEW) : redacted
    const safe = maskTokenLike(clipped)
    return {
      kind: 'text',
      originalBytes,
      bytes: byteLen(safe),
      truncated: raw.length > PREVIEW,
      ...(contentType ? { contentType } : {}),
      text: safe,
      ...(raw.length > PREVIEW ? { note: `非 JSON，只记前 ${PREVIEW} 字符（已脱敏；截断边界又补了一次凭证掩码）` } : {}),
    }
  }
  const stats = redactForRecordWithStats(parsed, known)
  const redacted = stats.value
  /** 脱敏阶段裁掉过长数组时也要如实说（否则"响应 300 条 → 日志 20 条"看不出来） */
  const droppedNote = stats.droppedItems > 0 ? `脱敏时裁掉过长数组的 ${stats.droppedItems} 个元素（${stats.trimmedPaths.slice(0, 3).join('、')}）` : ''
  let text2 = JSON.stringify(redacted)
  if (byteLen(text2) <= maxBytes) {
    return {
      kind: 'json',
      originalBytes,
      bytes: byteLen(text2),
      truncated: stats.droppedItems > 0,
      ...(stats.droppedItems > 0 ? { droppedItems: stats.droppedItems, note: droppedNote } : {}),
      body: redacted,
    }
  }
  // ① 瘦身：大数组只留头尾（**保留总长度**）
  const shrunk = shrink(redacted, 0, 20, { head: 10, tail: 2 })
  text2 = JSON.stringify(shrunk)
  if (byteLen(text2) <= maxBytes) {
    return {
      kind: 'json',
      originalBytes,
      bytes: byteLen(text2),
      truncated: true,
      ...(stats.droppedItems > 0 ? { droppedItems: stats.droppedItems } : {}),
      body: shrunk,
      note: `超过单条上限 ${maxBytes} 字节，已瘦身（大数组只留头尾并记总长）${droppedNote ? `；${droppedNote}` : ''}`,
    }
  }
  /**
   * ② **按字节预算逐槽填充**（审计 B1 的核心修复）：这一档是唯一能保证"落盘 ≤ maxBytes"的，
   * 因为只有它会按字节砍**标量字符串**。到这一档时把预算留一点余量给"省略说明"。
   */
  const budget = Math.max(256, maxBytes - 64)
  const filled = budgetedFill(redacted, budget)
  text2 = JSON.stringify(filled.value)
  let body = filled.value
  let note = `超过单条上限 ${maxBytes} 字节，已按字节预算逐键填充（放不下的值写成"已省略"说明；原始 ${originalBytes} 字节）`
  // 兜底：极端情况（预算算错/编码差异）再把非 ASCII 字符串换成说明，确保**一定**不超限
  if (byteLen(text2) > maxBytes) {
    body = keysOnly(redacted)
    text2 = JSON.stringify(body)
    note = `超过单条上限 ${maxBytes} 字节，只保留顶层键名（原始 ${originalBytes} 字节）`
  }
  return {
    kind: 'json',
    originalBytes,
    bytes: byteLen(text2),
    truncated: true,
    ...(stats.droppedItems > 0 ? { droppedItems: stats.droppedItems } : {}),
    body,
    note: `${note}${droppedNote ? `；${droppedNote}` : ''}`,
    ...(stats.trimmedPaths.length ? { trimmedPaths: stats.trimmedPaths.slice(0, 8) } : {}),
  }
}
