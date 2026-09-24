/**
 * 「一键诊断记录 / 导出」的**唯一契约**（纯逻辑层，无依赖，可离线单测）—— 2026-09-21 新增
 *
 * ## 为什么要有它（用户诉求）
 * 现有服务端日志**只记"每个请求的元数据"**（端点 / HTTP / 耗时 / 字节数 / upstream 原话 /
 * `body` 的**字节数与字段名列表**），**看不到字段内容**（数组长度、线路明细、任务正文都没有）；
 * 而真正排障需要的东西其实**本机都有、只是没进日志**：
 *   ① 完整任务 JSON（localStorage `mp_real_task_v1`）
 *   ② 描过的跑道（`mp_track_library_v1`）
 *   ③ 门禁判定结果与依据（内存里的 `gateStatus`）
 *   ④ 应用内事件时间线（"用户点了什么、按什么顺序"）
 * 于是 issue #12 这类问题（"研究生院没有线路可选"）只能靠用户截三张图 + 手工翻 `%TEMP%` 目录。
 * 本功能：用户点「开始记录」→ 复现问题 → 点「结束并导出」→ 得到一个 **zip** 发给维护者。
 *
 * ## 🔴 隐私红线（**任何实现都不得违反**）
 * 1. **token 明文绝不进包** —— 只允许出现"长度 + 指纹"（口径与现有日志一致）。
 *    有单测 `tests/mp/diagnostics.test.ts` 直接断言导出内容里不含 `token=`/`Bearer`/长串凭证；
 * 2. 学号 / 姓名 / 手机号一律**掩码**（见 `maskId` / `maskName`）；
 * 3. 轨迹与跑道**坐标**属于位置隐私 ⇒ 允许包含（诊断拟合度/线路必须用），但**导出前必须在界面上告知**；
 * 4. 导出前先在界面上列出"这个包里会包含什么"（由 `diagManifestEntries` 生成，界面与服务端共用）。
 *
 * ## 分工
 * - **客户端**：采集并**脱敏**后的快照（`DiagSnapshot`）→ POST 到 `DIAG_EXPORT_PATH`；
 * - **服务端**：读自己的日志目录（最近 `DIAG_LOG_DAYS` 天）→ 与快照、`manifest.json` 一起打成 zip 返回。
 *   日志由**服务端自己读**（不经过浏览器）⇒ 用户不需要找目录，token 也不可能因此泄漏到前端。
 *
 * ## 🆕 2026-09-22（issue #12 二次返工）：「这一次记录」= **服务端锚定的记录窗口**
 * 用户的原始抱怨是「刷新为什么会丢？我们要做的是**软件层面上的所有服务进行记录**」。
 * 所以记录窗口**不再**是页面内存态（`useState` 也不行：刷新即丢），而是由服务端持有：
 *   · **主存 = 服务端进程内存**（`server/utils/diagSession.ts` 的模块级单例）；
 *   · `diagnostics/session.json` 只是**同一实例内**的持久化/导出依据；
 *   · 窗口带**实例标识**（进程启动时刻 + 随机 id）⇒ 读到别的实例的窗口一律当"没有窗口"（见该模块）。
 * 于是语义正好是用户要的：刷新页面 / 切页 / 关掉浏览器再打开，只要这个 EXE 还在跑就**仍在记录**；
 * 关掉 EXE 再启动则**从零开始**。本文件提供窗口的**类型与纯函数**（客户端筛选、服务端核对共用一个口径）。
 */

import { hasUnmaskedCredential } from './credentialScan'

/** 导出接口（与既有 `/api/local/*` 同风格：本机、只读日志 + 用户自己的快照） */
export const DIAG_EXPORT_PATH = '/api/local/diagnostics/export'
/**
 * 记录窗口接口族（🆕 2026-09-22）：
 *   · `GET`    `DIAG_RECORD_PATH`        读当前状态（**界面刷新后靠它恢复"正在记录 + 已记录多久"**）
 *   · `POST`   `DIAG_RECORD_PATH/start`  开始记录（可传 `includeGeometry`）
 *   · `POST`   `DIAG_RECORD_PATH/stop`   结束记录（**不导出**；窗口被封存为最近一次，供导出使用）
 *   · `PATCH`  `DIAG_RECORD_PATH/geometry` 记录中改坐标开关（只改服务端窗口里那个开关）
 */
export const DIAG_RECORD_PATH = '/api/local/diagnostics/record'
export const DIAG_RECORD_START_PATH = `${DIAG_RECORD_PATH}/start`
export const DIAG_RECORD_STOP_PATH = `${DIAG_RECORD_PATH}/stop`
export const DIAG_RECORD_GEOMETRY_PATH = `${DIAG_RECORD_PATH}/geometry`
/** 包内文件名（服务端写、界面展示、单测断言共用同一组常量） */
export const DIAG_MANIFEST_NAME = 'manifest.json'
export const DIAG_SNAPSHOT_NAME = 'snapshot.json'
export const DIAG_LOG_DIR = 'logs'
/** 服务端随包附带最近几天的日志（"能带什么就带什么"，但别无限膨胀） */
export const DIAG_LOG_DAYS = 3
/** 包内日志文件的体积上限（超出则截断并在 manifest 里注明；防止一个几百 MB 的日志把包撑爆） */
export const DIAG_LOG_MAX_BYTES = 8 * 1024 * 1024

/**
 * 🆕 2026-09-23 **响应原文留档**（captures）—— 用户原话：
 * 「裁剪的话要是有重要数据不就无法获得了？……主要是**我们拿到数据进行分析**，就不在客户端上进行了」
 *
 * 结论：**响应原文必须完整可分析** ⇒ 每个代理请求把**脱敏后的完整正文**写成一份单独文件，**不做单条裁剪**；
 * 体积问题改由「**总量预算 + 淘汰记账 + 轮转窗**」兜（见 `DIAG_CAPTURE_MAX_BYTES`）。
 * 日志行里的 `respBody` 仍是"小而可读"的摘要（**不动**），但会带一个 `capture` 指针指向这份原文。
 */
export const DIAG_CAPTURE_DIR = 'captures'
/** 时间窗与日志一致（`DIAG_LOG_DAYS`）：窗口内的 captures 才进导出包 */
export const DIAG_CAPTURE_DAYS = DIAG_LOG_DAYS
/** captures 目录的**总量预算**（默认 64 MB；`TOTORO_CAPTURE_MAX_BYTES` 可覆盖） */
export const DIAG_CAPTURE_MAX_BYTES = 64 * 1024 * 1024

/** captures 的**元信息**里的时间戳格式：`YYYYMMDD-HHmmssSSS`（🆕 不再进文件名，见 `captureFileName`） */
export function captureStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

/**
 * 端点路径 → 文件名短名：**取最后一段**（就是接口名本身），只保留白名单字符。
 * `"/wxxcx/sunrun/getSunrunPaper"` ⇒ `"getSunrunPaper"`；空/无字母 ⇒ `"root"`。
 *
 * 为什么只取最后一段（而不是整条路径拼成 `wxxcx-sunrun-…`）：整条路径拼出来是**长串**，
 * `c99999-wxxcx-sunrun-getSunrunPaper-200` 这种 35+ 字符、含数字与大小写混合的形态
 * **恰好落进"高熵裸凭证"的判据带**（32~35 位需含数字或大小写混合）⇒ 掩码会把文件名改成 `[token len=35]`。
 * 取最后一段后名字通常 <30 字符，稳定地"两边都不触发"。
 */
