/**
 * `POST /api/local/diagnostics/export` —— 「一键诊断导出」的服务端一半（2026-09-21 新增）
 *
 * ## 干什么
 * 收客户端**已脱敏**的 `DiagSnapshot`（`utils/mp/diagnostics.ts` 的契约），
 * 加上**服务端自己去读**的服务端日志，打成**一个 zip** 回给浏览器下载：
 *
 * ```
 * manifest.json      本次导出的清单与元信息（含"按哪个记录窗口过滤""剔了哪些文件/行"这类说明）
 * snapshot.json      客户端快照（原样写入，不再加工）
 * logs/app-<日期>.log 服务端文件日志（**只保留记录窗口内的行**；每文件 ≤ DIAG_LOG_MAX_BYTES，超出截断）
 * ```
 *
 * ## 🆕 2026-09-22（issue #12 二次返工）：按**记录窗口**取数据
 * 用户原话是"刷新为什么会丢？我们要做的是**软件层面上的所有服务进行记录**"——
 * 所以"这一次记录"不再由浏览器定义，而是由服务端窗口（`server/utils/diagSession.ts`）定义，
 * 窗口的生命周期**绑定当前正在运行的这个实例**（进程内存为主，`diagnostics/session.json` 为辅）：
 *   · 窗口在（无论仍在记录还是已封存）⇒ 日志**按 `t` 逐行过滤**到窗口区间，事件时间线同样按窗口过滤；
 *   · 窗口不在（这次运行没点过「开始记录」，或磁盘上只有**上一个实例**的残留窗口）⇒ 见下面第 5 条（**不再静默降级**）。
 *
 * ## 硬约束
 * 1. **日志由服务端读**（`server/utils/diagLogs.ts`，目录口径与 `logger.ts` 同一来源）——
 *    不经过浏览器，用户不必去找 `%TEMP%` 目录，token 也不可能因此流到前端。
 * 2. 🔴 **红线自检**：`snapshot.json` / `manifest.json` 命中 ⇒ **硬拒**；**每个日志**命中 ⇒ **只剔那一个文件**
 *    （`partitionLogsByRedline()`）。错误信息里**只放类别名，绝不放命中到的原文**。
 * 3. **全程只读**：不建目录、不写任何文件；zip 在内存里拼（日志 ≤3×8MB，量级可控）。
 *    ⚠️ 唯一例外在 `diagSession.ts`（它写窗口文件），本端点自身不写盘。
 * 4. **逐行容错**：日志行按 `t` 过滤时，坏的/没有时间戳的行**只跳过并计数**，绝不整包失败。
 * 5. 🔴 **窗口不一致 ⇒ 409 拒导**（2026-09-22 审计 B2 修）：客户端快照里声称的窗口 id
 *    与服务端现在这份**对不上**时（典型场景：EXE/ dev 重启过、而旧标签页还挂着），
 *    以前会**静默**退化成"最近 3 天全量日志"——界面上写着"按本次窗口取数据"，包里却是三天全量 ⇒
 *    用户以为发出去的是那一小段。现在改为**明确拒绝**（409 + 人话 + 结构化字段），让用户刷新/重记。
 *    **只有客户端根本没声称窗口时**（老前端 / 服务端自己刚封存的窗口）才允许走无窗口兜底路径。
 * 6. **账与内容必须自洽**（审计 B1 修）：manifest 里的 `logFiles` / `logBytes` / `lines.*` 一律
 *    只统计**真正进包的文件**；被红线剔除的那部分单独放 `lines.excludedLogsLines`。
 *
 * ## 导入路径口径（照抄同目录族的既有端点，别自己重新数层数）
 * - 根目录的 `utils/**`（契约层/算法层）→ `../../../../utils/...`
 * - `server/utils/**` → `../../../utils/...`（与 `server/api/local/logs/*.ts`、`token-scan/*.ts` 完全一致）
 *
 * ## 已知取舍（写在这里，免得后人以为是漏了）
 * - 日志截断后**仍然进包**（只取**文件头** `DIAG_LOG_MAX_BYTES` 字节），并在 `manifest.json` 的
 *   `files[].note` 里注明原始大小；整包不会因为一个超大日志而失败。
 *   （为什么是文件头而不是尾部：日志是"一天一个文件、顺序追加"，截尾部会把**同一天里最早的追查线索**丢掉；
 *   截头部则可能切在一行 JSON 中间 —— 后者影响有限，`JSON.parse` 失败的行本来就是跳过的。）
 * - 日志里的凭证已被 `logger.ts` 掩码，所以正常情况红线不会命中；真命中说明**有人绕过了掩码**
 *   —— 此时宁可让导出失败，也不能把凭证发出去。
 * - 时间线（`snapshot.json` 里那份）由**客户端**按窗口过滤（它才持有 localStorage 里的事件日志）；
 *   服务端在这里只做**核对与如实记录**（数量对不上就在 manifest 里写明），不静默改写用户的证据。
 */
