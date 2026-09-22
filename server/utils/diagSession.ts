/**
 * 「这一次诊断记录」的**记录窗口**（服务端持有）—— 2026-09-22 新增（issue #12 二次返工）
 *
 * ## 为什么要有它（用户原话）
 * > 刷新为什么会丢？我们要做的是**软件层面上的所有服务进行记录**啊
 * > 我说的是诊断那个功能，要求他的生命周期是基于我们运行的 exe 的，而不是刷新一下的实例
 *
 * 旧实现把"开始时刻 / 坐标开关"放在**浏览器**里（先是组件 `ref`，后来改成 `useState`）。
 * `useState` 只解决"切页时组件卸载"，**刷新浏览器仍然丢** ⇒ 用户回来时「结束并导出」不可用
 * （issue #12 实测："记录好像被重置了，又变成点击开始记录了"）。
 *
 * ## 现在的口径（三条，缺一不可）
 * 1. **主存 = 本模块的模块级单例**（服务端进程内存）。刷新页面 / 切页 / 关掉浏览器再打开，
 *    只要这个 EXE 还在跑，窗口就在 ⇒ 界面 `GET /api/local/diagnostics/record` 一问就恢复
 *    "正在记录 + 已记录多久"（时长由服务端 `startedAt` 算，不归零）。
 * 2. `diagnostics/session.json` 是**同一实例内的持久化/导出依据**（运行目录与日志同级）：
 *    内存为主、文件为辅 —— 内存没有时（例如 lazy 初始化还没发生）才去读文件。
 * 3. 🔒 **窗口绑定"这一次运行的 EXE 实例"**：每个窗口都带 `instanceId`
 *    （`<进程启动 epoch ms>-<随机 hex>`，进程启动时生成一次、之后恒定）。
 *    读到磁盘上的窗口但 `instanceId` 不是本进程的 ⇒ **一律当作"没有窗口"**（那是上一次运行的残留），
 *    并记下"已忽略哪个实例的窗口"供 manifest 说明与排障。
 *    ⇒ 语义正好是用户要的：**同一次运行内不中断；关掉 EXE 再启动 ⇒ 从零开始（未记录）**。
 *
 * ## 隐私红线（与 `utils/mp/diagnostics.ts` 同一口径）
 * 🔴 窗口文件里**只有** id / 实例标识 / 时间戳 / 坐标开关 ——
 * **绝不允许**出现 token、学号、姓名（有单测直接断言文件内容与对象形状）。
 * 反序列化时**逐字段白名单重建**（不 spread 磁盘对象）⇒ 就算有人手工往文件里塞了别的字段，
 * 也不可能被带进 manifest 或界面。
 *
 * ## 主存 vs 文件（明确写下来，免得后人猜）
 * - **不保留历史窗口列表**：只保留"当前窗口"，结束后就地**封存为最近一次**（`recording: false`）。
 *   理由：导出永远只针对"这一次记录"；留一摞历史窗口既没人用，也让"当前到底是哪一次"变得含糊。
 * - 进程启动时**不自动续用**旧窗口（即使 `instanceId` 恰好相同也不会发生 —— 每次启动都是新 id）。
 * - 写盘**尽力而为**：写失败也要让记录继续（内存里那份仍然有效），并把失败记进服务端日志。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { DiagWindow } from '../../utils/mp/diagnostics'
import { RUNTIME_DIR, logWarn } from './logger'

/**
 * 窗口文件所在目录（默认 `%TEMP%\totoro-heaven-runtime\diagnostics`，与 `logs/` 同级）。
 *
 * 🆕 2026-09-22（审计 B8）：给出与 `TOTORO_LOG_DIR` 对称的**环境变量逃生口** `TOTORO_DIAG_DIR`。
 * 为什么需要：日志目录早就能被覆盖，窗口目录却不能 ⇒ 并行跑多个实例 / 想隔离测试时，
 * 窗口仍然落共享的 `%TEMP%`（两个实例抢同一份文件）。有了它，"两个实例各自一份窗口"才做得到。
 */