export function captureEndpointSlug(path: string): string {
  const raw = String(path ?? '')
  const last = raw.split(/[/?#]/).filter(Boolean).pop() ?? ''
  const s = last
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return s || 'root'
}

/** 🆕 序号的位数（5 位 ⇒ `c00001-…`） */
export const CAPTURE_SEQ_DIGITS = 5

/**
 * 🆕 2026-09-23（用户要求 1️⃣）**captures 文件名必须"两边都不触发"**：
 * 既不被掩码改动、也不被判成凭证形态 —— 这样 manifest 里就能直接写**真实名**（与包内文件对得上）。
 *
 * 旧格式（已废弃）`<14 位时间戳>-<4 位序号>-<短名>-<http>.<ext>` 有两处踩雷：
 *   ① 14 位连续数字 ≥8 ⇒ 被"学号/手机"兜底掩成 `[masked len=N]`；
 *   ② 时间戳 + 短名 + 状态码拼起来长度与字符集**恰好命中"高熵凭证"形态** ⇒ 红线判命中 ⇒ manifest 硬拒。
 * 新格式：`c<5 位序号>-<端点短名>-<http状态>.<json|txt>`（例 `c00007-getSunrunPaper-200.json`）：
 *   · 序号 5 位（**< 8 位数字门槛**）⇒ 数字兜底不动它；短名截到 24 字符；
 *   · **完整时间戳进同名 `.meta.json`**（排序靠序号；"这份是什么时候的"看 meta）。
 * 兼容：**旧文件按旧格式读**（`parseCaptureName` 两种都认），**新文件按新格式写**。
 */
export function captureFileName(parts: { at: Date; seq: number; endpoint: string; http: number; json: boolean }): string {
  const seq = String(Math.max(0, Math.floor(parts.seq))).padStart(CAPTURE_SEQ_DIGITS, '0')
  const slug = captureEndpointSlug(parts.endpoint).slice(0, 16)
  return `c${seq}-${slug}-${Math.floor(parts.http)}.${parts.json ? 'json' : 'txt'}`
}

/**
 * 解析 capture 文件名 —— **新旧两种格式都认**（新格式 `stamp` 为空，时间从 `.meta.json` 来）。
 * 解析不出来返回 `null`（**不抛错**，调用方跳过即可）。
 */
export function parseCaptureName(name: string): { stamp: string; seq: number; endpoint: string; http: number; json: boolean } | null {
  const s = String(name ?? '')
  const old = /^(\d{8}-\d{9})-(\d{4})-(.*)-(\d{2,3})\.(json|txt)$/.exec(s)
  if (old) return { stamp: old[1]!, seq: Number(old[2]), endpoint: old[3]!, http: Number(old[4]), json: old[5] === 'json' }
  const neu = /^c(\d{1,5})-(.*)-(\d{2,3})\.(json|txt)$/.exec(s)
  if (neu) return { stamp: '', seq: Number(neu[1]), endpoint: neu[2]!, http: Number(neu[3]), json: neu[4] === 'json' }
  return null
}

/** 时间戳串（`captureStamp` 的产物）→ epoch ms；解析不出来返回 null */
export function captureStampToMs(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(String(stamp ?? ''))
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]))
  const t = d.getTime()
  return Number.isFinite(t) ? t : null
}

/** 时间戳串 → ISO（显示用；解析不出来返回空串） */
export function captureStampToIso(stamp: string): string {
  const ms = captureStampToMs(stamp)
  return ms === null ? '' : new Date(ms).toISOString()
}

/** 一份 capture 的元信息（与正文**分开**存成同名 `.meta.json`；正文里不放元信息，便于直接拿去做分析） */
export interface CaptureMeta {
  /** 本机时间（ISO） */
  at: string
  /** 端点（上游路径后缀，如 `/wxxcx/sunrun/getSunrunPaper`） */
  endpoint: string
  /** HTTP 状态码 */
  http: number
  /** 耗时（ms） */
  ms: number
  /** 上游响应原始字节数（脱敏前） */
  originalBytes: number
  /** 落盘正文的字节数（脱敏后；**不做裁剪**） */
  bytes: number
  /** 响应形态：json / text */
  kind: 'json' | 'text'
  /** 解包退化标记（`ok` 或 `suspect: <路径>`），与日志行同口径 */
  unpack?: string
  /**
   * 🔴 **这份是否被裁剪** —— 正常**必须**是 `false`（用户要求"完整可分析"）。
   * 本实现**不截断单份**，所以恒为 false；保留该字段是让维护者一眼看出"这份完不完整"。
   */
  truncated: boolean
  /** 文件名（自指，便于清单核对） */
  fileName: string
}

/** captures 清单里"进包的每一份"的账（manifest 用） */
export interface CaptureFileEntry {
  /** **真实文件名**（用户要求 1️⃣：与包内 `captures/` 条目逐字一致；新命名不会触发掩码/红线） */
  name: string
  bytes: number
  /**
   * 坐标处理结果：
   * · `false` —— 没剥（本次开着坐标开关）；
   * · `true` —— JSON 结构化剥净（`stripGeometryFromRespBody()`）；
   * · `'best-effort'` —— **非 JSON 文本**的正则尽力剥离（**可能仍有残留**，见 `strippedCount`）。
   */
  geometryStripped: boolean | 'best-effort'
  /** `'best-effort'` 时替换了几处坐标（如实计数） */
  strippedCount?: number
}

/** captures 的总账（`manifest.captures`）：**淘汰也要记账，不许静默丢** */
export interface CaptureAccount {
  /** 目录（**绝对路径**，让人知道去哪儿找） */
  dir: string
  /**
   * 🆕 2026-09-23（复验 B2）**收录口径**：
   * `window` = 只收**本次记录窗口**内的响应原文（有活动窗口时的正确行为）；
   * `recent-days` = 本次没有生效窗口 ⇒ 退回"最近 N 天"（**不限于某一次复现**，必须让用户看见）。
   */
  scope?: 'window' | 'recent-days'
  /** 上面那个口径的**人话说明**（界面预览与 manifest 共用，避免两处口径漂移） */
  scopeNote?: string
  /** 窗口内进包的份数 */
  keptFiles: number
  /** 窗口内进包的总字节 */
  keptBytes: number
  /** 写出时因预算被淘汰的份数与字节（**累计**，从 `.evicted.json` 读） */
  droppedFiles: number
  droppedBytes: number
  /** 被淘汰的具体文件名（最多列 50 个，其余用 `droppedMore` 记数） */
  droppedNames: string[]
  droppedMore?: number
  /** 总量预算（字节） */
  budgetBytes: number
  /** 当前目录占用（字节） */
  usedBytes: number
  /** 保留下来的**最旧**一份的时间（ISO；没有则空串） */
  oldestKeptAt: string
  /** 窗口内的逐份清单（名字/大小/是否剥坐标） */
  entries: CaptureFileEntry[]
  /**
   * 🆕 2026-09-23：**这些原文分别来自哪些上游端点**（端点 → 份数）。
   * 用途（用户要求"提交必记响应"的证据）：打开 manifest 一眼就能确认
   * **提交成绩 / 轨迹明细这两个端点确实在留档范围内**（而不是靠人猜）。
   */
  byEndpoint?: Record<string, number>
}

/**
 * 应用内事件时间线：最多带多少条。
 *
 * ⚠️ 2026-09-22 起它的**含义变了**（issue #12 二次返工）：以前是"只取**最近** 300 条"
 * —— 长记录会把**最早**那段（含「开始记录」本身）挤掉，正是用户遇到的"记录被重置"观感之一。
 * 现在时间线先**按窗口时间过滤**，`DIAG_TIMELINE_MAX` 降级为**上限兜底**：
 * 超出时保留**最早 `DIAG_TIMELINE_HEAD_KEEP` 条 + 最新若干条**（见 `diagTimelineInWindow()`）。
 */
