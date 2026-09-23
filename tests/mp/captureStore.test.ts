/**
 * 「响应原文留档」（captures）的单测 —— 2026-09-23 新增
 *
 * 覆盖用户要求的关键点：
 *   · 文件名**可读可排序**、纯函数解析往返（含 UTC 环境）；
 *   · **预算淘汰 + 记账**（超预算 ⇒ 淘汰最旧的、当天不删、台账累计，且"淘汰不静默"）；
 *   · **脱敏仍然生效**（token 任何形态 / 学号 / 姓名 / 手机 / 动态键名 / 自述人名都不得落盘）；
 *   · **非 JSON 也留全文**（不裁）；
 *   · **大响应不被裁**（这是本轮的核心：单份永不截断）。
 *
 * ⚠️ 本文件通过 `TOTORO_CAPTURE_DIR` 把留档目录指到临时目录（`server/utils/captureStore.ts` 在**模块加载时**读它），
 * 所以环境变量必须在**动态 import 之前**设好 —— 这也是为什么本文件用 `await import()` 而不是顶部静态 import。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 每个用例一个独立目录（避免互相干扰；`captureStore` 的常量在 import 时绑定，故整文件共用一个） */
const SANDBOX = mkdtempSync(join(tmpdir(), 'totoro-capture-test-'))
process.env.TOTORO_CAPTURE_DIR = join(SANDBOX, 'captures')
process.env.TOTORO_CAPTURE_MAX_BYTES = String(2 * 1024 * 1024) // 2 MB，便于造"超预算"

const store = await import('../../server/utils/captureStore.ts')
const { captureEndpointSlug, captureFileName, parseCaptureName, captureStampToMs, captureStampToIso } =
  await import('../../utils/mp/diagnostics.ts')
const { summarizeResponseBody, RESP_BODY_MAX_BYTES } = await import('../../utils/mp/responseRecord.ts')

const listCaptureFiles = (): string[] => {
  try {
    return readdirSync(store.CAPTURE_DIR).filter((n) => /\.(json|txt)$/.test(n) && !n.endsWith('.meta.json')).sort()
  } catch {
    return []
  }
}

test('captures：文件名可读可排序、纯函数解析往返（UTC 也一样）', () => {
  const at = new Date(2026, 8, 23, 14, 5, 6, 78) // 本地 2026-09-23 14:05:06.078
  const name = captureFileName({ at, seq: 7, endpoint: '/wxxcx/sunrun/getSunrunPaper', http: 200, json: true })
  assert.equal(name, '20260923-140506078-0007-wxxcx-sunrun-getSunrunPaper-200.json')
  const parsed = parseCaptureName(name)
  assert.deepEqual(parsed, { stamp: '20260923-140506078', seq: 7, endpoint: 'wxxcx-sunrun-getSunrunPaper', http: 200, json: true })
  // 时间戳能回读（用**本地分量**构造，故 UTC 环境下也自洽）
  assert.equal(captureStampToMs('20260923-140506078'), at.getTime())
  assert.equal(captureStampToIso('20260923-140506078'), at.toISOString())
  // 非 JSON ⇒ .txt；序号补零；字典序 = 时间序
  const txt = captureFileName({ at, seq: 8, endpoint: '/x/y', http: 502, json: false })
  assert.match(txt, /^20260923-140506078-0008-x-y-502\.txt$/)
  /**
   * 字典序 = 时间序：**先比时间戳，同一毫秒再比序号**。
   * ⚠️ 别写成"整串字典序"：`…-0001-x-200.json` 与 `…-0008-x-y-502.txt` 在同一毫秒时会先比后面的名字，
   * 那不是我们要的语义（我们只保证"时间戳串有序 + 序号补零"）。
   */
  const stampOf = (n: string) => /^\d{8}-\d{9}/.exec(n)![0]
  const later = captureFileName({ at: new Date(at.getTime() + 1), seq: 1, endpoint: '/x', http: 200, json: true })
  assert.ok(stampOf(later) > stampOf(name), '时间戳部分必须有序（字典序 = 时间序）')
  const sameMsSeq1 = captureFileName({ at, seq: 1, endpoint: '/x', http: 200, json: true })
  const sameMsSeq2 = captureFileName({ at, seq: 2, endpoint: '/x', http: 200, json: true })
  assert.ok(sameMsSeq1 < sameMsSeq2, '同一毫秒内序号决定先后（4 位补零）')
  // 端点名净化：防目录穿越/非法字符
  assert.equal(captureEndpointSlug('../../etc/passwd'), 'etc-passwd')
  assert.equal(captureEndpointSlug('/a/b/c'), 'a-b-c')
  assert.equal(captureEndpointSlug(''), 'root')
  assert.equal(captureEndpointSlug('???'), 'root')
  // 解析坏名字不抛错
  assert.equal(parseCaptureName('random.txt'), null)
  assert.equal(captureStampToMs('nope'), null)
})

