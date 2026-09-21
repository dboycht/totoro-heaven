/**
 * `POST /api/local/diagnostics/export` —— 「一键诊断导出」的服务端一半（2026-09-21 新增）
 *
 * ## 干什么
 * 收客户端**已脱敏**的 `DiagSnapshot`（`utils/mp/diagnostics.ts` 的契约），
 * 加上**服务端自己去读**的最近 `DIAG_LOG_DAYS` 天日志，打成**一个 zip** 回给浏览器下载：
 *
 * ```
 * manifest.json      本次导出的清单与元信息（含"日志被截断"这类说明）
 * snapshot.json      客户端快照（原样写入，不再加工）
 * logs/app-<日期>.log 服务端文件日志（每文件 ≤ DIAG_LOG_MAX_BYTES，超出截断）
 * ```
 *
 * ## 三条硬约束
 * 1. **日志由服务端读**（`server/utils/diagLogs.ts`，目录口径与 `logger.ts` 同一来源）——
 *    不经过浏览器，用户不必去找 `%TEMP%` 目录，token 也不可能因此流到前端。
 * 2. 🔴 **红线自检**：`snapshot.json` / `manifest.json` / **每个日志**都过 `assertNoCredentials()`；
 *    只要有命中就 **500 拒绝导出**，并回**命中了哪一类**（`Bearer 凭证` / `JWT 样式串` / …）。
 *    ⚠️ 错误信息里**只放类别名，绝不放命中到的原文** —— 否则拒绝导出的理由本身会带着凭证去落日志。
 * 3. **全程只读**：不建目录、不写任何文件；zip 在内存里拼（日志 ≤3×8MB，量级可控）。
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
 *   （例如把上游原话整段塞进 msg）—— 此时宁可让导出失败，也不能把凭证发出去。
 */