export const DIAG_TIMELINE_MAX = 300

/** 时间线超上限时**必须保住的开头条数**（开头含「开始记录」，是判断"这次记录从哪开始"的关键） */
export const DIAG_TIMELINE_HEAD_KEEP = 20

/**
 * 一条**记录窗口**（= 用户点「开始记录」→ 点「结束记录/结束并导出」的那一段）。
 *
 * 🔴 **它里面绝不允许出现 token / 学号 / 姓名**（只有 id、时间、一个开关）——
 * 有单测 `tests/mp/diagSession.test.ts` 直接断言窗口文件与窗口对象里不含凭证样式。
 */
export interface DiagWindow {
  /** 窗口 id（`w-<进程启动时刻>-<随机>`；服务端生成，界面只展示） */
  id: string
  /**
   * 🔒 **实例标识**（`<进程启动 epoch ms>-<随机 hex>`）：窗口只对**产生它的那个进程实例**有效。
   * 读到别的实例的窗口一律当"没有窗口"——语义即"刷新/切页不中断，重启 EXE 从零开始"。
   */
  instanceId: string
  /** 是否正在记录（`false` = 已结束/已封存，导出时仍可用） */
  recording: boolean
  /** 开始的 ISO 时间（**服务端时钟**，日志行的时间戳与之同源） */
  startedAt: string
  /** 开始的 epoch ms（客户端 `at` 也是本机时钟 ⇒ 直接可比，不跨时区/不跨机器） */
  startedAtMs: number
  /** 结束的 ISO 时间（`recording=true` 时为空串） */
  endedAt: string
  /** 结束的 epoch ms（`recording=true` 时为 0） */
  endedAtMs: number
  /** 坐标开关（随窗口一起保存；记录中可改，会 PATCH 到服务端窗口） */
  includeGeometry: boolean
}

/**
 * 🆕 2026-09-23（用户要求：诊断必须"一份包就能定位问题"）**客户端事件上报**的契约。
 *
 * ## 为什么要"双写服务端"
 * 用户的抱怨是"**用户刷新一下界面我们就丢失数据捕获**"。记录窗口/日志/captures 本来就在服务端（刷新不丢），
 * **只有"客户端操作时间线"原先是页面内存 + localStorage** ⇒ 刷新后内存里那一段就没了。
 * 现在：每条事件**同时**上报一份到服务端（落进服务端日志 ⇒ 自动受**记录窗口过滤** ⇒ 导出包里就有），
 * 导出时把「**localStorage 兜底** / **页面内存** / **服务端日志**」三处按 `id` 去重合并 ⇒ 刷新前后都在。
 *
 * ## id 的形状（去重的唯一依据）
 * `c<时间戳36进制>-<随机>`：**客户端生成**、稳定、可跨来源比对（服务端只把它原样记进日志）。
 */

/** 客户端事件上报的路径（**契约层的唯一来源**；界面与端点都用它，别处不要再写字面量） */
export const DIAG_EVENT_PATH = '/api/local/diagnostics/event'

/**
 * 🆕 2026-09-23（用户要求「**每一个重要的地方都要记录**」）**心跳快照**的路径。
 *
 * 与 `DIAG_EVENT_PATH` 分开的理由：心跳是**状态摘要**（"此刻是什么样"），不是"发生了一件事"；
 * 两者语义、限流口径、界面提示都不同（心跳被限流是正常的，不该让人以为"丢了操作"）。
 */
export const DIAG_HEARTBEAT_PATH = '/api/local/diagnostics/heartbeat'
/** 客户端心跳间隔（30~60 秒之间取 45 秒；关键操作后**立即**补发一次） */
export const DIAG_HEARTBEAT_INTERVAL_MS = 45_000
/** 每窗口最多接受多少条心跳（比事件密，单独给上限；超限如实拒绝） */
export const DIAG_HEARTBEAT_PER_WINDOW_MAX = 2000

export interface DiagEvent {
  /** 稳定 id（客户端生成；三来源去重靠它） */
  id: string
  /** 事件时间（ISO；本机时钟，与窗口边界同源可比） */
  at: string
  /** 等级：`info` / `warn` / `error`；🆕 `gate` = **被门禁/本地判定拦下**（用户要求 2️⃣ 的核心） */
  level: 'info' | 'warn' | 'error' | 'gate'
  /** 类别：`ui` / `blocked` / `client-error` / `run` / `submit` …（自由短串，进包便于按类筛） */
  cat: string
  /** 人话文本（**已脱敏**；长度受限） */
  text: string
  /** 🆕 小体积结构化补充（**扁平、短**；白名单见 `assertDiagEventPayload`） */
  data?: Record<string, string | number | boolean | null>
  /** 🆕 来源标记（导出合并后如实标注这条来自哪儿） */
  source?: DiagEventSource
}

/** 事件来源（导出合并后逐条标注；`manifest.timeline` 里的计数也用它） */
export type DiagEventSource = 'client' | 'localStorage' | 'server'

/** 三来源合并后的计数（写进 `snapshot.timelineStats` 与 manifest） */
export interface DiagEventMergeStats {
  /** 每条来源**各自**多少条（去重前） */
  client: number
  localStorage: number
  server: number
  /** 按 id 去重后的总数 */
  merged: number
  /** 其中重复被丢掉的条数（`client+localStorage+server - merged`） */
  duplicates: number
}

/**
 * 单条事件的**长度上限**（用户要求 1️⃣："含栈摘要，**做长度上限**"）。
 * 超长的 `text`/`data` 值在**客户端先截断**，服务端再兜一次 —— 两道都不许把整段栈塞进日志。
 */
export const DIAG_EVENT_TEXT_MAX = 600
/** `data` 最多几个键（扁平、短；不许塞大对象） */
export const DIAG_EVENT_DATA_MAX_KEYS = 12
/** `data` 单个值最长多少字符（数字/布尔不受限） */
export const DIAG_EVENT_DATA_VALUE_MAX = 200
/** `cat` 最长多少字符 */
export const DIAG_EVENT_CAT_MAX = 32
/** 一次请求最多上报几条（客户端小批量合并后的上限） */
export const DIAG_EVENT_BATCH_MAX = 40
/**
 * **每个记录窗口**最多接受多少条事件（用户要求：限流，防跑飞刷爆日志）。
 * 2000 条 × ~300 字节 ≈ 600 KB —— 相对"日志单条上限 32 KB / 单文件 8 MB"是很小的一部分。
 */
export const DIAG_EVENT_PER_WINDOW_MAX = 2000
/** 允许的事件等级（**白名单**；其余一律丢弃并计数） */
export const DIAG_EVENT_LEVELS = ['info', 'warn', 'error', 'gate'] as const

/** `assertDiagEventPayload()` 的结果（**只报告"拒绝了几条、为什么"**，不回显原文） */
export interface DiagEventPayloadCheck {
  /** 通过校验的事件（**已按上限截断**、`data` 只留白名单形状） */
  accepted: DiagEvent[]
  /** 被拒绝的条数 */
  rejected: number
  /** 拒绝原因（去重后的短标签，如 `unknown-level` / `bad-id` / `too-long`） */
  reasons: string[]
}

const asShortString = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  return s.length > max ? `${s.slice(0, max)}…[截断，原 ${s.length} 字符]` : s
}