export const DIAG_SESSION_DIR = process.env.TOTORO_DIAG_DIR?.trim() || join(RUNTIME_DIR, 'diagnostics')
/** 窗口文件名（单一来源：单测与排障脚本都引它） */
export const DIAG_SESSION_NAME = 'session.json'
/** 窗口文件的完整路径（生产用；单测请用各函数的 `dir` 参数注入临时目录） */
export const DIAG_SESSION_FILE = join(DIAG_SESSION_DIR, DIAG_SESSION_NAME)

/**
 * 🔒 本进程实例的标识：`<进程启动 epoch ms>-<随机 hex>`。
 *
 * - `process.uptime()` 给出"进程已运行多少秒"，反推启动时刻（取整到秒，足够区分两次运行）；
 * - 再拼 8 字节随机数：**即使两次运行在同一秒内启动**（测试/快速重启）也不会撞车；
 * - **进程内恒定**（模块加载时算一次）⇒ 可以放心写进窗口文件做"是不是我这一次运行"的判据。
 */
export const DIAG_INSTANCE_ID = `${Date.now() - Math.floor(process.uptime() * 1000)}-${randomBytes(8).toString('hex')}`
/** 本进程启动时刻（epoch ms，界面上写"这一份记录属于哪一次运行"用） */
export const DIAG_INSTANCE_STARTED_MS = Date.now() - Math.floor(process.uptime() * 1000)

/** 反序列化结果（`window: null` 时 `reason` 说明为什么当"没有窗口"） */
export type SessionLoadReason = 'ok' | 'missing' | 'malformed' | 'stale-instance'

/** 被忽略的"上一个实例的窗口"（供 export 写进 manifest 说明，以及排障） */
let ignoredPrevInstance: { instanceId: string; startedAt: string; id: string; at: string } | null = null

/** 本进程内被判定为"上一个实例残留"的窗口（`null` = 没遇到过）；导出时写进 manifest */
export function ignoredPrevInstanceInfo(): { instanceId: string; startedAt: string; id: string; at: string } | null {
  return ignoredPrevInstance
}

/** 内存主存：`undefined` = **还没 lazy 读过文件**；`null` = 读过、确实没有窗口 */
let memory: DiagWindow | null | undefined

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 读一个字符串字段（非字符串一律空串） */
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
/** 读一个数字字段（有限数才算，否则 0） */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * 从**白名单字段**重建一个窗口（不 spread 磁盘对象）。
 *
 * 为什么这么写：磁盘上的 JSON 是"外部输入"（用户可能手工改过、或被别的东西写过），
 * 直接 `as DiagWindow` 会把**多出来的字段**一路带进 manifest / 界面 —— 那就绕过了"窗口里只有 id/时间/开关"的红线。
 * 只要 `id` / `instanceId` / `startedAtMs` 这三样站不住，就判定为**读不出窗口**（不猜、不修补）。
 */
export function coerceWindow(raw: unknown): DiagWindow | null {
  if (!isObj(raw)) return null
  const id = str(raw.id)
  const instanceId = str(raw.instanceId)
  const startedAtMs = num(raw.startedAtMs)
  if (!id || !instanceId || startedAtMs <= 0) return null
  const endedAtMs = num(raw.endedAtMs)
  return {
    id,
    instanceId,
    recording: raw.recording === true,
    startedAt: str(raw.startedAt),
    startedAtMs,
    endedAt: str(raw.endedAt),
    endedAtMs: endedAtMs > 0 ? endedAtMs : 0,
    includeGeometry: raw.includeGeometry !== false,
  }
}

/** 造一个新窗口（`includeGeometry` 默认 true —— 与界面开关默认值一致） */
function newWindow(includeGeometry: boolean, now: Date): DiagWindow {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return {
    id: `w-${stamp}-${randomBytes(3).toString('hex')}`,
    instanceId: DIAG_INSTANCE_ID,
    recording: true,
    startedAt: now.toISOString(),
    startedAtMs: now.getTime(),
    endedAt: '',
    endedAtMs: 0,
    includeGeometry,
  }
}

