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
 */

/** 导出接口（与既有 `/api/local/*` 同风格：本机、只读日志 + 用户自己的快照） */
export const DIAG_EXPORT_PATH = '/api/local/diagnostics/export'
/** 包内文件名（服务端写、界面展示、单测断言共用同一组常量） */
export const DIAG_MANIFEST_NAME = 'manifest.json'
export const DIAG_SNAPSHOT_NAME = 'snapshot.json'
export const DIAG_LOG_DIR = 'logs'
/** 服务端随包附带最近几天的日志（"能带什么就带什么"，但别无限膨胀） */
export const DIAG_LOG_DAYS = 3
/** 包内日志文件的体积上限（超出则截断并在 manifest 里注明；防止一个几百 MB 的日志把包撑爆） */
export const DIAG_LOG_MAX_BYTES = 8 * 1024 * 1024

/** 应用内事件时间线：最多带多少条（界面只展示尾部，包内也够排障） */
export const DIAG_TIMELINE_MAX = 300

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
    summary: {
      paperId: string
      paperName: string
      taskName: string
      km: number | null
      fitDegreeThreshold: number | null
      validFrom: string
      validTo: string
      runPointListCount: number
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
  /** 应用内事件时间线（尾部 `DIAG_TIMELINE_MAX` 条，已脱敏） */
  timeline: { at: string; level: string; cat: string; text: string }[]
}

/** 包内清单：界面"导出前预览"与服务端 `manifest.json` **共用**（同一个函数生成，避免两处口径不一致） */
export interface DiagManifestEntry {
  /** 包内路径（如 `logs/app-2026-09-21.log`） */
  name: string
  /** 人类可读说明 */
  note: string
}
export function diagManifestEntries(input: { logNames: string[]; includeGeometry: boolean }): DiagManifestEntry[] {
  const entries: DiagManifestEntry[] = [
    { name: DIAG_MANIFEST_NAME, note: '本次导出的清单（本文件）' },
    { name: DIAG_SNAPSHOT_NAME, note: '本机状态快照：任务原始 JSON、路线库摘要、门禁依据、操作时间线、版本与账号（已脱敏）' },
  ]
  for (const n of input.logNames) entries.push({ name: `${DIAG_LOG_DIR}/${n}`, note: '服务端文件日志：每个上游请求一行（端点/耗时/上游原话/字段名，token 已掩码）' })
  entries.push({
    name: '(说明)',
    note: input.includeGeometry
      ? '包含你描过的跑道与任务的坐标（用于诊断线路/拟合度）；不含 token 明文，学号与姓名已掩码'
      : '不含跑道/任务的坐标；不含 token 明文，学号与姓名已掩码',
  })
  return entries
}

/** 导出前的"红线自检"：包内**任何**文本都不许出现凭证样式（服务端与单测共用同一判据） */
export function assertNoCredentials(texts: string[]): { ok: boolean; hits: string[] } {
  const patterns: { re: RegExp; why: string }[] = [
    { re: /Bearer\s+[A-Za-z0-9._-]{16,}/i, why: 'Bearer 凭证' },
    { re: /\beyJ[A-Za-z0-9._-]{20,}/, why: 'JWT 样式串' },
    { re: /"token"\s*:\s*"[^"]{16,}"/i, why: 'token 字段明文' },
    { re: /token=[A-Za-z0-9._-]{16,}/i, why: 'token= 查询串' },
  ]
  const hits: string[] = []
  for (const t of texts) for (const p of patterns) if (p.re.test(t)) hits.push(p.why)
  return { ok: hits.length === 0, hits: [...new Set(hits)] }
}