/**
 * **校验一条上报事件**（纯函数，客户端与服务端**共用同一份白名单**）。
 *
 * 判据（可执行，逐条对应"字段白名单 + 拒绝未知/超长字段"）：
 *   · `id`：非空字符串、≤ 80 字符、且**只允许** `[A-Za-z0-9._:-]`（防止有人塞路径/引号/换行）；
 *   · `at`：能被 `Date.parse` 解析（否则用不了窗口过滤）；
 *   · `level`：必须在 `DIAG_EVENT_LEVELS` 里；
 *   · `cat` / `text`：非空、按 `DIAG_EVENT_CAT_MAX` / `DIAG_EVENT_TEXT_MAX` 截断；
 *   · `data`：**只接受扁平标量**（string/number/boolean/null），键数与单值长度受限，
 *     **嵌套对象/数组一律丢掉该键**（"不许把整个对象原样透传"）。
 *
 * @returns `null` = 这条不合格（调用方计入 `rejected`）
 */
export function checkDiagEvent(raw: unknown): DiagEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = asShortString(o.id, 80)
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) return null
  const at = asShortString(o.at, 40)
  if (!at || !Number.isFinite(Date.parse(at))) return null
  const level = String(o.level ?? '')
  if (!(DIAG_EVENT_LEVELS as readonly string[]).includes(level)) return null
  const cat = asShortString(o.cat, DIAG_EVENT_CAT_MAX)
  if (!cat) return null
  const text = asShortString(o.text, DIAG_EVENT_TEXT_MAX)
  if (!text) return null
  /** `data`：扁平标量白名单（嵌套/数组/超长一律不要） */
  let data: Record<string, string | number | boolean | null> | undefined
  if (o.data && typeof o.data === 'object' && !Array.isArray(o.data)) {
    const out: Record<string, string | number | boolean | null> = {}
    let n = 0
    for (const [k, v] of Object.entries(o.data as Record<string, unknown>)) {
      if (n >= DIAG_EVENT_DATA_MAX_KEYS) break
      const key = asShortString(k, 40)
      if (!key) continue
      if (v === null || typeof v === 'boolean') {
        out[key] = v
        n++
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        out[key] = v
        n++
      } else if (typeof v === 'string') {
        const s = asShortString(v, DIAG_EVENT_DATA_VALUE_MAX)
        if (s !== null) {
          out[key] = s
          n++
        }
      }
      // 其余（对象/数组/函数/undefined）**直接丢掉这个键** —— 这就是"不许原样透传"
    }
    if (n > 0) data = out
  }
  return { id, at, level: level as DiagEvent['level'], cat, text, ...(data ? { data } : {}) }
}

/**
 * 校验**一批**上报事件（服务端端点与单测共用）。
 *
 * @param raw 请求体里的数组（不是数组 ⇒ 全部拒绝）
 * @param max 单请求条数上限（默认 `DIAG_EVENT_BATCH_MAX`，超出部分**如实拒绝**而不是静默丢）
 */
export function checkDiagEventPayload(raw: unknown, max: number = DIAG_EVENT_BATCH_MAX): DiagEventPayloadCheck {
  const reasons = new Set<string>()
  const accepted: DiagEvent[] = []
  if (!Array.isArray(raw)) {
    return { accepted, rejected: 0, reasons: ['not-array'] }
  }
  let rejected = 0
  const cap = Math.max(0, Math.floor(max))
  for (let i = 0; i < raw.length; i++) {
    if (i >= cap) {
      rejected++
      reasons.add('over-batch-max')
      continue
    }
    const ok = checkDiagEvent(raw[i])
    if (!ok) {
      rejected++
      // 原因只给**短标签**（不回显任何原文/字段值，避免把用户的输入带进日志）
      const o = (raw[i] ?? {}) as Record<string, unknown>
      if (typeof o.id !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(String(o.id))) reasons.add('bad-id')
      else if (!Number.isFinite(Date.parse(String(o.at ?? '')))) reasons.add('bad-at')
      else if (!(DIAG_EVENT_LEVELS as readonly string[]).includes(String(o.level ?? ''))) reasons.add('unknown-level')
      else reasons.add('bad-field')
      continue
    }
    accepted.push(ok)
  }
  return { accepted, rejected, reasons: [...reasons] }
}

/**
 * **上报受理判定**（纯函数；端点与单测共用）—— 把"收不收、为什么拒"从端点里抽出来，便于离线钉住。
 *
 * 判据（逐条对应要求）：
 *   ① **没有活动窗口 ⇒ 拒**（`reason: 'no-window'`；端点返回 **200** + `ok:false`，**不抛 4xx**）；
 *   ② 单请求条数 ≤ `batchMax`；每窗口累计 ≤ `perWindowMax`（**超出如实拒绝并说明**，不静默丢）；
 *   ③ 每条都要过字段白名单（`checkDiagEvent`）。
 *
 * @param raw           请求体里的 `events`（任何值）
 * @param hasWindow     服务端**现在**有没有活动窗口
 * @param countedInWindow 本窗口**已收**多少条（端点自己计数；纯函数不持有状态）
 */
export function acceptDiagEvents(
  raw: unknown,
  hasWindow: boolean,
  countedInWindow: number,
  batchMax: number = DIAG_EVENT_BATCH_MAX,
  perWindowMax: number = DIAG_EVENT_PER_WINDOW_MAX,
): { accepted: DiagEvent[]; rejected: number; reasons: string[]; ok: boolean; note: string; countedInWindow: number } {
  if (!hasWindow) {
    return { accepted: [], rejected: 0, reasons: ['no-window'], ok: false, note: '本次运行没有活动中的记录窗口（先点「开始记录」再复现问题）', countedInWindow }
  }
  const check = checkDiagEventPayload(raw, batchMax)
  const room = Math.max(0, Math.floor(perWindowMax) - Math.max(0, Math.floor(countedInWindow)))
  const accepted = check.accepted.slice(0, room)
  const overWindowMax = check.accepted.length - accepted.length
  const reasons = [...check.reasons, ...(overWindowMax > 0 ? ['over-window-max'] : [])]
  return {
    accepted,
    rejected: check.rejected + overWindowMax,
    reasons,
    ok: accepted.length > 0,
    note: accepted.length > 0 ? '' : check.reasons.includes('not-array') ? '上报内容不符合字段白名单（只接受 {id, at, level, cat, text, data?}）' : '本批没有可受理的事件',
    countedInWindow: countedInWindow + accepted.length,
  }
}

/**
 * **三来源合并 + 按 id 去重**（用户要求：刷新前的在服务端/兜底里，刷新后的在内存里，合起来才是完整时间线）。
 *
 * 判据（可执行）：
 *   · 输入是 `[{ source, events }]`（顺序即**优先级**：先来的赢，所以调用方按 `localStorage → client → server` 传，
 *     意思是"同一条 id 以 localStorage 那份为准"——它最贴近事件**发生当时**的形态）；
 *   · 逐条按 `id` 去重（**没有 id 的条目按其 `at|level|cat|text` 合成一个键**，兼容老数据）；
 *   · 输出**按 `at` 升序**（同一时间戳保持输入顺序，稳定排序）；
 *   · 每条的 `source` 标成它实际来自哪儿；**重复被丢掉的条数如实计数**。
 */