/** 文件路径（`dir` 只给单测注入临时目录用；生产不传） */
const fileOf = (dir: string): string => join(dir, DIAG_SESSION_NAME)

/**
 * 读磁盘上的窗口（**只读、不改内存**）。返回值里 `reason` 说明结论来自哪条分支：
 * - `missing`：文件不存在（或目录不存在）——最正常的情况；
 * - `malformed`：文件在，但内容不是合法 JSON / 字段站不住 ⇒ 当"没有窗口"；
 * - `stale-instance`：文件是**别的实例**写的 ⇒ 当"没有窗口"，并记进 `ignoredPrevInstance`；
 * - `ok`：文件是本实例写的窗口。
 */
export function readSessionFile(dir: string = DIAG_SESSION_DIR): { window: DiagWindow | null; reason: SessionLoadReason } {
  const path = fileOf(dir)
  if (!existsSync(path)) return { window: null, reason: 'missing' }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // 文件损坏（半截写入 / 手工改坏）⇒ 当"没有窗口"：窗口是**辅助**信息，不能让它把记录与导出整条链路带崩
    logWarn('ui', '诊断记录：窗口文件损坏，按"没有窗口"处理', { dir, file: DIAG_SESSION_NAME })
    return { window: null, reason: 'malformed' }
  }
  const win = coerceWindow(raw)
  if (!win) {
    logWarn('ui', '诊断记录：窗口文件字段不完整，按"没有窗口"处理', { dir, file: DIAG_SESSION_NAME })
    return { window: null, reason: 'malformed' }
  }
  if (win.instanceId !== DIAG_INSTANCE_ID) {
    /**
     * 🔴 关键分支：磁盘上是**上一次运行**的窗口（EXE/dev 重启过）。
     * 一律当"没有窗口" —— 用户要求记录窗口的生命周期"基于我们运行的 exe，而不是刷新一下的实例"，
     * 所以**关掉程序再启动必须从零开始**，绝不继承。
     */
    ignoredPrevInstance = { instanceId: win.instanceId, startedAt: win.startedAt, id: win.id, at: new Date().toISOString() }
    logWarn('ui', '诊断记录：磁盘上的窗口属于上一个实例，已忽略（本次运行未记录）', {
      prevInstanceId: win.instanceId,
      prevWindowId: win.id,
      currentInstanceId: DIAG_INSTANCE_ID,
    })
    return { window: null, reason: 'stale-instance' }
  }
  return { window: win, reason: 'ok' }
}