test('captures：写一份 ⇒ 正文完整（**不裁**）+ 同名 .meta.json 记账', () => {
  /** 造一份 300 KB 的 JSON（远超日志行那个 32 KB 单条上限） */
  const big = { status: '00', data: { rows: Array.from({ length: 3000 }, (_, i) => ({ id: `r${i}`, text: 'x'.repeat(80) })) } }
  const raw = JSON.stringify(big)
  assert.ok(raw.length > 300 * 1024, `夹具要够大，实际 ${raw.length}`)
  const payload = summarizeResponseBody(raw, big, [], RESP_BODY_MAX_BYTES, '', {
    bodyMaxBytes: store.CAPTURE_MAX_BYTES,
    textWhole: true,
  })
  assert.equal(payload.truncated, false, '原文留档不该裁（夹具本身也不该触发降级）')
  const name = store.writeCapture({ endpoint: '/wxxcx/big', http: 200, ms: 42, originalBytes: raw.length, payload, unpack: 'ok' })
  assert.ok(name, '写留档应当成功')
  const file = join(store.CAPTURE_DIR, name!)
  const onDisk = readFileSync(file, 'utf8')
  /** 🔴 核心：**原文完整**（不做单条裁剪）—— 落盘内容与"脱敏后的完整正文"逐字节一致 */
  assert.equal(onDisk, JSON.stringify(payload.body), '留档正文必须与脱敏后的完整正文逐字节一致（不裁）')
  assert.ok(onDisk.length > 300 * 1024, `留档正文必须 >300KB（实际 ${onDisk.length}）`)
  assert.equal(JSON.parse(onDisk).data.rows.length, 3000, '3000 行数据一条不少')
  /** 元信息与正文**分开**存 */
  const meta = JSON.parse(readFileSync(`${file}.meta.json`, 'utf8')) as Record<string, unknown>
  assert.equal(meta.endpoint, '/wxxcx/big')
  assert.equal(meta.http, 200)
  assert.equal(meta.ms, 42)
  assert.equal(meta.truncated, false, '🔴 正常留档必须报告"未裁剪"')
  assert.equal(meta.bytes, Buffer.byteLength(onDisk, 'utf8'), 'meta.bytes 必须与实际落盘字节一致')
  assert.equal(meta.originalBytes, raw.length)
  assert.equal(meta.fileName, name)
  assert.equal(meta.kind, 'json')
  assert.equal(meta.unpack, 'ok')
})

test('captures：**非 JSON 也留全文**（.txt，不做 512 字符预览裁剪）', () => {
  const html = `<html><body>${'错误页面内容 '.repeat(2000)}</body></html>`
  const payload = summarizeResponseBody(html, undefined, [], undefined, 'text/html', { bodyMaxBytes: store.CAPTURE_MAX_BYTES, textWhole: true })
  assert.equal(payload.kind, 'text')
  assert.equal(payload.truncated, false, '原文留档不该裁非 JSON')
  const name = store.writeCapture({ endpoint: '/wxxcx/oops', http: 502, ms: 9, originalBytes: Buffer.byteLength(html, 'utf8'), payload })
  assert.ok(name && name.endsWith('.txt'), `非 JSON 应当存 .txt：${name}`)
  const onDisk = readFileSync(join(store.CAPTURE_DIR, name!), 'utf8')
  /** 日志行里的预览只有 512 字符；**留档必须是全文** */
  assert.ok(onDisk.length > 10000, `非 JSON 留档应当是全文（实际 ${onDisk.length}）`)
  assert.ok(onDisk.includes('错误页面内容'), '正文要在')
})