import { DIAG_EXPORT_PATH, DIAG_LOG_DAYS, DIAG_LOG_MAX_BYTES, DIAG_LOG_DIR, DIAG_MANIFEST_NAME, DIAG_SNAPSHOT_NAME, DIAG_TIMELINE_MAX, assertNoCredentials, diagManifestEntries, diagTimelineInWindow, diagWindowMatch } from '../../../../utils/mp/diagnostics'
import type { DiagSnapshot, DiagWindow } from '../../../../utils/mp/diagnostics'
import { assertLocalRequest } from '../../../utils/tokenScanState'
import { diagLogsLinesInWindow, partitionLogsByRedline, recentLogFiles, summarizeDiagLineAccount } from '../../../utils/diagLogs'
import { stripGeometryFromRespBody } from '../../../../utils/mp/responseRecord'
import { DIAG_INSTANCE_ID, ignoredPrevInstanceInfo, readSession, sessionElapsedSeconds } from '../../../utils/diagSession'
import { logInfo, logWarn } from '../../../utils/logger'
import { createZip } from '../../../utils/zip'

/** `yyyyMMdd-HHmm`（下载文件名用；本地时间，与用户直觉一致） */
function compactStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** 非数组、null、数组都算"不是对象"（客户端契约要求这里是一个 JSON 对象） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)

  // ---------- ① 取快照（缺失/非对象 ⇒ 400，回人话）----------
  const body = (await readBody(event).catch(() => ({}))) as { snapshot?: unknown }
  const snapshot = body?.snapshot
  if (!isPlainObject(snapshot)) {
    throw createError({
      statusCode: 400,
      statusMessage: `请求体缺少 snapshot 对象：请在界面上点「结束并导出」（本接口由 ${DIAG_EXPORT_PATH} 接收 DiagSnapshot JSON），不要手工调用`,
    })
  }
  const snap = snapshot as unknown as DiagSnapshot
  /** 客户端**声称**的窗口 id（新前端会带；老前端没有 ⇒ 空串，走无窗口兜底路径） */
  const clientWindowId = String(snap?.window?.id ?? '')

  // ---------- ② 取**记录窗口**（服务端持有；内存为主、文件为辅）----------
  /**
   * `readSession()` 只在**本实例**写过窗口时才返回东西：
   * 磁盘上若是"上一个实例"的残留，它已经被 `diagSession.ts` 判为"没有窗口"并记进 `ignoredPrevInstanceInfo()`。
   * 这里不再做第二次判断 —— 判据只有一处（避免两处口径漂移）。
   */
  const now = new Date()
  const win: DiagWindow | null = readSession()
  const prevInstance = ignoredPrevInstanceInfo()
  if (prevInstance && !win) {
    // 这条日志本身就是"为什么这次没按窗口过滤"的答案（用户看不到 manifest 之前先能在这里查到）
    logWarn('ui', '诊断导出：磁盘上的记录窗口属于上一个实例，本次按"未按记录窗口过滤"处理', {
      prevInstanceId: prevInstance.instanceId,
      currentInstanceId: DIAG_INSTANCE_ID,
    })
  }

  /**
   * 🔴 窗口一致性闸门（审计 B2）：客户端声称了窗口，而服务端这份**不是同一个**（或压根没有）
   * ⇒ **当场拒绝**，不回 zip。宁可让用户重来一次，也不能把"三天全量日志"当成"这一次记录"发出去。
   * 唯一放行的"不一致"：客户端报的 id 就是本进程当前窗口（正常路径），或者客户端没报（老前端）。
   * 判据是契约层的纯函数 `diagWindowMatch()`（服务端与界面共用一份，避免两处松紧不一致）。
   */
  const clientInstanceId = String(snap?.serverInstanceId ?? '')
  const mismatch = diagWindowMatch({
    clientWindowId,
    respondedWindowId: win?.id ?? '',
    serverInstanceId: DIAG_INSTANCE_ID,
    reportedInstanceId: clientInstanceId,
  })
  if (mismatch) {
    logWarn('ui', '诊断导出被拒：客户端声称的记录窗口与服务端当前窗口不一致', {
      clientWindowId,
      serverWindowId: win?.id ?? '(无)',
      reason: mismatch.reason,
      serverRecording: win ? win.recording : null,
      currentInstanceId: DIAG_INSTANCE_ID,
    })
    throw createError({
      statusCode: 409,
      statusMessage:
        `拒绝导出：${mismatch.detail} —— 这一页手里的窗口（${clientWindowId}）不是服务端现在这个。` +
        '继续导出会让包里变成"没有按记录窗口过滤"的全量日志，而不是你要发的那一段。' +
        '请回到诊断页刷新，重新点「开始记录」→ 复现问题 → 「结束并导出」。',
      data: {
        kind: 'diag-window-mismatch',
        reason: mismatch.reason,
        clientWindowId,
        serverWindowId: win?.id ?? '',
        serverRecording: win ? win.recording : null,
        serverInstanceId: DIAG_INSTANCE_ID,
        ignoredPreviousInstance: prevInstance ? { id: prevInstance.id, instanceId: prevInstance.instanceId } : null,
      },
    })
  }
  /** 最终生效的窗口：有就用它（正常路径），没有就 `null`（仅在**客户端也没声称窗口**时才会走到这里） */
  const windowRange = win ? { startedAtMs: win.startedAtMs, endedAtMs: win.recording ? 0 : win.endedAtMs } : null
  /** 回给客户端的窗口标识（响应头 `X-Diag-Window`；界面据此确认"发给我的就是这个窗口"） */
  const effectiveWindowId = win?.id ?? ''

  // ---------- ③ 服务端自己读日志（只读；目录不存在就是"没有日志"）----------
  const logFiles = recentLogFiles(DIAG_LOG_DAYS, DIAG_LOG_MAX_BYTES)
  /**
   * 按窗口逐行过滤（纯函数，有单测）。**无论有没有窗口都会跑一遍**：
   * `window = null` 时它退化为"原样返回并数行数"，这样 manifest 里的行数计数两种路径口径一致。
   *
   * 🆕 2026-09-22：日志行里现在有**响应内容**（`respBody`，见「全记录」）——任务/线路响应会带经纬度。
   * 用户在界面上**关掉**「包含跑道/任务坐标」时，包里就不该还有坐标 ⇒ 这里逐行把 `respBody` 里的
   * 坐标字段剥掉（`stripGeometryFromRespBody()`，纯函数、有单测）；**开关打开时一个字节都不动**。
   * 判据为可执行：只删 `COORD_KEYS` 那些键，其余字段（含结构与长度）原样保留。
   */
  const includeGeometry = Boolean(snap?.trackLibrary?.includeGeometry)
  const scoped = logFiles.map((f) => {
    const scope = diagLogsLinesInWindow(f.text, windowRange)
    if (includeGeometry || !scope.text) return { file: f, scope }
    const text = scope.text
      .split('\n')
      .map((line) => {
        if (!line.includes('"respBody"')) return line
        try {
          const obj = JSON.parse(line) as Record<string, unknown>
          if (obj && typeof obj === 'object' && obj.respBody !== undefined) {
            obj.respBody = stripGeometryFromRespBody(obj.respBody)
            /**
             * ⚠️ 这里**重新序列化**了日志行（唯一一处）—— 因为要改动 JSON 内容。
             * 代价：该行的键序/空白与磁盘上不再逐字节相同；换来的是"用户关掉坐标开关后包里真的没有坐标"。
             * 只对**含 `respBody` 的行**这么做，其余行原样保留。
             */
            return JSON.stringify(obj)
          }
        } catch {
          // 单行坏了就原样留着（红线与窗口过滤的口径都不受影响；坏行本来就会被下游跳过）
        }
        return line
      })
      .join('\n')
    return { file: f, scope: { ...scope, text } }
  })

  // ---------- ④ 🔴 红线自检（**降级而非整包拒绝**，2026-09-21 父代理定）----------
  /**
   * 判据分两类，处置不同 —— 目标既是"**绝不泄漏凭证**"，也要"**别让用户什么都导不出**"（用户原话：能带什么就带什么）：
   *  · `snapshot.json` / `manifest.json`（本程序自己生成的）命中 ⇒ **硬拒**：那是客户端的 bug，不该发生，必须暴露；
   *  · **日志文件**命中 ⇒ **只排除那一个文件**，其余照出，并在清单里写明"被排除"。
   *
   * ⚠️ 顺序：**先按窗口过滤、再过红线、再算账**（审计 B1）——
   * 进包的文本才是要过红线和要统计的东西；先算账会把被剔文件的行数算进去，导致账与内容不自洽。
   */
  const snapshotJson = JSON.stringify(snapshot, null, 2)
  const coreRedline = assertNoCredentials([snapshotJson])
  if (!coreRedline.ok) {
    logWarn('ui', '诊断导出被红线拦下（快照命中凭证样式）', { reasons: coreRedline.hits })
    throw createError({
      statusCode: 500,
      statusMessage:
        `拒绝导出：快照命中凭证红线（${coreRedline.hits.join('、')}）—— 这是本程序自身的脱敏缺陷，请把这个提示截图发给开发者。` +
        '同时建议先把该凭证失效（重新登录）。',
    })
  }
  /** 逐个日志过红线，命中的剔除（不进包）—— 判据是纯函数 `partitionLogsByRedline`（有单测） */
  const { safe: safeLogs, excluded: excludedLogs, reasons: excludedReasons } = partitionLogsByRedline(
    scoped.map(({ file, scope }) => ({ name: file.name, text: scope.text, bytes: file.bytes, truncated: file.truncated })),
  )
  for (const [name, hits] of Object.entries(excludedReasons)) {
    logWarn('ui', '诊断导出已排除一个日志文件（命中凭证样式）', { name, reasons: hits })
  }
  /** 进包的日志文本（按 `safeLogs` 收口；后续 zip 与所有账目都只认它） */
  const scopedByName = new Map(scoped.map((x) => [x.file.name, x]))
  const safeScoped = safeLogs.map((f) => ({ file: f, scope: scopedByName.get(f.name)!.scope }))
  const excludedScoped = excludedLogs.map((f) => ({ file: f, scope: scopedByName.get(f.name)!.scope }))
  /**
   * 🆕 账目**只按进包文件**重算（审计 B1）：`logFiles/logBytes/logFilesTruncated/lines.*` 全部来自它，
   * 被剔文件的行数单列 `lines.excludedLogsLines`。判据在纯函数 `summarizeDiagLineAccount()`（有单测）。
   */
  const account = summarizeDiagLineAccount(
    scoped.map((x) => ({ name: x.file.name, bytes: x.file.bytes, truncated: x.file.truncated, scope: x.scope })),
    safeLogs.map((f) => f.name),
  )
  const logEntries = safeScoped.map(({ file: f, scope }) => {
    const notes: string[] = []
    /**
     * ⚠️ 审计（可疑 4）：这里说的是**磁盘上原始文件**的大小，而包内同名 `.log` 只含窗口内的行 ——
     * 老文案写"共 N 字节"会让人以为包里有这么多（顶层 `diagnostics.logBytesInPackage` 已经分开，
     * 文件条目也得跟上）。现在明确写"磁盘原始大小"，并紧跟一句"包内实际见 diagnostics"。
     */
    notes.push(f.truncated
      ? `磁盘原始 ${f.bytes} 字节，超过单文件上限 ${DIAG_LOG_MAX_BYTES} 字节已截断（保留「文件尾」${DIAG_LOG_MAX_BYTES} 字节 —— 最新证据优先）`
      : `磁盘原始 ${f.bytes} 字节（未截断）`)
    // 包内实际多少：与顶层 `diagnostics.logBytesInPackage / lines.*` 同口径，避免"文件条目说 100KB、包里只有 2KB"的误读
    notes.push(`本包内这个文件只含窗口内的行，实际大小见 manifest 顶层 diagnostics（本文件保留 ${scope.kept} 行）`)
    /**
     * 🆕 2026-09-22「全记录」：日志行里现在有**响应结构 + 脱敏后的响应内容**（`respShape` / `respBody` / `unpack`）。
     * 这句必须写在每个日志文件的说明里 —— 否则维护者看到 `respBody` 会以为是别的东西，
     * 用户看到包里日志变大也不知道多了什么。
     */
    notes.push('每行含该请求的响应结构 respShape 与脱敏后的响应内容 respBody（单条 ≤32KB）+ 解包退化标记 unpack')
    if (win) {
      notes.push(`按记录窗口过滤：保留 ${scope.kept} 行、剔除窗口外 ${scope.outOfWindow} 行${scope.unparsable ? `、另有 ${scope.unparsable} 行没有可解析的时间戳也被剔除` : ''}`)
    } else {
      notes.push(`未按记录窗口过滤（本次运行没有记录窗口）：原样收录 ${scope.kept} 行`)
    }
    return {
      name: `${DIAG_LOG_DIR}/${f.name}`,
      note: `服务端文件日志：每个上游请求一行（端点/耗时/上游原话/字段名，token 已掩码）；${notes.join('；')}`,
    }
  })

  // ---------- ⑤ 生成 manifest.json ----------
  /** 客户端快照自带的时间线（已按窗口过滤）；这里**核对**它，不改写 */
  const clientTimeline = Array.isArray(snap?.timeline) ? snap.timeline : []
  const timelineCheck = diagTimelineInWindow(
    clientTimeline.map((e) => ({ at: String(e?.at ?? ''), level: String(e?.level ?? ''), cat: String(e?.cat ?? ''), text: String(e?.text ?? '') })),
    win ? { startedAtMs: win.startedAtMs, endedAtMs: win.recording ? 0 : win.endedAtMs } : null,
  )
  const manifest = {
    kind: 'totoro-heaven-diagnostics',
    /** 导出时刻（服务端本地时间 + ISO，便于跨时区对照） */
    exportedAt: now.toISOString(),
    exportedAtLocal: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
    /**
     * 应用版本：以**客户端快照里的**为准（服务端不打包前端产物、没有第二个版本号来源）；
     * 万一客户端没给（老版本前端），回落到 npm 注入的环境变量，再不行就 `(未知)`。
     */
    appVersion: String(snap?.appVersion || process.env.npm_package_version || '(未知)'),
    serverRuntime: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid, instanceId: DIAG_INSTANCE_ID },
    /**
     * 🆕 记录窗口：**本包的取数依据**。
     * `applied: false` 时下面的 `reason` 说明为什么没按窗口过滤
     * （⚠️ 客户端声称了窗口却对不上时**根本走不到这里**：那种情况在本端点前面就以 409 拒掉了）。
     */
    recordWindow: {
      applied: Boolean(win),
      reason: win
        ? win.recording
          ? '窗口仍在记录中（用户在未点「结束记录」时导出的）'
          : '窗口已结束并封存（本次导出用的就是它）'
        : prevInstance
          ? `未按记录窗口过滤：磁盘上的窗口（id ${prevInstance.id}，起于 ${prevInstance.startedAt}）属于上一个实例（instanceId ${prevInstance.instanceId}），本次运行已忽略它 —— 与"关掉本程序再启动就从零开始"的设计一致`
          : '未按记录窗口过滤：本次运行没有点过「开始记录」，且客户端也未声称窗口（老前端）',
      id: win?.id ?? '',
      instanceId: win?.instanceId ?? DIAG_INSTANCE_ID,
      recording: win ? win.recording : null,
      startedAt: win?.startedAt ?? '',
      startedAtMs: win?.startedAtMs ?? 0,
      endedAt: win?.endedAt ?? '',
      endedAtMs: win?.endedAtMs ?? 0,
      /** 导出时这一刻，这次记录已经持续了多久（已结束的窗口 = 实际时长） */
      durationSeconds: win ? sessionElapsedSeconds(win) : 0,
      includeGeometry: win?.includeGeometry ?? null,
      /** 界面快照里自带的窗口（客户端上报）；这里正常情况下与服务端那份**逐字段相同**（否则上面已 409） */
      clientReported: snap?.window
        ? { id: String(snap.window.id ?? ''), startedAt: String(snap.window.startedAt ?? ''), endedAt: String(snap.window.endedAt ?? ''), includeGeometry: Boolean(snap.window.includeGeometry) }
        : null,
      /** ⚠️ 磁盘上有一个**别的实例**的窗口（上一次运行留下的），本次**未采用** */
      ignoredPreviousInstance: prevInstance ? { id: prevInstance.id, instanceId: prevInstance.instanceId, startedAt: prevInstance.startedAt, ignoredAt: prevInstance.at } : null,
    },
    /** 服务端日志的收录口径（与界面提示、`utils/mp/diagnostics.ts` 常量一致）。**⚠️ 各计数只统计真正进包的文件** */
    diagnostics: {
      logDays: DIAG_LOG_DAYS,
      logMaxBytesPerFile: DIAG_LOG_MAX_BYTES,
      /** 进包文件数（**不含被红线剔除的文件**，见下面 `lines.excludedLogsLines`） */
      logFiles: account.files,
      /**
       * ⚠️ 两个字节数**必须分开看**（2026-09-22 终检审计 B3）：
       *   · `logBytesInPackage` = 包内 `.log` **实际内容**的字节数（窗口过滤后往往只有几行）；
       *   · `logBytesOriginal` = 这些文件**截断前**的原始大小（说明"这一天本来记了多少"）。
       * 以前只有一个 `logBytes`（值 = 原始大小）⇒ 维护者看到 170 KB 会误以为包里真有 170 KB 日志。
       */
      logBytesInPackage: account.inPackageBytes,
      logBytesOriginal: account.originalBytes,
      logFilesTruncated: account.truncatedFiles,
      /** 读到的候选文件数 / 字节数（含被剔除的），便于对照"为什么进包数更少、包里为什么更小" */
      logFilesRead: logFiles.length,
      logBytesRead: logFiles.reduce((s, f) => s + f.bytes, 0),
      /** 🆕 按窗口过滤后的行数账（`filteredByWindow=false` 时 kept 就是全部非空行） */
      lines: {
        filteredByWindow: Boolean(win),
        kept: account.keptLines,
        droppedOutOfWindow: account.droppedLines,
        droppedUnparsable: account.unparsableLines,
        /** 因命中凭证样式**没进包**的那些文件本来会贡献多少行（不并入上面的 kept） */
        excludedLogsFiles: account.excluded.files,
        excludedLogsLines: account.excluded.lines,
      },
    },
    /** 客户端快照自己的时间/版本（与上面的导出时刻区分开） */
    snapshot: {
      collectedAt: snap?.collectedAt ?? '',
      collectedAtMs: snap?.collectedAtMs ?? null,
      appVersion: snap?.appVersion ?? '',
      route: snap?.route ?? '',
      userAgent: snap?.userAgent ?? '',
      includeGeometry,
      /**
       * 🆕 2026-09-22：**任务本体取自哪里**（`memory(useMpReal.task)` / `cache.task` / `cache.data…` / `none`）。
       * 真实用户那次"任务里 0 条线路"的误判，根因就是快照读到了**响应信封**而不是任务本体 ——
       * 有了这一行，维护者看 manifest 就能定位"这份快照的任务是从哪一层取的"。
       */
      taskSource: typeof snap?.task?.source === 'string' ? snap.task.source : '',
      /** 进包快照里任务摘要与线路的条数（与 `taskSource` 对照，一眼看出三者是否自洽） */
      taskSummary: snap?.task?.present
        ? {
            runPointListCount: snap?.task?.summary?.runPointListCount ?? 0,
            linesCount: Array.isArray(snap?.task?.lines) ? snap.task.lines.length : 0,
            shapeLine: String(snap?.task?.summary?.shapeLine ?? ''),
          }
        : null,
      /**
       * 🆕 2026-09-22（用户原话："你刚刚说刷新后就丢了，我们直接丢之前记录下来不行吗"）：
       * **最近一次成功读取时的状态**（含开关原值 / 摄像头杆 flag / 当时的门禁终值）。
       *
       * 🔴 口径必须写在 manifest 里（维护者与用户都要看到）：
       *    **这是历史证据，不参与任何放行判断**；真实提交前必须重新读取（开关可能已变）。
       * `note` 由客户端给出的 `lastKnownSummary` 口径改写，服务端只补"读取时刻"与这句边界。
       */
      lastKnown: snap?.lastKnown
        ? {
            at: String(snap.lastKnown.at ?? ''),
            atMs: Number(snap.lastKnown.atMs ?? 0),
            status: String(snap.lastKnown.status ?? ''),
            switchesFound: Boolean(snap.lastKnown.switches),
            switches: snap.lastKnown.switches ?? null,
            cameraFlag: snap.lastKnown.cameraFlag ?? null,
            cameraFlagLineId: String(snap.lastKnown.cameraFlagLineId ?? ''),
            taskShape: String(snap.lastKnown.task?.shapeLine ?? ''),
            runPointListCount: Number(snap.lastKnown.task?.runPointListCount ?? 0),
            gateAllow: Boolean(snap.lastKnown.gateAllow),
            gateBlockedBy: String(snap.lastKnown.gateBlockedBy ?? ''),
            note:
              '这是最近一次成功读取时的状态（含开跑开关原值 / 摄像头杆 flag / 当时的门禁终值），' +
              '不参与任何放行判断；真实提交前必须重新读取（开关可能已变）。',
          }
        : null,
      /** 🆕 事件时间线的账（客户端按窗口过滤 + `DIAG_TIMELINE_MAX` 上限兜底的结果） */
      timeline: {
        max: DIAG_TIMELINE_MAX,
        inPackage: clientTimeline.length,
        clientStats: snap?.timelineStats ?? null,
        /** 服务端用**自己**的窗口口径复算了一遍：数量与客户端包里的对不上就写在这里（不改写证据） */
        serverRecount: win ? timelineCheck.stats : null,
        matched: win ? timelineCheck.items.length === clientTimeline.length : null,
      },
    },
    /** 包内文件清单 + 说明：**由 `diagManifestEntries()` 生成**（界面"导出前预览"用的是同一个函数） */
    files: [
      ...diagManifestEntries({
        logNames: safeLogs.map((f) => f.name),
        includeGeometry,
        logNote: win
          ? `本次只收录记录窗口内的日志行（共保留 ${account.keptLines} 行，剔除窗口外 ${account.droppedLines} 行${account.unparsableLines ? `、无时间戳 ${account.unparsableLines} 行` : ''}）`
          : '未按记录窗口过滤（本次运行没有记录窗口）⇒ 收录最近 ' + DIAG_LOG_DAYS + ' 天的全量日志',
        window: win ? { id: win.id, startedAt: win.startedAt, endedAt: win.endedAt } : null,
      }).map((e) => {
        const extra = logEntries.find((l) => l.name === e.name)
        return { ...e, note: extra ? extra.note : e.note }
      }),
      // 清单里如实写明"少了什么、为什么少"，否则维护者会以为日志本来就这么多
      ...(excludedScoped.length
        ? [{
            name: '(已排除)',
            note:
              `有 ${excludedScoped.length} 个日志文件因命中凭证样式被自动排除（${excludedScoped.map((x) => x.file.name).join('、')}）：` +
              `它们本来会贡献约 ${account.excluded.lines} 行，已从 manifest 的各项计数里排除（账只算真正进包的文件）。` +
              '这通常是日志掩码没盖住某种凭证样式，请把这条提示一并告知开发者（不影响本包其它内容）。',
          }]
        : []),
    ],
    /** 明确写出来：本包不含凭证明文（红线自检在打包前已经跑过） */
    privacy: {
      credentialsChecked: true,
      /** 因命中凭证样式被自动排除的日志文件名（空数组=没有排除） */
      redlineExcludedLogs: excludedScoped.map((x) => x.file.name),
      note: 'token 明文、学号/姓名原文均不在包内（客户端已脱敏；服务端日志由 logger 按字段名与样式掩码）',
    },
  }
  const manifestJson = JSON.stringify(manifest, null, 2)
  /** 红线再跑一次：**只查 manifest**（日志已逐个查过；这里防的是"manifest 自己把凭证写进去"） */
  const manifestRedline = assertNoCredentials([manifestJson])
  if (!manifestRedline.ok) {
    logWarn('ui', '诊断导出被红线拦下（清单命中凭证样式）', { reasons: manifestRedline.hits })
    throw createError({
      statusCode: 500,
      statusMessage:
        `拒绝导出：清单命中凭证红线（${manifestRedline.hits.join('、')}）—— 这是本程序自身的脱敏缺陷，请把这个提示截图发给开发者。`,
    })
  }

  // ---------- ⑥ 打包（内存里拼，不落盘）----------
  const zip = createZip([
    { name: DIAG_MANIFEST_NAME, data: Buffer.from(manifestJson, 'utf8') },
    { name: DIAG_SNAPSHOT_NAME, data: Buffer.from(snapshotJson, 'utf8') },
    ...safeLogs.map((f) => ({ name: `${DIAG_LOG_DIR}/${f.name}`, data: Buffer.from(f.text, 'utf8') })),
  ])

  const filename = `totoro-diagnostics-${compactStamp(now)}.zip`
  logInfo('ui', '导出诊断包', {
    files: 2 + safeLogs.length,
    logFiles: safeLogs.length,
    logFilesExcluded: excludedLogs.length,
    logFilesTruncated: account.truncatedFiles,
    windowId: windowIdOrNone(effectiveWindowId),
    windowApplied: Boolean(win),
    windowLinesKept: account.keptLines,
    windowLinesDropped: account.droppedLines,
    bytes: zip.byteLength,
  })

  setResponseHeaders(event, {
    'Content-Type': 'application/zip',
    // 文件名是纯 ASCII；再加一个标准写法（RFC 5987）的 filename*，中文/空格浏览器也能正确落名
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': String(zip.byteLength),
    // 诊断包含本机状态，绝不允许任何中间层缓存
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    /**
     * 🆕 2026-09-22：把"本包实际依据的窗口"回给界面（`X-Diag-Window`）与"有没有按窗口过滤"（`X-Diag-Window-Applied`）。
     * 非 ASCII 的头值会被 Node 拒绝，所以窗口 id 里的连字符照原样（纯 ASCII，安全）。
     */
    'X-Diag-Window': effectiveWindowId || 'none',
    'X-Diag-Window-Applied': win ? '1' : '0',
    'Access-Control-Expose-Headers': 'Content-Disposition, X-Diag-Window, X-Diag-Window-Applied',
  })
  return send(event, zip)
})

/** 日志里写"窗口 id"时统一口径（没有就写 `(无)`，避免出现空串让人误以为是漏打） */
function windowIdOrNone(id: string): string {
  return id || '(无)'
}