export function mergeDiagEvents(
  groups: { source: DiagEventSource; events: DiagEvent[] }[],
  max: number = DIAG_TIMELINE_MAX,
): { items: DiagEvent[]; stats: DiagEventMergeStats } {
  const stats: DiagEventMergeStats = { client: 0, localStorage: 0, server: 0, merged: 0, duplicates: 0 }
  const seen = new Map<string, DiagEvent>()
  for (const g of groups) {
    for (const e of g.events) {
      if (g.source === 'client') stats.client++
      else if (g.source === 'localStorage') stats.localStorage++
      else stats.server++
      const key = e.id || `${e.at}|${e.level}|${e.cat}|${e.text}`
      const prev = seen.get(key)
      if (prev) {
        stats.duplicates++
        continue
      }
      seen.set(key, { ...e, source: g.source })
    }
  }
  const items = [...seen.values()].sort((a, b) => {
    const ta = Date.parse(String(a.at ?? ''))
    const tb = Date.parse(String(b.at ?? ''))
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return 0
  })
  const cap = Math.max(0, Math.floor(max))
  const capped = items.length > cap ? [...items.slice(0, Math.floor(DIAG_TIMELINE_HEAD_KEEP)), ...items.slice(-(cap - Math.floor(DIAG_TIMELINE_HEAD_KEEP)))] : items
  stats.merged = capped.length
  return { items: capped, stats }
}

/** 界面与服务端共享的"当前记录状态"（`GET DIAG_RECORD_PATH` 的响应） */
export interface DiagRecordState {
  /** 当前/最近的窗口（没有就是 null） */
  window: DiagWindow | null
  /** 「已记录多少秒」由服务端按 `startedAt` 算（界面刷新后据此补算，不归零） */
  elapsedSeconds: number
  /** 服务端进程的实例信息（界面用来显示"这一份记录属于哪一次运行"） */
  serverInstance: { instanceId: string; startedAtMs: number; pid: number }
}

/** 掩码：学号（保留前 2 后 2）/ 姓名（保留姓）/ 手机号 */
export const maskId = (s: unknown): string => {
  const v = String(s ?? '')
  if (!v) return ''
  if (v.length <= 4) return '*'.repeat(v.length)
  return `${v.slice(0, 2)}${'*'.repeat(Math.max(1, v.length - 4))}${v.slice(-2)}`
}
export const maskName = (s: unknown): string => {
  const v = String(s ?? '')
  if (!v) return ''
  return v.length <= 1 ? v : `${v[0]}${'*'.repeat(v.length - 1)}`
}
export const maskPhone = (s: unknown): string => {
  const v = String(s ?? '').replace(/\D/g, '')
  if (v.length < 7) return maskId(s)
  return `${v.slice(0, 3)}****${v.slice(-4)}`
}

/** 凭证指纹：只留长度 + 前 4/后 4（**永不**存 token 本体） */
export const tokenFingerprint = (token: unknown): string => {
  const t = String(token ?? '')
  if (!t) return '(无)'
  return `len=${t.length} head=${t.slice(0, 4)} tail=${t.slice(-4)}`
}

/**
 * 诊断**记录窗口 id** 的形状：`w-<yyyymmdd>-<hhmmss>-<hex>`（与 `DiagWindow.id` 的生成口径一致）。
 * 唯一来源在这里，`diagIdSafeDigits()` 与单测都引它。
 */
export const DIAG_WINDOW_ID_RE = /^w-\d{8}-\d{6}-[0-9a-f]{1,16}$/i

/**
 * 🆕 2026-09-23（复验 B4）**成绩记录号（`scantronId`）的形状** —— 与窗口 id 同理，**不许掩**。
 *
 * ## 为什么必须放过它
 * `scantronId` 是**厂商归档里的记录定位符**（如 `sunrunId20260924AUDIT1`、`sunrunId20260921505`）。
 * 数字兜底掩码会把中间的 8 位日期当学号 ⇒ `sunrunId20****24AUDIT1` ⇒
 * **维护者再也没法与厂商归档对齐**（"这条成绩到底存不存在"就查不了了）——
 * 而它**根本不含身份信息**（是服务端生成的记录号，不是学号）。
 *
 * ## 判据（可执行）
 * 整串形如 `<字母开头><字母数字下划线 11~47 位>`，且**至少含 4 位数字**、**至少含 1 个字母**。
 * 只对**紧邻上下文的整串**成立才豁免（见 `maskDigitRuns()`），不会把裸学号放过：
 * 裸学号（纯 8~18 位数字）**不以字母开头** ⇒ 照旧掩掉。
 */
export const SCANTRON_ID_RE = /^[A-Za-z][A-Za-z0-9_]{11,47}$/

/** 这一段（含上下文）是不是 `scantronId` 形态（决定要不要放过里面的数字段） */
function looksLikeScantronId(whole: string, start: number, end: number): boolean {
  /** 往两边扩到"整串"边界（字母/数字/下划线都算串内） */
  let s = start
  let e = end
  while (s > 0 && /[A-Za-z0-9_]/.test(whole[s - 1]!)) s--
  while (e < whole.length && /[A-Za-z0-9_]/.test(whole[e]!)) e++
  const token = whole.slice(s, e)
  if (!SCANTRON_ID_RE.test(token)) return false
  const digits = (token.match(/\d/g) ?? []).length
  const letters = (token.match(/[A-Za-z]/g) ?? []).length
  return digits >= 4 && letters >= 2
}

/**
 * **数字兜底掩码**：把自由文本里 8~18 位的纯数字当学号/手机号掩掉（见界面上那段"身份脱敏"的说明）。
 *
 * 🔴 但**窗口 id 里的数字段必须放过**（2026-09-22 真实浏览器导出解包时实测抓到）：
 * `new Date().toISOString()` + 掩码的组合会把 `w-20260922-130240-c41da2` 里的 `20260922` 当学号，
 * 掩成 `w-20****22-130240-c41da2` ⇒ 时间线里那条"开始记录诊断（服务端窗口 …）"**再也对不上**
 * manifest 里的窗口 id，维护者没法把"时间线的一段"与"日志区间"对齐。
 * 窗口 id 是本机自己生成的标识（**不含任何身份信息**），掩它只会废掉证据。
 *
 * @param text 任意自由文本（日志 msg / 错误文案…）
 */
export function maskDigitRuns(text: string): string {
  return String(text ?? '').replace(/\d{8,18}/g, (m, offset: number, whole: string) => {
    // 前面紧跟 `w-` 且后面是 `-<6位>-<hex>` ⇒ 整段是窗口 id ⇒ 原样保留
    const before = whole.slice(Math.max(0, offset - 2), offset)
    const after = whole.slice(offset + m.length, offset + m.length + 24).split(/\s/)[0] ?? ''
    if (before === 'w-' && DIAG_WINDOW_ID_RE.test(`w-${m}${after.replace(/[^0-9a-f-]/gi, '')}`)) return m
    /**
     * 🆕 复验 B4：整串是 `scantronId` 形态（厂商归档的记录定位符，**不含身份**）⇒ 原样保留，
     * 否则 `sunrunId20260924AUDIT1` 会被掩成 `sunrunId20****24AUDIT1`、**无法与归档对齐**。
     */
    if (looksLikeScantronId(whole, offset, offset + m.length)) return m
    return /^1\d{10}$/.test(m) ? maskPhone(m) : maskId(m)
  })
}