test('captures：脱敏仍然生效（token/学号/姓名/手机/动态键名/自述人名都不得原文落盘）', () => {
  const token = `WXXCX${'Ab3kZ9_x-y.'.repeat(6)}`
  const resp = {
    accessToken: token,
    note: `Authorization: Bearer abcdefghijklmnopqrst`,
    msg: '未找到用户 2021101234（张小明，13812345678）',
    '2021101234': { ok: 1 },
    张小明: { ok: 2 },
    list: [2021101234, 13812345678],
  }
  const raw = JSON.stringify(resp)
  const payload = summarizeResponseBody(raw, resp)
  const name = store.writeCapture({ endpoint: '/wxxcx/sensitive', http: 200, ms: 1, originalBytes: raw.length, payload })
  assert.ok(name)
  const text = readFileSync(join(store.CAPTURE_DIR, name!), 'utf8')
  const mustNotAppear = [token, '2021101234', '张小明', '13812345678', 'Bearer abcdefghijklmnopqrst']
  for (const secret of mustNotAppear) {
    assert.ok(!text.includes(secret), `留档里不得出现原文：${secret}（实际 ${text.slice(0, 300)}）`)
  }
  // 掩码痕迹要在（否则看不出"这里原本有东西"）
  assert.match(text, /\[masked len=\d+\]|\[token len=\d+\]/)
})

test('captures：超预算 ⇒ 淘汰**最旧**、当天不删、台账累计（淘汰不静默）', () => {
  /** 先清空目录（前面的用例写了东西），再造 3 份"昨天"的大文件 */
  store.clearCaptures()
  const dir = store.CAPTURE_DIR
  mkdirSync(dir, { recursive: true })
  const mk = (stamp: string, payloadBytes: number): string => {
    const name = `${stamp}-0001-old-endpoint-200.json`
    writeFileSync(join(dir, name), 'x'.repeat(payloadBytes), 'utf8')
    writeFileSync(join(dir, `${name}.meta.json`), '{}', 'utf8')
    /** 把 mtime 设成 2 天前（模拟"旧文件"；淘汰看的是文件名里的日期 + mtime） */
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000
    utimesSync(join(dir, name), old, old)
    return name
  }
  const d = new Date(Date.now() - 2 * 24 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const old1 = mk(`${day}-010000000`, 1200 * 1024)
  const old2 = mk(`${day}-020000000`, 1200 * 1024)
  /** 再来一份**今天**的大文件（不该被删） */
  const todayName = store.writeCapture({
    endpoint: '/wxxcx/today',
    http: 200,
    ms: 1,
    originalBytes: 10,
    payload: { kind: 'text', text: 'y'.repeat(1200 * 1024) },
  })
  assert.ok(todayName, '今天的留档要写成功（它会挤掉旧文件）')

  const remaining = listCaptureFiles()
  assert.ok(remaining.includes(todayName!), '🔒 当天那份**不许**被淘汰')
  assert.ok(!remaining.includes(old1), '最旧的那份应当被淘汰（预算 2MB，两份 1.2MB 装不下）')
  // 台账必须记账（份数/字节/名字）
  const ledger = store.readEvictedLedger()
  assert.ok(ledger.files >= 1, `台账要记淘汰份数，实际 ${ledger.files}`)
  assert.ok(ledger.bytes > 0, '台账要记淘汰字节')
  assert.ok(ledger.names.some((n) => n === old1 || n === old2), `台账要列被淘汰的文件名：${JSON.stringify(ledger.names)}`)
  assert.ok(ledger.lastAt, '台账要记最后一次淘汰时间')
  /** 预算与占用都要能报出来（manifest 用） */
  assert.equal(store.CAPTURE_MAX_BYTES, 2 * 1024 * 1024, '环境变量覆盖的预算要生效')
  assert.ok(store.captureDirBytes() > 0, '目录占用要能算出来')
})

test('captures：窗口过滤（最近 N 天）+ 窗口内逐份可读', () => {
  const items = store.recentCaptures(3)
  assert.ok(items.length >= 1, `应当至少读到今天那份，实际 ${items.length}`)
  for (const it of items) {
    assert.ok(/^\d{8}-\d{9}-/.test(it.name), `窗口内的名字要合法：${it.name}`)
    assert.ok(it.text.length > 0, '正文要读得到')
  }
  /** 窗口 0 天 ⇒ 什么都不给（防呆） */
  assert.deepEqual(store.recentCaptures(0), [])
})

test('captures：clearCaptures 清空目录（含台账）', () => {
  const before = listCaptureFiles().length
  assert.ok(before >= 1, '清空前应当有东西')
  const res = store.clearCaptures()
  assert.equal(res.files, before, '报告的删除份数要与实际一致')
  assert.deepEqual(listCaptureFiles(), [], '清空后目录里没有正文文件了')
  assert.equal(store.readEvictedLedger().files, 0, '台账也一起清（"清空"了就不该再报曾经淘汰过）')
})

test.after(() => {
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
  assert.ok(!existsSync(SANDBOX) || true)
})
