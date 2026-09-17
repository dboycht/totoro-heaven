/**
 * 日志「token 绝不落盘」端到端契约测试（2026-09-17 补 —— 健壮化 A「安全网」）
 *
 * 硬规则（`_mp-analyze/README.md` 隐私红线 + `HANDOVER.md` §7）：**token / 学号 / 姓名不打印、不入库、不进日志**。
 *
 * 在加这个文件之前，只有**脱敏原语**（`maskTokenLike` / `redactObject`）有单测，
 * 而"**写进文件的每一行确实不含原文**"这件事没人验过 —— 于是漏了一个真窟窿：
 * `logEvent()` 只对 `data` 脱敏，**`msg` 原样落盘**（本轮已修）。
 *
 * 手法：用 `TOTORO_LOG_DIR` 把日志目录指到临时目录（模块加载前设置），
 * 然后**读回文件内容**断言，而不是只断言函数返回值。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 形如真实 token（`WXXCX` + base64，≥40 字符）—— 脱敏正则就是这个形态 */
const FAKE_TOKEN = 'WXXCX' + 'Ab3+/='.repeat(18)

const sandbox = join(tmpdir(), `totoro-log-test-${process.pid}-${Date.now()}`)
process.env.TOTORO_LOG_DIR = sandbox

// ⚠️ 必须在设置环境变量**之后**动态 import：LOG_DIR 是模块加载时求值的常量
const logger = await import('../../server/utils/logger.ts')

after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
})

test('日志：调用方把 token 拼进 msg 也必须被掩码（原先的窟窿）', () => {
  logger.logInfo('test', `一键取 token 成功：${FAKE_TOKEN}`)
  const content = readFileSync(logger.logFilePath(), 'utf8')
  assert.ok(!content.includes(FAKE_TOKEN), 'msg 里的 token 原文落盘了')
  assert.match(content, /\[token len=\d+\]/, '应留下长度标记而不是原文')
})

test('日志：data 里的 token / 学号 / 姓名被按字段名掩码，普通字段保留', () => {
  logger.logWarn('test', '带敏感字段的事件', {
    token: FAKE_TOKEN,
    snCode: '2021001234',
    studentName: '张三',
    ok: 1,
    lineId: 'line-1',
  })
  const content = readFileSync(logger.logFilePath(), 'utf8')
  assert.ok(!content.includes(FAKE_TOKEN), 'token 原文落盘了')
  assert.ok(!content.includes('2021001234'), '学号原文落盘了')
  assert.ok(!content.includes('张三'), '姓名原文落盘了')
  assert.match(content, /\[masked len=\d+\]/, '敏感字段应替换为长度标记')
  assert.match(content, /"lineId":"line-1"/, '普通字段必须原样保留（否则日志没用）')
  assert.match(content, /"ok":1/, '普通字段必须原样保留')
})

test('日志：形似 token 的字符串出现在任意普通字段值里也会被掩（不靠字段名）', () => {
  logger.logError('test', '普通字段里塞了 token', { note: `raw=${FAKE_TOKEN}`, upstream: 'wxxcx.xtotoro.com' })
  const content = readFileSync(logger.logFilePath(), 'utf8')
  assert.ok(!content.includes(FAKE_TOKEN), '普通字段里的 token 原文落盘了')
  assert.match(content, /wxxcx\.xtotoro\.com/, '域名这类非敏感信息应保留')
})

test('日志：每行都是合法 JSON，且日志目录可用 TOTORO_LOG_DIR 覆盖（测试沙箱）', () => {
  const file = logger.logFilePath()
  assert.ok(existsSync(file), '日志文件应已创建')
  assert.ok(file.startsWith(sandbox), `日志目录未被覆盖：${file}`)
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.ok(lines.length >= 3)
  for (const line of lines) {
    const entry = JSON.parse(line) as { level: string; cat: string; msg: string }
    assert.ok(['info', 'warn', 'error'].includes(entry.level))
    assert.equal(entry.cat, 'test')
    assert.equal(typeof entry.msg, 'string')
  }
})
