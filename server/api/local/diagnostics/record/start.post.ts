/**
 * `POST /api/local/diagnostics/record/start` —— 开始一次诊断记录（2026-09-22 新增）
 *
 * 请求体（可选）：`{ includeGeometry?: boolean }` —— 坐标开关**随窗口一起保存**（默认 `true`）。
 * 记录中改开关走 `PATCH /api/local/diagnostics/record/geometry`（见那边）。
 *
 * 响应：`{ ok: true, session: <窗口> , serverInstance }`。
 *
 * 语义要点：窗口落在**服务端**（写入运行目录 `diagnostics/session.json` 作为同实例内的持久化依据），
 * 且带**本进程实例标识** ⇒ 之后刷新页面 / 切页 / 关掉浏览器再打开，只要这个 EXE 还在跑就一直在记录；
 * 关掉程序再启动则是全新实例，本接口**不会**续用旧窗口（用户要求"生命周期基于我们运行的 exe"）。
 */
import { assertLocalRequest } from '../../../../utils/tokenScanState'
import { DIAG_INSTANCE_ID, DIAG_INSTANCE_STARTED_MS, readIncludeGeometryFlag, startSession } from '../../../../utils/diagSession'
import { logInfo } from '../../../../utils/logger'

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)
  const body = await readBody(event).catch(() => ({}))
  /**
   * 坐标开关判据与 `PATCH /record/geometry` **共用同一个纯函数**（`readIncludeGeometryFlag()`，有单测）。
   * 差别在"缺字段"怎么处置，这是**有意**的：
   *   · 这里（**新建**窗口）缺字段 = 用户没表达意见 ⇒ 用默认"包含坐标"（老前端不带这个字段也能用）；
   *   · 那里（**改**一个已存在的隐私开关）缺字段无法判断意图 ⇒ 必须 400，不许 fail-open。
   * 两边共同点：`"false"`（字符串）/ `0` 之类的写法**都不算"关闭坐标"** —— 这里直接 400 拒掉，不猜。
   */
  const flag = readIncludeGeometryFlag(body)
  if (flag.kind === 'invalid') {
    throw createError({
      statusCode: 400,
      statusMessage: `请求体里的 includeGeometry 必须是布尔（收到 ${flag.got}）—— 诊断包的坐标开关不接受别的写法`,
    })
  }
  const includeGeometry = flag.kind === 'ok' ? flag.value : true
  const session = startSession({ includeGeometry })
  logInfo('ui', '开始诊断记录（服务端记录窗口）', { windowId: session.id, instanceId: session.instanceId, includeGeometry })
  return { ok: true, session, serverInstance: { instanceId: DIAG_INSTANCE_ID, startedAtMs: DIAG_INSTANCE_STARTED_MS, pid: process.pid } }
})
