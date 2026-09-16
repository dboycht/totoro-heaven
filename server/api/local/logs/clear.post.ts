/**
 * `POST /api/local/logs/clear` —— 手动清理服务端日志（仅本机）
 *
 * body: `{ mode: 'today' | 'all' }`（默认 today）
 * 返回：删除了哪些文件、释放多少字节、剩余文件清单。
 * ⚠️ 清理动作本身会被写进新日志（便于追溯"谁什么时候清过"）。
 */
import { assertLocalRequest } from '../../../utils/tokenScanState'
import { clearLogs, logDirInfo, logInfo } from '../../../utils/logger'
import type { ClearLogMode } from '../../../utils/logger'

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)
  const body = (await readBody(event).catch(() => ({}))) as { mode?: ClearLogMode }
  const mode: ClearLogMode = body?.mode === 'all' ? 'all' : 'today'
  const res = clearLogs(mode)
  logInfo('ui', mode === 'all' ? '手动清空全部服务端日志' : '手动清空今日服务端日志', {
    deleted: res.deleted,
    freedBytes: res.freedBytes,
  })
  return { ok: true, mode, deleted: res.deleted, freedBytes: res.freedBytes, dir: res.dir, info: logDirInfo() }
})