/** 客户端采集、**已脱敏**的快照结构（服务端原样写进 `snapshot.json`） */
export interface DiagSnapshot {
  /** 采集时刻（本地时间字符串 + epoch ms） */
  collectedAt: string
  collectedAtMs: number
  /** 应用信息 */
  appVersion: string
  userAgent: string
  route: string
  /** 会话与账号（**全部脱敏**） */
  session: {
    hasToken: boolean
    tokenFingerprint: string
    baseUrl: string
    schoolCode: string
    schoolName: string
    campusId: string
    campusName: string
    snCode: string
    studentName: string
  }
  /** 当前任务：摘要 + **完整原始 JSON**（排障的核心证据） */
  task: {
    present: boolean
    /**
     * 🆕 2026-09-22：**任务本体取自哪里**（`memory(useMpReal.task)` / `cache.task` /
     * `cache.data(obj,runPointList)` / `none`）。
     * 为什么需要它：真实用户那次故障里，快照把 **API 响应信封**当成了任务本体 ⇒
     * `runPointList` 读成 0 条、`shapeLine` 得出 `route=free(0)` 的**错误结论**（见 `resolveCacheTask()`）。
     * 有了这一行，维护者一眼能看出"这份快照的任务是从哪一层取的"，不必再靠猜。
     * **可选**字段：老快照没有它。
     */
    source?: string
    summary: {
      paperId: string
      paperName: string
      taskName: string
      km: number | null
      fitDegreeThreshold: number | null
      validFrom: string
      validTo: string
      runPointListCount: number
      /**
       * 🆕 2026-09-22（issue #12）：任务形状一行摘要 —— `route=line(2) fit=required(0.6)` /
       * `route=free(0) fit=none`（由纯函数 `taskShapeLine()` 生成，`utils/mp/taskShape.ts`）。
       * **可选**字段：老快照没有它，服务端原样写盘，不校验。
       * 用途：一眼看出"服务端到底下发了几条线路、有没有下发拟合度阈值"。
       */
      shapeLine?: string
    }
    /** 每条线路的关键字段（含坐标点数，不含完整坐标数组） */
    lines: { pointId: string; pointName: string; pointCount: number; taskId: string; campusName: string }[]
    /** ⚠️ 原始 JSON：这是"任务里到底有没有路线"的唯一硬证据；坐标会被包含（界面已告知） */
    raw: unknown
  }
  /** 本机路线库：摘要 + 是否含完整坐标 */
  trackLibrary: {
    count: number
    includeGeometry: boolean
    entries: { lineId: string; lineName: string; outerPoints: number; innerPoints: number; createdAt: string; updatedAt?: string; appVersion?: string; laneNo?: number; laneCount?: number; hasStartPoint: boolean; geometry?: unknown }[]
  }
  /** 门禁：判定结果 + 依据（"为什么不让开跑"） */
  gate: { allow: boolean | null; reason: string; blockedBy: string; switches: unknown; cameraFlag: unknown; cameraFlagLineId: string; cameraFlagError: string }
  /** 应用内事件时间线（**已按记录窗口过滤**，超上限时见 `diagTimelineInWindow()` 的取舍，已脱敏） */
  timeline: { at: string; level: string; cat: string; text: string; id?: string; data?: unknown; source?: string }[]
  /**
   * 🆕 2026-09-23（用户要求 4️⃣"localStorage 同步兜底"）：客户端**离线兜底**那一份事件
   * （键 `mp_diag_events_v1`；每条事件在写内存的同时也写它 ⇒ 连"还没上报就刷新"的 1~2 秒也不丢）。
   * 服务端导出时把它与 `timeline`、服务端日志里的 ui 事件**按 id 去重合并**后再进包。
   */
  timelineFromStorage?: { id: string; at: string; level: string; cat: string; text: string; data?: unknown }[]
  /**
   * 🆕 2026-09-22：这一份快照是**为哪个记录窗口**采集的（服务端会拿它核对，口径不一致时在 manifest 里写明）。
   * **可选**字段：老快照没有它，服务端照旧能导出（退回"未按记录窗口过滤"）。
   */
  window?: { id: string; startedAt: string; endedAt: string; includeGeometry: boolean } | null
  /**
   * 🆕 2026-09-22（审计 B2）：采集快照时，界面见过的**服务端进程实例标识**。
   * 服务端拿它区分"只是窗口被换掉"与"本程序重启过"（两种提示语对用户更贴切）。
   * **可选**：老前端不给也没关系（那种情况服务端只按窗口 id 判）。
   */
  serverInstanceId?: string
  /** 🆕 2026-09-22：时间线按窗口过滤/截断的结果（写进 manifest，便于维护者判断"是不是漏了操作"） */
  timelineStats?: DiagTimelineStats
  /**
   * 🆕 2026-09-22（用户原话："刷新后就丢了，我们直接丢之前记录下来不行吗"）：
   * **最近一次成功读取时的状态**（含开关原值、摄像头杆 flag、当时的门禁终值）。
   *
   * 🔴 **它只是诊断证据，不参与任何放行判断**；真实提交前必须**重新读取**（开关可能已变）。
   * **可选**字段：老快照没有它，服务端照旧写盘。
   */
  lastKnown?: DiagLastKnown | null
}

/**
 * 🆕 2026-09-22（审计 B6）：从请求体里**只认显式布尔**地读"要不要包含坐标"。
 *
 * 为什么不能写成 `body?.includeGeometry !== false`（这是原始 bug）：空体 `{}`、
 * `{"includeGeometry":0}`、`"false"`（字符串）都会被判成 `true` ⇒ **隐私开关被无声地打开**。
 * 坐标是用户在这套诊断里唯一能控制的隐私取舍，**这种地方宁可报错也不能替用户做宽松解释**。
 *
 * 返回三态而不是布尔，让两个调用方各自决定"缺字段怎么办"（这个差别是**有意**的）：
 *   · `PATCH /record/geometry`（**改**一个已存在的开关）⇒ 缺字段无法判断意图 ⇒ **400**；
 *   · `POST /record/start`（**新建**窗口）⇒ 缺字段 = 用户没表达意见 ⇒ 用默认值（老前端不带也能用）。
 * 两边共同点：`"false"` / `0` 这类写法**都不算"关闭坐标"**（都不满足 `typeof === 'boolean'`）。
 *
 * ⚠️ `server/utils/diagSession.ts` 里有一行 `export { readIncludeGeometryFlag } from '../../utils/mp/diagnostics'`
 * 的**转发**：`server/api/local/diagnostics/record/**` 用相对路径引 `<root>/utils/mp/*` 时，
 * 本机 `tsc`（moduleResolution=bundler）实测解析不到（同目录的 `server/utils/*` 却正常）⇒
 * 端点走 `server/utils/diagSession` 取，界面与单测走这里取，**实现只有这一份**。
 */
export function readIncludeGeometryFlag(body: unknown): { kind: 'ok'; value: boolean } | { kind: 'missing' } | { kind: 'invalid'; got: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'missing' }
  const v = (body as Record<string, unknown>).includeGeometry
  if (v === undefined) return { kind: 'missing' }
  if (typeof v === 'boolean') return { kind: 'ok', value: v }
  return { kind: 'invalid', got: typeof v === 'string' ? `字符串 "${String(v).slice(0, 12)}"` : typeof v }
}

