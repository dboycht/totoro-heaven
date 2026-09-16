/**
 * `POST /api/local/logs/open` —— 在资源管理器里打开日志目录（仅本机）
 *
 * 为什么需要它：日志写在 `%TEMP%\totoro-heaven-runtime\logs\`，用户很难自己找到；
 * 这个端点在**本机**调用系统 `explorer` 打开该目录（不安全输入：路径由服务端拼，不由调用方给）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { assertLocalRequest } from '../../../utils/tokenScanState'
import { LOG_DIR, logInfo } from '../../../utils/logger'

export default defineEventHandler((event) => {
  assertLocalRequest(event)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    spawn('explorer.exe', [LOG_DIR], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    logInfo('ui', '打开日志文件夹', { dir: LOG_DIR })
    return { ok: true, dir: LOG_DIR }
  } catch (err) {
    return { ok: false, dir: LOG_DIR, message: err instanceof Error ? err.message : '打开失败' }
  }
})
