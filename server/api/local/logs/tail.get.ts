/**
 * `GET /api/local/logs/tail?lines=200` —— 读服务端日志尾部（仅本机）
 * 返回：目录路径、文件清单与总量、以及最近 N 行文本。
 */
import { assertLocalRequest } from '../../../utils/tokenScanState'
import { logDirInfo, tailLog } from '../../../utils/logger'

export default defineEventHandler((event) => {
  assertLocalRequest(event)
  const q = getQuery(event)
  const lines = Math.min(1000, Math.max(20, Number(q?.lines) || 200))
  const tail = tailLog(lines)
  return { ok: true, dir: tail.dir, lines: tail.lines, info: logDirInfo() }
})