/**
 * 🆕 2026-09-22（审计 B2/B4）：客户端手里那个窗口与服务端现在这个窗口**对不对得上**。
 *
 * 为什么必须是**纯函数**：这条判据同时用在**两个地方**（服务端 409 闸门 / 界面导出前自检），
 * 两处各写一遍迟早会漂移（一处严一处松 = 漏洞）。返回 `null` 表示"可以继续"。
 *
 * 三种"对不上"分开报，因为**用户的下一步动作不同**：
 *   · `unreported`：服务端压根没回窗口（重启过/没开始记录）⇒ 要重新记录；
 *   · `overwritten`：id 变了 ⇒ 多半是另一个标签页点了「开始记录」⇒ 要重新记录；
 *   · `instance-changed`：服务端**换了进程实例**（EXE/dev 重启）⇒ 也要重新记录，
 *     但告诉用户"程序重启过"比"窗口被换掉"更贴近真相。
 *
 * @param args.clientWindowId   界面快照里声称的窗口 id（老前端不给 ⇒ 空串）
 * @param args.respondedWindowId 服务端**这次请求**回的窗口 id（`stop` 返回的 / `GET` 读到的）
 * @param args.serverInstanceId 服务端当前的进程实例标识
 * @param args.reportedInstanceId 界面之前见过的实例标识（没见过就是空串 ⇒ 只按 id 判）
 */export function diagWindowMatch(args: {
  clientWindowId: string
  respondedWindowId: string
  serverInstanceId: string
  reportedInstanceId?: string
}): { reason: 'unreported' | 'overwritten' | 'instance-changed'; detail: string } | null {
  const client = String(args.clientWindowId ?? '')
  const responded = String(args.respondedWindowId ?? '')
  const instance = String(args.serverInstanceId ?? '')
  const reportedInstance = String(args.reportedInstanceId ?? '')
  if (!client || client === responded) return null
  if (reportedInstance && instance && reportedInstance !== instance) {
    return { reason: 'instance-changed', detail: `本程序重启过（实例 ${reportedInstance} → ${instance}），重启后记录从零开始` }
  }
  if (!responded) {
    return { reason: 'unreported', detail: '服务端现在没有记录窗口（这次运行没点过「开始记录」，或它已被清掉）' }
  }
  return { reason: 'overwritten', detail: `服务端的记录窗口已换成 ${responded}（本页手里是 ${client}）` }
}

/**
 * 🆕 2026-09-22（用户原话："你刚刚说刷新后就丢了，我们直接丢之前记录下来不行吗"）：
 * **最近一次成功读取时的状态** —— 纯诊断证据，**绝不参与放行判断**（见 `utils/mp/diagLastKnown.ts` 的边界说明）。
 *
 * 现场用途：用户 17:10:56 读到过"人脸关/抽查关/摄像头杆未启用"，18:40 导出时实时状态已空
 * （刷新丢内存态）⇒ 有了这一段，包里就能写清"最近一次读到开关是 17:10:56：均无阻碍（需重新读取）"。
 */
export interface DiagLastKnown {
  /** 采集时刻（ISO，本地机器时钟） */
  at: string
  /** 采集时刻（epoch ms；界面排序/显示用） */
  atMs: number
  /** 当时的数据状态：`ready` 读到任务 / `partial` 只读到部分 / `demo` 演示模式 */
  status: 'ready' | 'partial' | 'demo'
  /** 学校/校区（掩码后的学号与姓名在 `student` 里） */
  school: { schoolCode: string; schoolName: string; campusId: string; campusName: string }
  /** 身份（🔴 只掩码形态，绝不含原文） */
  student: { snCode: string; studentName: string; phone: string }
  /** 凭证：**只记布尔与指纹**（长度 + 哈希前 12 位），绝不记 token 本体 */
  auth: { hasToken: boolean; tokenFingerprint: string }
  /** 任务摘要 */
  task: { present: boolean; paperName: string; paperId: string; runPointListCount: number; shapeLine: string }
  /** 开跑开关的**原值**（人脸/随机抽查/展示等；`null` = 当时没读到） */
  switches: Record<string, string> | null
  /** 摄像头杆 flag（`null` = 未知）与它对应的线路 id */
  cameraFlag: boolean | null
  cameraFlagLineId: string
  cameraFlagError: string
  /** **当时**的门禁终值（由同一个 `evaluateRunGate()` 算出；只是证据，不用于放行） */
  gateAllow: boolean
  gateBlockedBy: string
  gateReason: string
}

/**
 * 时间线按窗口过滤/截断的结果（写进 manifest + 界面能显示，**由纯函数产出**）。
 *
 * 为什么要单独记 `droppedToCap` 与 `outOfWindow`（2026-09-21 那版只有一个"最近 300 条"）：
 * 维护者必须能一眼分清"**这段时间里本来就没有操作**"与"**有操作但被上限截掉了**" ——
 * 二者的排查方向完全不同（前者查复现步骤、后者要放宽 `DIAG_TIMELINE_MAX`）。
 */
export interface DiagTimelineStats {
  /** 事件日志里一共有多少条 */
  input: number
  /** `at` 落在窗口内的条数（截断前） */
  inWindow: number
  /** 落在窗口之外的条数（被过滤掉） */
  outOfWindow: number
  /** `at` 解析不出来、无法判断的条数（窗口生效时被剔除） */
  unparsable: number
  /** 因超过 `DIAG_TIMELINE_MAX` 被**上限**截掉的条数（不算窗口外那部分） */
  droppedToCap: number
}

/** 时间线过滤只关心这三件事（**刻意不引 `LogEntry`**：契约层不依赖其它模块，保持可离线单测） */
export interface DiagTimelineInput {
  at: string
  level: string
  cat: string
  text: string
}

/**
 * 窗口过滤的**左边界容差**（ms）：用户点「开始记录」⇄ 服务端落窗口之间有几毫秒到几百毫秒的差，
 * 而浏览器与这份 EXE 跑在**同一台机器**上（`startedAtMs` 与服务端 `new Date().getTime()` 同源，
 * 不存在跨机器时钟漂移），所以 1 秒的容差足够吸收往返延迟。
 *
 * ⚠️ **右边界刻意不给容差**（2026-09-22 实测修正）：窗口一旦封存（`stopSession()` 已算出 `endedAtMs`），
 * "之后"发生的事就**明确不属于**这一段记录 —— 而「结束并导出」自己那条日志恰恰发生在 stop 返回之后。
 * 实测（真实浏览器导出解包）第一版对右边界也给了 1 秒容差，于是那条日志**混进了时间线**，
 * 包里出现"窗口内 2/3 条"的自相矛盾。只在左边界留容差，右边界按 **`≤ endedAtMs` 严格**判。
 */
export const DIAG_WINDOW_TOLERANCE_MS = 1000

/**
 * **按记录窗口过滤**事件日志，并把 `DIAG_TIMELINE_MAX` 作为**上限兜底**。
 *
 * 取舍（写下来免得后人以为是漏了）：
 *   · `window === null`（服务端拿不到窗口）⇒ **不过滤**、退回"最近 N 条"的旧口径，但**同样受上限约束**
 *     （宁可少给也不能让包爆掉；此时 manifest 会写明"未按记录窗口过滤"）；
 *   · 超出上限时保留**最早 `DIAG_TIMELINE_HEAD_KEEP` 条 + 最新若干条**（合计 `DIAG_TIMELINE_MAX`）：
 *     开头含「开始记录」与最初的复现步骤，是最能说明"从哪开始出问题"的一段 —— 旧的"只留尾部"恰好把它丢掉；
 *   · 时间戳解析不出来的条目在窗口生效时按"窗口外"处理（无法证明它在窗口内），但**单独计数**（`unparsable`），
 *     便于以后判断"是不是有别的写法的时间戳"；
 *   · 左边界留 `DIAG_WINDOW_TOLERANCE_MS` 容差、**右边界严格**（理由见上面的常量注释）。
 *
 * 本函数是**纯函数**（客户端筛选 / 服务端核对共用），有单测 `tests/mp/diagnostics.test.ts`。
 */
