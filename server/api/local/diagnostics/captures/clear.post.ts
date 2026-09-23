/**
 * `POST /api/local/diagnostics/captures/clear` —— 清空**响应原文留档**（captures），仅本机（2026-09-23 新增）
 *
 * ## 为什么要它（用户要求 3️⃣）
 * captures 里是**每个请求的完整响应原文**（已脱敏，但仍是"响应内容"）—— 换账号后它属于**上一个账号的证据**。
 * 所以「退出登录」与「清空本机数据」都必须把它清掉，与 `clearLastKnown()`（localStorage 那份）**同等对待**。
 *
 * ## 口径
 * - 与 `/api/local/**` 其余端点一致：`assertLocalRequest(event)`（只允许本机回环来源）；
 * - **无参数**（不接受任何字段 ⇒ 没有"只清一部分"的复杂语义，也就没有可被滥用的入参）；
 * - 返回 `{ ok, files, dir }`（删了几份、目录在哪儿），供界面/日志记账；
 * - 调用方（composable）**失败不得影响退出/清空本身** —— 本端点是"尽力而为"的一步。
 */
import { assertLocalRequest } from '../../../../utils/tokenScanState'
import { clearCaptures } from '../../../../utils/captureStore'
import { logInfo } from '../../../../utils/logger'

export default defineEventHandler((event) => {
  assertLocalRequest(event)
  const res = clearCaptures()
  logInfo('ui', '已清空响应原文留档（captures）', { files: res.files, dir: res.dir })
  return { ok: true, files: res.files, dir: res.dir }
})
