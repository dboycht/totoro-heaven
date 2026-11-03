/**
 * `POST /api/local/real-path/share` —— 把「真实路径」分享包打成 **zip** 返回（仅本机）
 *
 * ## 为什么 zip 在服务端打（而不是浏览器）
 * 项目里已有一个**零依赖、被单测钉住**的 zip 写入器（`server/utils/zip.ts`，store 模式），
 * 但它用的是 Node 的 `Buffer` —— 浏览器里没有 `Buffer`。与其在浏览器再写一份/把写入器重构成
 * `Uint8Array`（会动到「诊断导出」那条已发布链路），不如**在服务端打、把字节流回去**：
 *   · 浏览器只做 `res.blob()` + `<a download>`，零依赖、零第三方库；
 *   · 写入器仍是同一份实现（一处口径）。
 *
 * ## 入参 / 出参
 * · body：`{ fileName?: string, json: string }` —— `json` 是**已经序列化好的分享包**
 *   （由纯模块 `utils/mp/realPath.ts` 的 `buildShareBundle()` 生成，白名单字段在那边收口）；
 * · 响应：`application/zip` 字节流；`X-Totoro-File` 头回带最终文件名（界面拿来当下载名）。
 *
 * ## 安全
 * · `assertLocalRequest(event)`：只接受**本机**请求（loopback + nonce，与其他本机端点同口径）；
 * · 文件名**由服务端清洗**（去路径分隔符/控制字符、限长），绝不把调用方给的字符串直接当路径用；
 * · **不落盘**（只回字节流），所以不存在"用户点一下就在磁盘某处留个包"的隐私问题。
 */
import { assertLocalRequest } from '../../../utils/tokenScanState'
import { createZip } from '../../../utils/zip'
import { REAL_PATH_BUNDLE_FILE } from '../../../../utils/mp/realPath'

/** 单个请求体上限（路径包再大也只有几十 KB；给到 4 MB 足够，防被塞大包打爆内存） */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** 包内 JSON 条目名：固定名（与 `REAL_PATH_BUNDLE_FILE` 同一口径，便于人肉排查） */
const ENTRY_NAME = REAL_PATH_BUNDLE_FILE

/** 下载文件名清洗（去路径分隔符 / 控制字符 / 保留中文；限长 80 码点） */
function safeFileName(raw: unknown): string {
  const s = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const base = Array.from(s || '真实路径分享').slice(0, 80).join('')
  return /\.zip$/i.test(base) ? base : `${base}.zip`
}

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)
  const body = (await readBody(event)) as { fileName?: unknown; json?: unknown } | null
  const json = typeof body?.json === 'string' ? body.json : ''
  if (!json) {
    setResponseStatus(event, 400)
    return { ok: false, message: '缺少 json（分享包内容）' }
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_BODY_BYTES) {
    setResponseStatus(event, 413)
    return { ok: false, message: `分享包过大（> ${Math.round(MAX_BODY_BYTES / 1024)} KB）` }
  }
  let zip: Buffer
  try {
    zip = createZip([{ name: ENTRY_NAME, data: Buffer.from(json, 'utf8') }])
  } catch (err) {
    setResponseStatus(event, 500)
    return { ok: false, message: err instanceof Error ? err.message : '打包失败' }
  }
  const fileName = safeFileName(body?.fileName)
  setHeader(event, 'content-type', 'application/zip')
  setHeader(event, 'content-length', zip.length)
  /** 文件名走**自定义头**（中文不能直接塞进 `content-disposition` 的 filename，得用 RFC 5987 编码；
   *  而我们的下载其实是前端 `<a download>` 触发的，所以头只用于"告诉前端该叫什么"）。 */
  setHeader(event, 'x-totoro-file', encodeURIComponent(fileName))
  return zip
})