import { DIAG_EXPORT_PATH, DIAG_LOG_DAYS, DIAG_LOG_MAX_BYTES, DIAG_LOG_DIR, DIAG_MANIFEST_NAME, DIAG_SNAPSHOT_NAME, assertNoCredentials, diagManifestEntries } from '../../../../utils/mp/diagnostics'
import type { DiagSnapshot } from '../../../../utils/mp/diagnostics'
import { assertLocalRequest } from '../../../utils/tokenScanState'
import { partitionLogsByRedline, recentLogFiles } from '../../../utils/diagLogs'
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

  // ---------- ② 服务端自己读日志（只读；目录不存在就是"没有日志"）----------
  const now = new Date()
  const logFiles = recentLogFiles(DIAG_LOG_DAYS, DIAG_LOG_MAX_BYTES)
  const logEntries = logFiles.map((f) => ({
    name: `${DIAG_LOG_DIR}/${f.name}`,
    note: f.truncated
      ? `服务端文件日志：超过单文件上限 ${DIAG_LOG_MAX_BYTES} 字节，**已截断**（只保留文件头 ${DIAG_LOG_MAX_BYTES} 字节，原始 ${f.bytes} 字节）`
      : `服务端文件日志（${f.bytes} 字节）：每个上游请求一行（端点/耗时/上游原话/字段名，token 已掩码）`,
  }))

  // ---------- ③ 生成 manifest.json / snapshot.json ----------
  const snapshotJson = JSON.stringify(snapshot, null, 2)
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
    serverRuntime: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid },
    /** 服务端日志的收录口径（与界面提示、`utils/mp/diagnostics.ts` 常量一致） */
    diagnostics: {
      logDays: DIAG_LOG_DAYS,
      logMaxBytesPerFile: DIAG_LOG_MAX_BYTES,
      logFiles: logFiles.length,
      logBytes: logFiles.reduce((s, f) => s + f.bytes, 0),
      logFilesTruncated: logFiles.filter((f) => f.truncated).length,
    },
    /** 客户端快照自己的时间/版本（与上面的导出时刻区分开） */
    snapshot: {
      collectedAt: snap?.collectedAt ?? '',
      collectedAtMs: snap?.collectedAtMs ?? null,
      appVersion: snap?.appVersion ?? '',
      route: snap?.route ?? '',
      userAgent: snap?.userAgent ?? '',
      includeGeometry: Boolean(snap?.trackLibrary?.includeGeometry),
    },
    /** 包内文件清单 + 说明：**由 `diagManifestEntries()` 生成**（界面"导出前预览"用的是同一个函数） */
    files: diagManifestEntries({ logNames: logFiles.map((f) => f.name), includeGeometry: Boolean(snap?.trackLibrary?.includeGeometry) }).map((e) => {
      const extra = logEntries.find((l) => l.name === e.name)
      return { ...e, note: extra ? extra.note : e.note }
    }),
    /** 明确写出来：本包不含凭证明文（红线自检在打包前已经跑过） */
    privacy: {
      credentialsChecked: true,
      /** 因命中凭证样式被自动排除的日志文件名（空数组=没有排除） */
      redlineExcludedLogs: [] as string[],
      note: 'token 明文、学号/姓名原文均不在包内（客户端已脱敏；服务端日志由 logger 按字段名与样式掩码）',
    },
  }
  let manifestJson = JSON.stringify(manifest, null, 2)

  // ---------- ④ 🔴 红线自检（**降级而非整包拒绝**，2026-09-21 父代理定）----------
  /**
   * 判据分两类，处置不同 —— 目标既是"**绝不泄漏凭证**"，也要"**别让用户什么都导不出**"（用户原话：能带什么就带什么）：
   *  · `snapshot.json` / `manifest.json`（本程序自己生成的）命中 ⇒ **硬拒**：那是客户端的 bug，不该发生，必须暴露；
   *  · **日志文件**命中 ⇒ **只排除那一个文件**，其余照出，并在清单里写明"被排除"。
   *    （日志里的形似凭证通常来自 logger 掩码没盖住的样式；排除掉即不泄漏，而快照那半边对排障往往更关键。）
   */
  const coreRedline = assertNoCredentials([snapshotJson, manifestJson])
  if (!coreRedline.ok) {
    logWarn('ui', '诊断导出被红线拦下（快照/清单命中凭证样式）', { reasons: coreRedline.hits })
    throw createError({
      statusCode: 500,
      statusMessage:
        `拒绝导出：快照或清单命中凭证红线（${coreRedline.hits.join('、')}）—— 这是本程序自身的脱敏缺陷，请把这个提示截图发给开发者。` +
        '同时建议先把该凭证失效（重新登录）。',
    })
  }
  /** 逐个日志过红线，命中的剔除（不进包）—— 判据是纯函数 `partitionLogsByRedline`（有单测） */
  const { safe: safeLogs, excluded: excludedLogs, reasons: excludedReasons } = partitionLogsByRedline(logFiles)
  for (const [name, hits] of Object.entries(excludedReasons)) {
    logWarn('ui', '诊断导出已排除一个日志文件（命中凭证样式）', { name, reasons: hits })
  }
  if (excludedLogs.length) {
    // 清单里如实写明"少了什么、为什么少"，否则维护者会以为日志本来就这么多
    manifest.files = manifest.files.filter((e: { name: string }) => !excludedLogs.some((x) => `${DIAG_LOG_DIR}/${x.name}` === e.name))
    manifest.files.push({
      name: '(已排除)',
      note:
        `有 ${excludedLogs.length} 个日志文件因**命中凭证样式**被自动排除（${excludedLogs.map((x) => x.name).join('、')}）：` +
        '这通常是日志掩码没盖住某种凭证样式，请把这条提示一并告知开发者（不影响本包其它内容）。',
    })
    manifest.privacy.redlineExcludedLogs = excludedLogs.map((x) => x.name)
    manifestJson = JSON.stringify(manifest, null, 2)
  }

  // ---------- ⑤ 打包（内存里拼，不落盘）----------
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
    logFilesTruncated: safeLogs.filter((f) => f.truncated).length,
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
  })
  return send(event, zip)
})
