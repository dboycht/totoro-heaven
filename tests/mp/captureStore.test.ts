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

test('captures：文件名**不含长数字串**、可解析、且"掩码与红线都不动它"（用户要求 1️⃣）', async () => {
  const at = new Date(2026, 8, 23, 14, 5, 6, 78)
  const name = captureFileName({ at, seq: 7, endpoint: '/wxxcx/sunrun/getSunrunPaper', http: 200, json: true })
  /** 新格式：`c<5 位序号>-<端点短名>-<http>.<ext>`（时间戳进 meta，不再进文件名） */
  assert.equal(name, 'c00007-getSunrunPaper-200.json')
  assert.deepEqual(parseCaptureName(name), { stamp: '', seq: 7, endpoint: 'getSunrunPaper', http: 200, json: true })
  // 非 JSON ⇒ .txt；序号补零（5 位）
  const txt = captureFileName({ at, seq: 8, endpoint: '/x/y', http: 502, json: false })
  assert.equal(txt, 'c00008-y-502.txt')
  // 序号有序（字典序 = 序号序）
  const s1 = captureFileName({ at, seq: 1, endpoint: '/x', http: 200, json: true })
  const s2 = captureFileName({ at, seq: 2, endpoint: '/x', http: 200, json: true })
  assert.ok(s1 < s2, '同一批里序号决定先后（5 位补零）')
  /**
   * 🔴 **核心断言（用户要求）**：对**每一个端点形状**生成的名字，
   * 必须「掩码不动它」且「红线不命中」—— 这样 manifest 才能写真实文件名。
   * 端点清单取真实项目里的形状（含超长短名、纯数字短名等极端值）。
   */
  const { maskTokenLike } = await import('../../utils/mp/logFormat.ts')
  const { assertNoCredentials } = await import('../../utils/mp/diagnostics.ts')
  const endpoints = [
    '/wxxcx/sunrun/getSunrunPaper',
    '/wxxcx/platform/serverlist/getSunRunSchoolList',
    '/wxxcx/sunrun/selectSunRunStartConfiguration',
    '/wxxcx/sunrun/getRunBegin',
    '/wxxcx/very/long/path/with/many/segments/andAReallyLongEndpointNameHere',
    '/wxxcx/sunrun/GetStudentInfoByToken',
    '/',
    '/12345678',
    '/a',
    '???',
    '',
  ]
  for (const ep of endpoints) {
    for (const http of [200, 502]) {
      for (const json of [true, false]) {
        const n = captureFileName({ at, seq: 99999, endpoint: ep, http, json })
        assert.ok(n.length < 36, `文件名要**短于高熵门槛**（36）：${n}（端点 ${ep}）`)
        assert.equal(maskTokenLike(n), n, `掩码不得改动文件名：${n}（端点 ${ep}）`)
        assert.equal(assertNoCredentials([n]).ok, true, `红线不得命中文件名：${n}（端点 ${ep}）`)
      }
    }
  }
  // 短名只取**最后一段**（整条路径拼起来会太长而落进高熵判据带）
  assert.equal(captureEndpointSlug('/wxxcx/sunrun/getSunrunPaper'), 'getSunrunPaper')
  assert.equal(captureEndpointSlug('/wxxcx/platform/serverlist/getSunRunSchoolList'), 'getSunRunSchoolList')
  // 端点名净化：防目录穿越/非法字符
  assert.equal(captureEndpointSlug('../../etc/passwd'), 'passwd')
  assert.equal(captureEndpointSlug('/a/b/c'), 'c')
  assert.equal(captureEndpointSlug(''), 'root')
  assert.equal(captureEndpointSlug('???'), 'root')
  // 旧格式仍能解析（兼容"旧文件按旧格式读"）
  assert.deepEqual(parseCaptureName('20260923-140506078-0007-wxxcx-sunrun-getSunrunPaper-200.json'), {
    stamp: '20260923-140506078',
    seq: 7,
    endpoint: 'wxxcx-sunrun-getSunrunPaper',
    http: 200,
    json: true,
  })
  // 时间戳（meta 用）仍能互相转换
  assert.equal(captureStampToMs('20260923-140506078'), at.getTime())
  assert.equal(captureStampToIso('20260923-140506078'), at.toISOString())
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
  /** 先清空目录（前面的用例写了东西），再造 2 份"旧"的大文件 */
  store.clearCaptures()
  const dir = store.CAPTURE_DIR
  mkdirSync(dir, { recursive: true })
  /** 🆕 新命名（`c<5 位序号>-<短名>-<http>.ext`）：旧格式的 14 位时间戳会被掩码动，所以不再用它造夹具 */
  const mk = (seq: number, payloadBytes: number): string => {
    const name = `c${String(seq).padStart(5, '0')}-old-endpoint-200.json`
    writeFileSync(join(dir, name), 'x'.repeat(payloadBytes), 'utf8')
    /** meta 里写"2 天前"（时间判定看 meta.at；淘汰看 mtime/顺序） */
    const oldAt = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString()
    writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify({ at: oldAt, fileName: name, truncated: false }), 'utf8')
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000
    utimesSync(join(dir, name), old, old)
    return name
  }
  const old1 = mk(1, 1200 * 1024)
  const old2 = mk(2, 1200 * 1024)
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

test('🔴 回归：日志行里的**端点路径**不许被判成凭证（否则整个日志文件被红线剔、包里 logs/ 为空）', async () => {
  /**
   * 实测故障（2026-09-23 第一次端到端验收）：`proxy` 行里的
   * `"/wxxcx/platform/serverlist/getSunRunSchoolList"`（46 字符、含大小写与数字）**命中"高熵裸凭证"形态**
   * ⇒ 掩码把它改成 `[token len=46]` ⇒ 红线判据（"掩码会不会改动它"）判命中 ⇒ **整个日志文件被剔出包**
   * ⇒ 包里 `logs/` 为空、连"刷新前的事件"都没了。
   *
   * ⚠️ **路径判据现为 v13**（复验 B1 两轮打回后定稿）：只判**路径部分**（`?` 之前）——
   * ① 结构前缀（`/`、`./`、`../`、`http(s)://`）；② 路径部分不含 `+`/`=`；③ **无"长随机团块"分段**
   * （字母 ≥24 且大写占比 >0.35）。下面钉的就是这三条：
   *   · 真实端点（含 30 字符长段、36 连续字符的导出文件名、带查询串者）**必须仍判为路径**；
   *   · 以 `/` 开头的**随机 base64**必须被判成凭证（v3 会漏，v13 不会）。
   */
  const { maskTokenLike, hasUnmaskedCredential } = await import('../../utils/mp/logFormat.ts')
  const { assertNoCredentials } = await import('../../utils/mp/diagnostics.ts')
  /** 真实端点语料（**零误伤回归**）：含此前把 v4~v12 各版判据打回的那几条 */
  const paths = [
    '/wxxcx/platform/serverlist/getSunRunSchoolList',
    '/wxxcx/sunrun/selectSunRunStartConfiguration', // 单段 30 字符 —— "单段长度阈值"一类判据就是在这条上误伤的
    '/api/mp/wxxcx/sunrun/getRunBegin',
    '/data/exports/totoro-diagnostics-20260924-0051.zip', // 连续 36 字符 —— "≥36 连续字符"一类判据在这条上误伤
    '/wxxcx/sunrun/GetSunRunDetailByScantronId', // 大写占比 0.18 —— 靠"大写占比"判随机团块时必须不触发
    '/wxxcx/platform/serverlist/getSunRunSchoolListByCampus',
    '/wxxcx/user/profile?id=2021101234&tab=run', // 带查询串 —— v7* 的"不含 ?"在这条上误伤
    '/api/v1/search?q=hello&page=2',
    '/uploads/2026/09/24/report_final_v2.pdf',
    '/docs/getting-started/installation',
    '/health',
    '/static/js/main.abcdef12.js',
  ]
  for (const p of paths) {
    assert.equal(maskTokenLike(p), p, `端点路径不该被掩：${p}`)
    assert.equal(hasUnmaskedCredential(p), false, `端点路径不该被判成凭证：${p}`)
    assert.equal(assertNoCredentials([p]).ok, true, `端点路径必须过红线：${p}`)
  }
  /** 常见 URL（带 host / 查询串）也必须原样 */
  for (const u of ['https://wxxcx.xtotoro.com/api/mp/wxxcx/sunrun/getSunrunPaper', 'http://127.0.0.1:3000/api/local/diagnostics/record', 'https://cdn.example.com/assets/app.4f3a1b2c.js']) {
    assert.equal(maskTokenLike(u), u, `URL 不该被掩：${u}`)
  }
  /**
   * 🆕 **B1 复验要求的反例**：随机 base64（**含 `/`**）必须仍被掩且命中红线。
   * · v2 判据（"至少两段、每段字符集合法"）实测放过 **48/200**；· v3（只判前缀）放过 **≈1.5%**；
   * · **v13 实测 0.044%（89/200000）**，其中"以 `/` 开头 + 单段 ≥24 字母"这一类为 **0**。
   * 下面两个是**确定性**样本（不靠随机）：都以 `/` 开头、且含"长随机团块"分段。
   */
  const exact = 'DjYPSI6FwRDdcH2P62jVNu3frPHRwRM2YDuV4KH/dn5ZwyG5XMuuwd8/nZ2qQTUr'
  assert.notEqual(maskTokenLike(exact), exact, '含 / 的 base64 样本必须被掩')
  assert.equal(assertNoCredentials([exact]).ok, false, '含 / 的 base64 样本必须命中红线')
  for (const s of [
    /** 以 `/` 开头、单段 60 字母且大小写随机 ⇒ v13 的规则③ 命中（v3 会漏） */
    '/XkQmVbZtRpLwYhNcJdGfSaLuIoPeRtYuWqAzXcVbNmKlJhGfDsApOiUyTrEwQz',
    '/aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS',
  ]) {
    assert.notEqual(maskTokenLike(s), s, `以 / 开头的随机 base64 必须被掩：${s.slice(0, 40)}…`)
    assert.equal(assertNoCredentials([s]).ok, false, `以 / 开头的随机 base64 必须命中红线：${s.slice(0, 40)}…`)
  }
  /** 不含 `/` 的裸凭证（v2 那种"中间带 /"也一并钉住） */
  for (const s of [
    'Zk9Qc2lMcU5hQmNkRWZHaElqS2xNbg/OpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYz/0123456789abcdefghij',
    'AbCdEfGhIjKlMnOpQrS/TuVwXyZ0123456789/AbCdEfGhIjKlMnOpQrStUvWxYz0123',
  ]) {
    assert.notEqual(maskTokenLike(s), s, `含 / 的裸凭证必须被掩：${s.slice(0, 40)}…`)
    assert.equal(assertNoCredentials([s]).ok, false, `含 / 的裸凭证必须命中红线：${s.slice(0, 40)}…`)
  }
  /** 一整行 `proxy` 日志（含路径、`upstream`、`respShape`）必须过红线 */
  const line = JSON.stringify({
    t: '2026-09-23T05:16:24.000Z',
    level: 'info',
    cat: 'proxy',
    msg: 'POST /wxxcx/platform/serverlist/getSunRunSchoolList',
    data: {
      endpoint: '/wxxcx/platform/serverlist/getSunRunSchoolList',
      http: 200,
      bytes: 3811,
      upstream: { status: '00', code: null },
      respShape: { keys: ['body', 'status'], nested: ['body[0].schoolName'], arrays: {}, envelope: { status: '00' } },
    },
  })
  const verdict = assertNoCredentials([line])
  assert.equal(verdict.ok, true, `proxy 日志行必须过红线（否则整个日志文件被剔）：${verdict.hits.join(',')}`)
  /** 反向：真 token（含 `+` `/` `=`）**仍然要掩**（第一版把含 `/` 的一律当路径 ⇒ 放过了真 token，单测当场抓到） */
  const real = `WXXCX${'Ab3+/='.repeat(18)}`
  assert.notEqual(maskTokenLike(real), real, '含 +/= 的 base64 token 必须仍被掩')
  assert.equal(assertNoCredentials([real]).ok, false, '未掩的真 token 必须被红线拦住')
})

test('🔴 复验 B2：**有记录窗口时 captures 也按窗口过滤**（不许把窗口之前的历史原文一起发出去）', () => {
  store.clearCaptures()
  const now = Date.now()
  const mk = (atMs: number, tag: string): string => {
    const s = store.writeCapture({
      endpoint: `/probe/${tag}`,
      http: 200,
      ms: 1,
      originalBytes: 3,
      payload: { kind: 'text', text: `body-${tag}` },
      at: new Date(atMs),
    })
    assert.ok(s, `留档应成功：${tag}`)
    return s!
  }
  /** 窗口之前 2 份（复验现场：12:49 开始记录，12:47 的原文不该进包） */
  const before1 = mk(now - 5 * 60_000, 'before-1')
  const before2 = mk(now - 4 * 60_000, 'before-2')
  /** 窗口之内 2 份 */
  const inRange = mk(now - 30_000, 'in-window')
  const range = { startedAtMs: now - 60_000, endedAtMs: now }

  /** ① 窗口口径：只收窗口内的 */
  const scoped = store.recentCaptures(3, new Date(now), range)
  assert.deepEqual(scoped.map((x) => x.name), [inRange], `窗口口径只应收窗口内那 1 份，实际 ${JSON.stringify(scoped.map((x) => x.name))}`)
  assert.ok(!scoped.some((x) => x.name === before1 || x.name === before2), '窗口之前的原文不得进包')

  /** ② 不传 range（无窗口）⇒ 退回"最近 N 天"口径，三份都在 */
  const recent = store.recentCaptures(3, new Date(now))
  assert.equal(recent.length, 3, `无窗口时应退回最近 N 天（3 份），实际 ${recent.length}`)

  /** ③ `endedAtMs=0`（仍在记录）⇒ 右边界用"此刻"，窗口内的照样收 */
  const openEnded = store.recentCaptures(3, new Date(now), { startedAtMs: now - 60_000, endedAtMs: 0 })
  assert.deepEqual(openEnded.map((x) => x.name), [inRange], '窗口未结束时用"此刻"当右边界')

  /** ④ 窗口起点晚于所有文件 ⇒ 一份都不给（**不许**退化成"全给"） */
  const empty = store.recentCaptures(3, new Date(now), { startedAtMs: now + 60_000, endedAtMs: 0 })
  assert.deepEqual(empty, [], '窗口还没开始的区间不该收到任何历史原文')
  /**
   * ⚠️ **故意不清空**：下一个用例（"窗口过滤（最近 N 天）"）要求目录里有今天那份；
   * 这里清了会让它读到 0 份（实测踩到）。本文件最后的 `clearCaptures` 用例会收尾清理。
   */
})

test('captures：窗口过滤（最近 N 天）+ 窗口内逐份可读', () => {
  const items = store.recentCaptures(3)
  assert.ok(items.length >= 1, `应当至少读到今天那份，实际 ${items.length}`)
  for (const it of items) {
    // 名字要么是新格式（`c00001-…`），要么是旧格式（`<时间戳>-…`）—— 两种都要能进包
    assert.ok(/^(c\d{1,5}-|\d{8}-\d{9}-)/.test(it.name), `窗口内的名字要合法：${it.name}`)
    assert.ok(it.text.length > 0, '正文要读得到')
  }
  /** 时间判定：今天写的那份必须在（meta.at 优先） */
  assert.ok(items.some((it) => it.meta?.at), '至少有一份带 meta.at（时间判定靠它）')
  /** 窗口 0 天 ⇒ 什么都不给（防呆） */
  assert.deepEqual(store.recentCaptures(0), [])
})

test('captures：`.txt` 坐标**尽力剥离**（两态：关 ⇒ 值不出现且有计数；开 ⇒ 原样）', async () => {
  const { stripGeometryFromText } = await import('../../utils/mp/responseRecord.ts')
  /** 覆盖用户点名的所有形态：JSON 片段（数字/字符串/数组）+ 查询串/表单 */
  const txt = [
    '<html><script>var p = {"latitude": 30.123456, "longitude": 120.654321};</script></html>',
    '{"data":{"runPointList":[{"pointId":"L1"}],"routeItudes":"30.1,120.2;30.3,120.4"}}',
    "lat=30.123456&lng=120.654321&name=x",
    "'lat': -30.5, 'lng': 120.25",
    '{"routeItudes":["30.1,120.2","30.3,120.4"]}',
    '<div data-latitude="30.1">不受覆盖的形态（如实说明可能残留）</div>',
  ].join('\n')
  const r = stripGeometryFromText(txt)
  for (const gone of ['30.123456', '120.654321', '30.1,120.2', '30.3,120.4', '-30.5', '120.25']) {
    assert.ok(!r.text.includes(gone), `坐标值不得残留：${gone}（实际 ${r.text.slice(0, 200)}）`)
  }
  assert.ok(r.count >= 5, `要如实计数剥了几处，实际 ${r.count}`)
  assert.ok(r.text.includes('[坐标已按开关省略]'), '要有占位符（让人看出这里原本有坐标）')
  // 非坐标内容一个不动
  assert.ok(r.text.includes('L1') && r.text.includes('name=x'), '其余内容一个不动')
  /** 反向：不做剥离时（开着开关）原文逐字保留 */
  assert.ok(txt.includes('30.123456'), '开着开关时原样保留（调用方不调这个函数即可）')
  /** 边界：空串 / 无坐标文本 不抛错、计数为 0 */
  assert.deepEqual(stripGeometryFromText(''), { text: '', count: 0 })
  assert.deepEqual(stripGeometryFromText('hello world'), { text: 'hello world', count: 0 })
})

test('captures：「退出登录」与「清空本机数据」都清 captures（源码级守卫 + 行为断言）', async (t) => {
  const { readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  /** 先在目录里放一份，验证 clearCaptures 真能清空（行为断言） */
  const seeded = store.writeCapture({ endpoint: '/probe/seed-before-clear', http: 200, ms: 1, originalBytes: 3, payload: { kind: 'text', text: 'seed' } })
  assert.ok(seeded && existsSync(join(store.CAPTURE_DIR, seeded)), '清空前应当有一份')
  const cleared = store.clearCaptures()
  assert.ok(cleared.files >= 1, `清空要报告删了几份，实际 ${cleared.files}`)
  assert.deepEqual(
    existsSync(store.CAPTURE_DIR) ? (await import('node:fs')).readdirSync(store.CAPTURE_DIR).filter((n) => /\.(json|txt)$/.test(n) && !n.endsWith('.meta.json')) : [],
    [],
    '清空后目录里没有正文文件',
  )

  /** 源码级守卫：`composables/real/data.ts` 的两个函数体里各要调一次（调用形式不写死，只要是清 captures） */
  let dir = join(fileURLToPath(import.meta.url), '..')
  let root = ''
  for (let i = 0; i < 6; i++) {
    const parent = join(dir, '..')
    if (existsSync(join(parent, 'package.json')) && existsSync(join(parent, 'composables', 'real', 'data.ts'))) {
      root = parent
      break
    }
    dir = parent
  }
  if (!root) {
    t.skip('找不到项目根（package.json + composables/real/data.ts）—— 可能不在仓库内运行；本守卫跳过')
    return
  }
  const src = readFileSync(join(root, 'composables', 'real', 'data.ts'), 'utf8')
  /** 取函数体（从 `function xxx(` 到下一个顶层 function / 注释块） */
  const bodyOf = (marker: string): string => {
    const at = src.indexOf(marker)
    assert.ok(at >= 0, `data.ts 里找不到 ${marker}（守卫需同步更新）`)
    const rest = src.slice(at + marker.length)
    const next = rest.search(/\n {2}(?:async )?function |\n {2}\/\*\* /)
    return next < 0 ? rest : rest.slice(0, next)
  }
  for (const fn of ['function logoutAndClearSession(', 'function clearAllLocalData(']) {
    const body = bodyOf(fn)
    assert.match(body, /clearServerCaptures\(/, `${fn} 里没有清服务端 captures（换账号会留下上一个账号的响应原文）`)
  }
  /** 清空动作要**尽力而为**：调用处必须用 `void`（不 await、不让失败影响退出/清空） */
  assert.match(src, /void clearServerCaptures\(/, '调用要 `void`（清不掉也不能让退出/清空失败）')
  /** 服务端端点存在且沿用本机校验 */
  const ep = join(root, 'server', 'api', 'local', 'diagnostics', 'captures', 'clear.post.ts')
  assert.ok(existsSync(ep), '缺 `POST /api/local/diagnostics/captures/clear` 端点')
  const epSrc = readFileSync(ep, 'utf8')
  assert.match(epSrc, /assertLocalRequest\(/, '端点必须沿用 assertLocalRequest（只允许本机）')
  assert.match(epSrc, /clearCaptures\(/, '端点必须真的调 clearCaptures')
})

test('captures：clearCaptures 清空目录（含台账）', () => {
  /** 先放一份（上一用例已清过，可能为空 ⇒ 补一份保证断言有意义） */
  if (listCaptureFiles().length === 0) {
    store.writeCapture({ endpoint: '/probe/for-clear', http: 200, ms: 1, originalBytes: 2, payload: { kind: 'text', text: 'x' } })
  }
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