/** 把窗口写盘（原子性够用：内容很小，一次 `writeFileSync` 覆盖；失败只记日志、不影响记录本身） */
function writeSessionFile(win: DiagWindow | null, dir: string = DIAG_SESSION_DIR): boolean {
  try {
    const path = fileOf(dir)
    if (win === null) {
      if (existsSync(path)) rmSync(path, { force: true })
      return true
    }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(win, null, 2), 'utf8')
    return true
  } catch (err) {
    /**
     * 写盘失败**不能**让记录失败：内存里那份仍是权威（同一次运行内界面照样能读到窗口）。
     * 代价是"如果是本进程在重启前写的最后一次没能落盘"，用户关掉程序就找不回那一次 —— 记日志留痕即可。
     */
    logWarn('ui', '诊断记录：窗口写盘失败（内存里仍然有效）', { dir, message: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/**
 * 取"当前/最近的窗口"（**内存为主、文件为辅**）：
 * 第一次调用才去读文件（lazy）—— 进程启动时不做任何事，也不"续用"旧窗口。
 *
 * ⚠️ 已结束的窗口**仍然返回**（`recording: false`）：导出要用"最近封存的那一次"，
 * 界面也据此显示"上一次记录（已结束）"。
 */
export function readSession(dir: string = DIAG_SESSION_DIR): DiagWindow | null {
  if (memory === undefined) {
    const loaded = readSessionFile(dir)
    memory = loaded.window
  }
  return memory
}

/** 开始记录：覆盖当前窗口（void：不写盘失败也照样返回内存里这个） */
export function startSession(opts: { includeGeometry?: boolean; dir?: string; now?: Date } = {}): DiagWindow {
  const dir = opts.dir ?? DIAG_SESSION_DIR
  const win = newWindow(opts.includeGeometry !== false, opts.now ?? new Date())
  memory = win
  writeSessionFile(win, dir)
  return win
}

/**
 * 结束记录（**不导出**）：把窗口封存成"最近一次"（`recording: false` + `endedAt`）。
 * 没有窗口 / 窗口已结束 ⇒ 原样返回（幂等：重复点"结束"不会把 `endedAt` 冲掉）。
 */
export function stopSession(opts: { dir?: string; now?: Date } = {}): DiagWindow | null {
  const dir = opts.dir ?? DIAG_SESSION_DIR
  const cur = readSession(dir)
  if (!cur) return null
  if (!cur.recording) return cur
  const now = opts.now ?? new Date()
  const sealed: DiagWindow = { ...cur, recording: false, endedAt: now.toISOString(), endedAtMs: now.getTime() }
  memory = sealed
  writeSessionFile(sealed, dir)
  return sealed
}

/**
 * 记录中改坐标开关（`PATCH /record/geometry` 用）。
 * - 已结束的窗口**也允许改**：导出前的最终选择以用户界面上看到的为准（快照里那个开关才是实际生效的）；
 * - 没有窗口 ⇒ 返回 `null`（界面据此提示"先点开始记录"）。
 */
export function patchSessionIncludeGeometry(includeGeometry: boolean, opts: { dir?: string; now?: Date } = {}): DiagWindow | null {
  const dir = opts.dir ?? DIAG_SESSION_DIR
  const cur = readSession(dir)
  if (!cur) return null
  const next: DiagWindow = { ...cur, includeGeometry: includeGeometry !== false }
  memory = next
  writeSessionFile(next, dir)
  return next
}

/**
 * 清掉窗口（内存 + 文件）——目前**没有生产调用方**（导出后仍保留"最近一次"便于复核），
 * 只给单测与将来的「清除记录」按钮留出口。⚠️ 没有调用方的东西要么删掉要么写明用途，这里写明。
 *
 * ⚠️ 名字**不能叫 `clearSession`**：`h3` 自己导出了一个同名函数，而 Nitro 会把 `server/utils/**` 的导出
 * 一起塞进自动导入表 ⇒ `nuxi typecheck` 报「Duplicated imports "clearSession"」
 * （实测踩到，虽然运行时以本地文件优先、行为正确，但警告会一直在，并且极易让人误解）。
 */
export function clearDiagSession(dir: string = DIAG_SESSION_DIR): void {
  memory = null
  writeSessionFile(null, dir)
}

/** "到此刻为止记录了多少秒"（**唯一算法**；已结束的窗口返回封存时的时长） */
export function sessionElapsedSeconds(win: DiagWindow | null, nowMs: number = Date.now()): number {
  if (!win) return 0
  const end = win.recording ? nowMs : win.endedAtMs || nowMs
  return Math.max(0, Math.round((end - win.startedAtMs) / 1000))
}

/**
 * 🆕 2026-09-22（审计 B2/B4/B6）：请求体判据与"窗口是否同一个"的判据**转发出口**。
 *
 * 实现（唯一一份）在契约层 `utils/mp/diagnostics.ts`（纯函数、有单测），这里只做**再导出**：
 * 原因是 `server/api/local/diagnostics/record/**` 用相对路径引 `<root>/utils/mp/*` 时
 * 本机 `tsc`（moduleResolution=bundler）实测解析不到（同目录的 `server/utils/*` 却正常，
 * 2026-09-22 用临时探针逐个深度对比过），而 `server → 契约层` 是**允许**的依赖方向。
 * ⇒ 端点从本模块取、界面与单测从契约层取，判据始终只有一份实现。
 */
export { diagWindowMatch, readIncludeGeometryFlag } from '../../utils/mp/diagnostics'

/** 供单测复位内存主存（生产不调用） */
export function __resetSessionMemoryForTest(): void {
  memory = undefined
  ignoredPrevInstance = null
}
