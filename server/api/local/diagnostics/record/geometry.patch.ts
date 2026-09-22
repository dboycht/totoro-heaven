/**
 * `PATCH /api/local/diagnostics/record/geometry` —— 记录中修改坐标开关（2026-09-22 新增）
 *
 * 请求体：`{ includeGeometry: boolean }` ⇒ 改服务端窗口里那一个开关（**只改它**，不动时间戳）。
 *
 * 为什么要能改（用户要求"允许在记录中修改"）：坐标开关按现在的实现**只影响导出那一刻的采集**
 * （快照里那一份 `trackLibrary.entries[].geometry` / 任务原文的坐标剥离），
 * 所以"记录中途改主意"完全可行 —— 但它同时**随窗口一起保存**，这样即使中途刷新页面，
 * 界面也能从服务端读回用户最后的选择（否则刷新后开关会悄悄回到默认值，导出内容与用户预期不符）。
 *
 * 响应：`{ ok: true, session }`；没有窗口 ⇒ `{ ok: false, session: null }`（HTTP 200，界面据此提示先开始记录）。
 *
 * 🔴 2026-09-22（审计 B6 修）：**必须是显式布尔**，否则 400 —— 不许 fail-open。
 * 原实现写的是 `body?.includeGeometry !== false`，于是空体 `{}`、`{"includeGeometry":0}`、
 * 甚至 `"false"`（字符串）都会被判成 `true` ⇒ **隐私开关被无声地打开**。
 * 诊断包里"要不要带坐标"正是用户唯一能控制的隐私取舍，这种地方宁可报错也不能替用户做宽松解释。
 */
import { assertLocalRequest } from '../../../../utils/tokenScanState'
import { patchSessionIncludeGeometry, readIncludeGeometryFlag } from '../../../../utils/diagSession'
import { logInfo, logWarn } from '../../../../utils/logger'

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)
  const body = await readBody(event).catch(() => ({}))
  /**
   * 只接受**真正的布尔**（`typeof === 'boolean'`）：空体 / 字符串 `"false"` / 数字 `0` 一律 400。
   * 判据是契约层的纯函数 `readIncludeGeometryFlag()`（与 `start` 共用，有单测）。
   */
  const flag = readIncludeGeometryFlag(body)
  if (flag.kind !== 'ok') {
    logWarn('ui', '诊断记录：坐标开关请求体不合法，已拒绝（不替用户改成"包含坐标"）', {
      kind: flag.kind,
      got: flag.kind === 'invalid' ? flag.got : '(缺失)',
    })
    throw createError({
      statusCode: 400,
      statusMessage:
        '请求体必须是 { includeGeometry: true | false }（显式布尔）—— 诊断包的坐标开关不接受其它写法，' +
        '否则会被误当成"包含坐标"（那是隐私开关，宁可不改也不许猜）。',
    })
  }
  const session = patchSessionIncludeGeometry(flag.value)
  if (!session) {
    // 没有窗口：不是错误，只是"这次运行还没开始记录"——回 ok:false 让界面提示，而不是 4xx 刷红
    return { ok: false, session: null, reason: '本次运行还没有记录窗口（请先点「开始记录」）' }
  }
  logInfo('ui', '诊断记录：记录中修改坐标开关', { windowId: session.id, includeGeometry: flag.value, recording: session.recording })
  return { ok: true, session }
})