export function diagTimelineInWindow(
  entries: DiagTimelineInput[],
  window: { startedAtMs: number; endedAtMs: number } | null,
  nowMs: number = Date.now(),
  max: number = DIAG_TIMELINE_MAX,
  headKeep: number = DIAG_TIMELINE_HEAD_KEEP,
): { items: DiagTimelineInput[]; stats: DiagTimelineStats } {
  const input = entries.length
  const stats: DiagTimelineStats = { input, inWindow: 0, outOfWindow: 0, unparsable: 0, droppedToCap: 0 }
  const keep: DiagTimelineInput[] = []
  for (const e of entries) {
    if (window) {
      const t = Date.parse(String(e.at ?? ''))
      if (!Number.isFinite(t)) {
        stats.unparsable++
        continue
      }
      // 窗口未结束（仍在记录）时用"此刻"当右边界；左边界留 1 秒容差（点按钮 ⇄ 服务端落窗口之间的往返）
      const end = window.endedAtMs > 0 ? window.endedAtMs : nowMs
      if (t < window.startedAtMs - DIAG_WINDOW_TOLERANCE_MS || t > end) {
        stats.outOfWindow++
        continue
      }
    }
    stats.inWindow++
    keep.push(e)
  }
  const cap = Math.max(0, Math.floor(max))
  if (keep.length <= cap) return { items: keep, stats }
  const head = Math.max(0, Math.min(Math.floor(headKeep), cap))
  const tail = cap - head
  stats.droppedToCap = keep.length - cap
  return { items: [...keep.slice(0, head), ...(tail > 0 ? keep.slice(-tail) : [])], stats }
}

/** 包内清单：界面"导出前预览"与服务端 `manifest.json` **共用**（同一个函数生成，避免两处口径不一致） */
export interface DiagManifestEntry {
  /** 包内路径（如 `logs/app-2026-09-21.log`） */
  name: string
  /** 人类可读说明 */
  note: string
}
/**
 * @param input.logNames     包内会出现的日志文件名（不含 `logs/` 前缀）
 * @param input.includeGeometry 是否含坐标（决定最后那条"说明"怎么写）
 * @param input.logNote      🆕 2026-09-22：日志条目的**统一补充说明**（服务端按记录窗口过滤后写"只含窗口内的行、
 *                           共 N 行、剔了 M 行"这类话）。不传 = 老文案（保持既有调用方与单测不变）。
 * @param input.window       🆕 2026-09-22：本次导出所依据的记录窗口（有就在清单里**明写窗口 id 与起止时间**，
 *                           让维护者一眼看出"这个包只覆盖这一段"）。传 `null`/不传 = 没按窗口过滤。
 */
export function diagManifestEntries(input: {
  logNames: string[]
  includeGeometry: boolean
  logNote?: string
  window?: { id: string; startedAt: string; endedAt: string } | null
}): DiagManifestEntry[] {
  const entries: DiagManifestEntry[] = [
    { name: DIAG_MANIFEST_NAME, note: '本次导出的清单（本文件）' },
    { name: DIAG_SNAPSHOT_NAME, note: '本机状态快照：任务原始 JSON、路线库摘要、门禁依据、操作时间线、版本与账号（已脱敏）' },
  ]
  const baseLogNote = '服务端文件日志：每个上游请求一行（端点/耗时/上游原话/字段名，token 已掩码）'
  for (const n of input.logNames) entries.push({ name: `${DIAG_LOG_DIR}/${n}`, note: input.logNote ? `${baseLogNote}；${input.logNote}` : baseLogNote })
  if (input.window) {
    /**
     * ⚠️ 这里的 note 会**原样渲染到界面**（`DiagnosticsExportCard.vue` 的 `{{ m.note }}`），
     * 所以**不许出现 markdown 标记**（Vue 不渲染 markdown，用户会看到字面的星号 —— `ERROR.md` E44 的老坑）。
     * 运行期生成的文案原来没人守（`uiText.test.ts` 只扫 `.vue` 模板字面量），
     * 2026-09-22 已补一条**直接对 `diagManifestEntries()` 输出**的断言（审计 B5）。
     */
    entries.push({
      name: '(记录窗口)',
      note:
        `本包按这一次记录窗口取数据：窗口 id ${input.window.id}，` +
        `${input.window.startedAt}${input.window.endedAt ? ` ~ ${input.window.endedAt}` : ' ~（仍在记录）'}。` +
        '窗口由服务端持有（同一次运行内刷新/切页/重开浏览器都不中断；关掉本程序再启动则从零开始）。',
    })
  }
  entries.push({
    name: '(说明)',
    note: input.includeGeometry
      ? '包含你描过的跑道与任务的坐标（用于诊断线路/拟合度）；不含 token 明文，学号与姓名已掩码'
      : '不含跑道/任务的坐标；不含 token 明文，学号与姓名已掩码',
  })
  return entries
}

/**
 * 把**已被 JSON 转义**的文本还原成"人会看到的样子"，供红线判据再跑一遍。
 *
 * 🔴 为什么必须有这一步（2026-09-22 独立审计实测反例）：
 * 判据原先只在**原始 JSON 文本**上跑，而 JSON 里引号是 `\"`、制表符是 `\t` ⇒
 * `{"timeline":[{"text":"body={\"token\":\"<34位>\"}"}]}` 里的 `"token":"…"` 被判据的
 * `"token"\s*:\s*"…"` **漏掉**（`\"` 不匹配 `"`），`Bearer\t…` 同理（`\s` 匹配不到两个字符的转义序列）。
 * 也就是说：**只要凭证是"被转义进 JSON 的"，红线就形同虚设** —— 这条必须堵。
 *
 * 做法（保守、只放松"能不能看见"，不放松判据本身）：把常见转义还原后再跑同一组正则；
 * 两个方向都命中才算命中，所以**不会**因此把正常文本误判成凭证（误判只会来自还原后的真实凭证样式）。
 */
export function unescapeForRedlineScan(text: string): string {
  return String(text ?? '')
    .replace(/\\u([0-9a-f]{4})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\[tnrf]/g, ' ')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\')
}

/**
 * 导出前的"红线自检"：包内**任何**文本都不许出现凭证样式（服务端与单测共用同一判据）。
 *
 * ⚠️ 每条文本会跑**原文 + 还原转义后的两个变体**（见 `unescapeForRedlineScan()`）——
 * 只跑原文会让"转义进 JSON 的凭证"漏网（审计实测反例，已有单测钉住）。
 *
 * 🔴 2026-09-22 闸门复验**第二轮**：本文件**不再持有任何凭证正则**。
 * 上一版还留着 4 条（`Bearer` / token 字段 / `token=` / `sk-`），与掩码侧的低熵门槛不同 ⇒ 又出现分叉：
 * `Authorization: Bearer abcdefghijklmnopqrst`（22 位纯小写）**掩码侧不掩** ⇒ 真落盘 ⇒ 红线命中 ⇒
 * **整个日志文件被剔出包**。现在**唯一判据**是 `credentialScan` 的 `hasUnmaskedCredential()`
 * （内部就是"掩码侧能不能掩掉这段"），因此 **"掩码说安全 ⇒ 红线必不命中"** 是构造性成立的
 * （单测用反例夹具逐条钉：`Bearer <22 位>`、`?token=<22 位>`、`sk-`、JWT、高熵）。
 * 代价：命中原因只剩一条笼统说明（分不出是哪一类）—— 换来的是两侧**不可能**再分叉。
 */
export function assertNoCredentials(texts: string[]): { ok: boolean; hits: string[] } {
  const hits: string[] = []
  for (const raw of texts) {
    for (const t of [raw, unescapeForRedlineScan(raw)]) {
      if (hasUnmaskedCredential(t)) hits.push('未掩的凭证形态（与掩码侧同一判据）')
    }
  }
  return { ok: hits.length === 0, hits: [...new Set(hits)] }
}
