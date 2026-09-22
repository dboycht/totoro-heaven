/**
 * `utils/mp/responseRecord.ts`（「**全记录**」：响应结构 + 脱敏后的内容 + 解包退化留痕）的单测
 * —— 2026-09-22 新增（用户原话："全记录"）
 *
 * 为什么必须单独测（这是**安全路径**）：它把**上游响应原文**写进本机日志。
 * 红线判据（可执行）：构造"响应里带真 token / 学号 / 姓名 / 手机号"的用例 ⇒
 *   ① 落盘文本里**不得出现任何原值**；
 *   ② 必须能看到掩码痕迹（`masked` / `[token len=` / 星号）。
 * 只测其中一个方向都会漏（"全掩掉"与"全没掩"都能骗过单测）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RESP_BODY_MAX_BYTES,
  RESP_TEXT_PREVIEW_CHARS,
  knownValuePairs,
  redactForRecord,
  stripGeometryFromRespBody,
  summarizeRespShape,
  summarizeResponseBody,
  unpackNote,
} from '../../utils/mp/responseRecord.ts'
import { assertNoCredentials } from '../../utils/mp/diagnostics.ts'
import { REDACTED_MARK, redactObject, summarizeUpstream } from '../../utils/mp/logFormat.ts'

/** 一份"像真实上游"的信封（含任务、线路坐标、身份信息、token 样式串） */
function envelopeWithSecrets() {
  const token = `WXXCX${'Ab3kZ9_x-y.'.repeat(6)}` // 113 字符，形似真 token
  return {
    status: '00',
    code: '0',
    msg: 'ok',
    data: {
      paperName: '研途健行',
      taskId: 't-1',
      mileage: 2,
      fitDegree: 0.6,
      stuNumber: '2021101234',
      studentName: '张小明',
      phone: '13812345678',
      token,
      authorization: `Bearer ${token}`,
      runPointList: [
        {
          pointId: 'L1',
          pointName: '西操场',
          pointList: [{ latitude: '30.123456', longitude: '120.654321' }],
        },
      ],
    },
    sunrunTaskList: [{ paperName: '研途健行', runPointList: [{ pointId: 'L1', pointName: '西操场' }] }],
    total: 1,
  }
}

/**
 * 🔴 红线：响应里带真 token / 学号 / 姓名 / 手机 ⇒ 落盘文本**不得含原值**，且必须看到掩码痕迹。
 * 对照表照**代理的真实做法**从请求体里生成（请求体里带着同一个学号/姓名/手机）。
 */
test('🔴 全记录红线：token/学号/姓名/手机 一律不进落盘文本（正向掩码 + 反向不泄漏）', () => {
  const env = envelopeWithSecrets()
  const token = String((env.data as Record<string, unknown>).token)
  const requestBody = { stuNumber: '2021101234', studentName: '张小明', phone: '13812345678' }
  const known = knownValuePairs(requestBody)
  assert.ok(known.length >= 3, `对照表至少要收到学号/姓名/手机三样，实际 ${JSON.stringify(known)}`)

  const rec = summarizeResponseBody(JSON.stringify(env), env, known)
  const text = JSON.stringify(rec)
  // ① 原值一个都不许出现
  assert.ok(!text.includes(token), 'token 原串不得出现在落盘文本里')
  assert.ok(!text.includes('Bearer ' + token), 'Bearer + token 不得出现')
  assert.ok(!text.includes('2021101234'), '学号原值不得出现')
  assert.ok(!text.includes('张小明'), '姓名原值不得出现')
  assert.ok(!text.includes('13812345678'), '手机号原值不得出现')
  // ② 掩码痕迹必须在（否则可能是"整段被丢了"而不是"掩了"）
  assert.ok(/\[token len=\d+\]/.test(text) || /"token":"\[masked len=\d+\]"/.test(text), 'token 要么按字段名掩、要么按样式串掩，但必须留下掩码痕迹')
  assert.match(text, /\[masked len=\d+\]/, '敏感字段要留下掩码痕迹')
  assert.ok(text.includes('研途健行'), '非敏感内容（任务名）应当照记 —— 否则"全记录"没意义')
  assert.ok(text.includes('西操场'), '非敏感内容（线路名）应当照记')
  // ⚠️ 不能出现 `[deep]`：那是"层数太深 ⇒ 内容被整段丢掉"，与"全记录"直接冲突。
  // 实测踩到：默认深度 4 会把 `body[0].schoolName` 这种第 4 层的字段变成 `[deep]`（只剩键名）。
  assert.ok(!text.includes('[deep]'), '内容不应因为"层数太深"被整段丢掉（全记录要真的记下来）')
  assert.ok(text.includes('30.123456'), '坐标属于"内容"，默认应当照记（是否进包由导出时的坐标开关决定）')
  // ③ 诊断包红线也必须过（写盘前已脱敏 ⇒ 不该再命中"剔文件"那条路径）
  assert.deepEqual(assertNoCredentials([text]).hits, [], '脱敏后的落盘文本不该再触发诊断红线')
})

test('🔴 全记录红线：**没有对照表**时，数字兜底与字段名掩码仍要挡住学号/手机', () => {
  const env = envelopeWithSecrets()
  const rec = summarizeResponseBody(JSON.stringify(env), env, []) // 故意不给对照表
  const text = JSON.stringify(rec)
  assert.ok(!text.includes('2021101234'), '8~18 位纯数字兜底必须掩掉学号')
  assert.ok(!text.includes('13812345678'), '手机号形态（11 位 1 开头）也要掩')
  assert.ok(!text.includes('张小明'), '字段名 studentName ⇒ 整体掩码')
  assert.match(text, /\[masked len=\d+\]/)
})

test('redactForRecord：已知原值出现在**别的字符串里**也要替换（错误文案场景）', () => {
  const known = knownValuePairs({ stuNumber: '2021101234', studentName: '张小明', phone: '13812345678' })
  const out = String(redactForRecord('未找到用户 2021101234（张小明，13812345678）的同学', known))
  assert.ok(!out.includes('2021101234') && !out.includes('张小明') && !out.includes('13812345678'), `实际：${out}`)
  assert.match(out, /20\*+34/, '学号应当留下前 2 后 2 的掩码形态（与诊断包同一口径）')
  assert.match(out, /张\*/, '姓名应留姓（maskName 口径）')
})

test('redactObject：同一行里的"名字敏感字段的值"会在其它字段里也被替换（值级脱敏默认生效）', () => {
  const line = { stuNumber: '2021101234', upstream: { message: '未找到用户 2021101234' } }
  const out = redactObject(line)
  const text = JSON.stringify(out)
  assert.ok(!text.includes('2021101234'), `上游原话里的同一学号也必须掩掉：${text}`)
  // 不含敏感字段的对象 ⇒ 行为与旧版一致（不被无谓改写）
  const plain = redactObject({ endpoint: '/x', bytes: 12, note: '正常' })
  assert.deepEqual(plain, { endpoint: '/x', bytes: 12, note: '正常' })
})

test('summarizeRespShape：只记键名/长度/信封标量，**不记这些键的值**', () => {
  const env = envelopeWithSecrets()
  const shape = summarizeRespShape(env)
  assert.deepEqual(shape.keys, ['code', 'data', 'msg', 'status', 'sunrunTaskList', 'total'], '顶层键名排序')
  assert.deepEqual(shape.envelope, { status: '00', code: '0', msg: 'ok', total: 1 }, '信封标量照记（它们是状态码/消息，不是业务内容）')
  assert.equal(shape.arrays['data.runPointList'], 1, '数组长度必须记（"到底下发了几条线路"就靠它）')
  assert.equal(shape.arrays['sunrunTaskList'], 1)
  assert.ok(shape.nested.includes('data.paperName'), '嵌套键名要记到 2~3 层')
  assert.ok(shape.nested.includes('data.runPointList[0].pointName'), '数组元素里的键名也要记一层')
  // ⚠️ 结构摘要里**不得**出现值（尤其是坐标与身份）
  const text = JSON.stringify(shape)
  assert.ok(!text.includes('30.123456') && !text.includes('120.654321'), '结构摘要里不得出现坐标值')
  assert.ok(!text.includes('2021101234') && !text.includes('张小明'), '结构摘要里不得出现身份值')
  assert.ok(!text.includes('研途健行'), '结构摘要里连任务名的值也不记（只记键名）')
  // 非对象输入安全降级
  assert.deepEqual(summarizeRespShape(42).envelope, { kind: 'number' })
  assert.equal(summarizeRespShape(null).keys.length, 0)
  // 顶层就是数组时，长度记在 `'[]'` 键上（结构摘要里数组长度是"一共几条"的唯一来源）
  assert.equal(summarizeRespShape([1, 2, 3]).arrays['[]'], 3)
})

test('unpackNote：负载藏在信封里 ⇒ suspect（这次真实用户的形状）；负载在顶层 ⇒ ok', () => {
  // 🔴 现场：sunrunPaper 的规格要 getSunrunPaperResponseList，真实响应只有 data.runPointList
  const real = { status: '00', code: '0', data: { paperName: '研途健行', runPointList: [{ pointId: 'L1' }] }, sunrunTaskList: [{ pointId: 'L1' }] }
  const n = unpackNote(real)
  assert.equal(n.status, 'suspect', '顶层只剩信封字段 ⇒ 必须留痕，别再让人靠猜')
  assert.equal(n.envelopeField, 'data')
  assert.equal(n.hint, 'data.runPointList', '提示要指向"最像负载的那个数组"')
  // 负载就在顶层 ⇒ ok（不误报：真·无线路任务也是 ok）
  assert.equal(unpackNote({ status: '00', runPointList: [] }).status, 'ok')
  assert.equal(unpackNote({ status: '00', runPointList: [{ pointId: 'L1' }] }).status, 'ok')
  // 非信封响应（纯业务对象）⇒ ok
  assert.equal(unpackNote({ paperName: 'x', runPointList: [] }).status, 'ok')
  // 数组/标量响应 ⇒ ok（不是信封形状）
  assert.equal(unpackNote([1, 2]).status, 'ok')
  assert.equal(unpackNote('text').status, 'ok')
  assert.equal(unpackNote(null).status, 'ok')
  // 只有 code 没有负载字段 ⇒ 不是"藏在信封里"（没有 data/obj/body/result 可指）
  assert.equal(unpackNote({ code: '0', msg: 'ok' }).status, 'ok')
})

test('summarizeResponseBody：JSON 正常/空/非 JSON 三种形态，且都带原始字节数', () => {
  const env = { status: '00', data: { a: 1 } }
  const j = summarizeResponseBody(JSON.stringify(env), env)
  assert.equal(j.kind, 'json')
  assert.equal(j.truncated, false)
  assert.equal(j.originalBytes, Buffer.byteLength(JSON.stringify(env), 'utf8'))
  // 空响应
  const e = summarizeResponseBody('', undefined, [], RESP_BODY_MAX_BYTES, 'application/json')
  assert.equal(e.kind, 'empty')
  assert.equal(e.originalBytes, 0)
  assert.equal(e.bytes, 0)
  // 非 JSON（网关 HTML 错误页）：只记脱敏后的前缀 + content-type（理由见模块头）
  const html = `<html>${'x'.repeat(RESP_TEXT_PREVIEW_CHARS * 2)}</html>`
  const t = summarizeResponseBody(html, undefined, [], RESP_BODY_MAX_BYTES, 'text/html')
  assert.equal(t.kind, 'text')
  assert.equal(t.truncated, true)
  assert.equal(t.contentType, 'text/html')
  assert.equal((t.text ?? '').length, RESP_TEXT_PREVIEW_CHARS, '只记前 512 字符')
  assert.match(String(t.note), /只记前 512 字符/)
})

test('summarizeResponseBody：超单条上限 ⇒ 逐级降级（瘦身保留总长 → 只留顶层键名），且注明截断', () => {
  /**
   * ⚠️ 这里**显式传一个更小的上限**（4 KB）来考"字节上限 ⇒ 瘦身"这一段：
   * 用默认 32 KB 时，响应会先被**脱敏阶段**的"长数组裁到 20 项"压小（那条路径由下一个用例专门考），
   * 于是瘦身那一段反而走不到（第一版就是这么误判的）。两级降级必须各有用例覆盖。
   * 输入取**顶层数组**：`shrink()` 对这种结构最直接，判据也最好核对。
   */
  const smallCap = 4096
  const list = Array.from({ length: 300 }, (_, i) => ({ id: `rec-${i}`, padding: 'x'.repeat(200) }))
  const rec = summarizeResponseBody(JSON.stringify(list), list, [], smallCap)
  assert.equal(rec.truncated, true, '必须标记截断')
  assert.ok(rec.originalBytes > smallCap, `原始应当是"超大"：${rec.originalBytes}`)
  assert.ok(rec.bytes <= smallCap, `落盘内容必须在上限内，实际 ${rec.bytes}`)
  const text = JSON.stringify(rec.body)
  /**
   * 「全记录」的硬要求：**"一共几条"永远看得见**。三条降级路径都满足它：
   *   · 瘦身 ⇒ `…[省略 N 项，原共 300 项]`；
   *   · 脱敏裁剪 ⇒ 同样带"原共 N 项"（这里的 68901 字节响应会先被裁剪）；
   *   · 只留顶层键名 ⇒ `[数组，共 20 项]`（**裁剪后**的真实条数，因为 byte 上限那一步已经发生）。
   * 三种写法都必须能看出"这里并不是全部"。
   */
  assert.ok(
    /原共 300 项/.test(text) || /共 20 项/.test(text),
    `必须能看出"不是全部"（原共 300 项 / 共 20 项 二者必居其一）：${text.slice(0, 160)}`,
  )
  assert.ok(text.includes('rec-0'), '数组头部要留')
  assert.equal(rec.droppedItems, 280, '脱敏阶段裁掉 280 个（300 - 20）要如实计数')
  assert.match(String(rec.note), /裁掉过长数组的 280 个元素/)
  // 嵌套结构里的深层大数组同样要瘦身（第一版 depth>4 会让它直接掉到"只留键名"）
  const nested = { status: '00', data: { runPointList: Array.from({ length: 300 }, (_, i) => ({ pointId: `L${i}`, padding: 'x'.repeat(200) })) } }
  const recNested = summarizeResponseBody(JSON.stringify(nested), nested, [], smallCap)
  const nestedText = JSON.stringify(recNested.body)
  assert.match(nestedText, /原共 300 项/, `嵌套里的数组也要瘦身并保留总长：${nestedText.slice(0, 160)}`)
  // 极端：单键巨值（逐槽填充也放不下它）⇒ 仍然必须 ≤ 上限，且写明原始大小
  const huge = { status: '00', data: { blob: 'y'.repeat(smallCap * 2) } }
  const rec2 = summarizeResponseBody(JSON.stringify(huge), huge, [], smallCap)
  assert.equal(rec2.truncated, true)
  assert.ok(rec2.bytes <= smallCap, `落盘必须 ≤ 上限，实际 ${rec2.bytes}`)
  assert.match(String(rec2.note), /字节预算|只保留顶层键名/)
  assert.ok(String(rec2.note).includes(String(rec2.originalBytes)), '截断说明里要有原始字节数')
})

/**
 * 🆕 「全记录」必须**如实上报"脱敏阶段裁掉了多少"**（实测踩到的坑）：
 * `redactValue` 会把超长数组静默截到 20 项（那是"日志摘要"的旧口径），
 * 于是"响应里 300 条记录、日志里只有 20 条"这件事看不出来。
 */
test('summarizeResponseBody：长数组被脱敏裁剪时，truncated=true 且 droppedItems 如实计数', () => {
  const many = { status: '00', data: { records: Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, name: `记录${i}` })) } }
  const rec = summarizeResponseBody(JSON.stringify(many), many)
  assert.equal(rec.truncated, true, '被裁过就必须标记 truncated（否则维护者以为"本来就 20 条"）')
  assert.equal(rec.droppedItems, 280, '300 - 20 = 280（裁剪口径与 redactValue 一致）')
  assert.match(String(rec.note), /裁掉过长数组的 280 个元素/)
  assert.match(String(rec.note), /data\.records/, 'note 里要指出是哪个数组被裁的')
  // 裁剪后是 20 条 + **一条"省略 N 项，原共 300 项"的说明**（长度 21）：说明那一项是关键，
  // 它保证维护者永远看得出"这里不是全部"（而不是静默少给）
  const records = (rec.body as { data: { records: unknown[] } }).data.records
  assert.equal(records.length, 21, '20 条 + 1 条省略说明')
  assert.equal(typeof records[20], 'string')
  assert.match(String(records[20]), /省略 280 项，原共 300 项/)
  // 不超过 20 项的数组 ⇒ 不裁、不标记
  const few = { status: '00', data: { records: [1, 2, 3] } }
  const rec2 = summarizeResponseBody(JSON.stringify(few), few)
  assert.equal(rec2.truncated, false)
  assert.equal(rec2.droppedItems, undefined)
})

test('stripGeometryFromRespBody：关掉坐标开关时只删坐标键，其余（结构/长度/线路名）一个不动', () => {
  const rec = {
    kind: 'json',
    originalBytes: 100,
    bytes: 90,
    truncated: false,
    body: {
      data: {
        paperName: '研途健行',
        runPointList: [{ pointId: 'L1', pointName: '西操场', pointList: [{ latitude: '30.1', longitude: '120.2' }] }],
        routeItudes: '30.1,120.2;30.3,120.4',
      },
    },
  }
  const out = stripGeometryFromRespBody(rec) as typeof rec
  const text = JSON.stringify(out)
  assert.ok(!text.includes('latitude') && !text.includes('longitude'), '坐标键必须被整键删除')
  assert.ok(!text.includes('routeItudes'))
  assert.ok(text.includes('西操场'), '线路名要保留')
  assert.ok(text.includes('L1'), '线路 id 要保留')
  assert.equal(out.originalBytes, 100, '其余字段（含记账）一个不动')
  // 非 JSON 的 text 形态：字符串级替换
  const textRec = { kind: 'text', originalBytes: 10, bytes: 10, truncated: false, text: '{"latitude":"30.1","longitude":"120.2","ok":1}' }
  const out2 = stripGeometryFromRespBody(textRec) as { text: string }
  assert.ok(!out2.text.includes('30.1') && !out2.text.includes('120.2'))
  assert.ok(out2.text.includes('坐标已按开关省略'))
  // 非对象输入原样返回（不改、不抛）
  assert.equal(stripGeometryFromRespBody('x'), 'x')
  assert.equal(stripGeometryFromRespBody(null), null)
})

// ============================================================================
// 2026-09-22 独立审计的**逐条反例**（审计给了具体输入与实测输出，这里一条条钉住）
// ============================================================================

test('🔴 审计 B1：无论什么形状，落盘都**必 ≤ maxBytes**（40×2KB 字符串 / 单个 100KB / 10MB 标量）', () => {
  const cap = RESP_BODY_MAX_BYTES
  /** ① 顶层 40 个各 2 KB 的字符串（审计实测老版本落盘 80351 B，上限 32768） */
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'A'.repeat(2048)]))
  const r1 = summarizeResponseBody(JSON.stringify(many), many)
  assert.ok(r1.bytes <= cap, `① 落盘 ${r1.bytes} B 超上限 ${cap}（老版本实测 80351）`)
  assert.equal(r1.truncated, true)
  /** ② 顶层单个 100 KB 标量（老版本 100014 B） */
  const big = { blob: 'B'.repeat(100 * 1024) }
  const r2 = summarizeResponseBody(JSON.stringify(big), big)
  assert.ok(r2.bytes <= cap, `② 落盘 ${r2.bytes} B 超上限`)
  assert.match(JSON.stringify(r2.body), /字节已省略/, '放不下的标量要写成"N 字节已省略"')
  /** ③ "真 logger 落盘 10 MB 响应"的等价场景：单条 10 MB 的 JSON */
  const huge = { data: { rows: Array.from({ length: 2000 }, () => 'C'.repeat(5000)) } }
  const r3 = summarizeResponseBody(JSON.stringify(huge), huge)
  assert.ok(r3.bytes <= cap, `③ 落盘 ${r3.bytes} B 超上限`)
  assert.ok(r3.originalBytes > 9 * 1024 * 1024, `原始应当接近/超过 10MB，实际 ${r3.originalBytes}`)
  assert.equal(r3.truncated, true)
  /** ④ 极端：宽 + 深 + 长字符串混在一起 */
  const mixed = { a: 'D'.repeat(50000), b: { c: { d: { e: { f: 'E'.repeat(50000) } } } }, g: Array.from({ length: 500 }, () => ({ h: 'F'.repeat(500) })) }
  const r4 = summarizeResponseBody(JSON.stringify(mixed), mixed)
  assert.ok(r4.bytes <= cap, `④ 落盘 ${r4.bytes} B 超上限`)
})

test('🔴 审计 B3：envelope 的自由文本必须脱敏（学号/姓名/手机不许出现在 respShape 里）', () => {
  const known = knownValuePairs({ stuNumber: '2021101234', studentName: '张小明', phone: '13812345678' })
  const env = {
    status: '01',
    code: '1',
    msg: '未找到用户 2021101234 登录失败',
    message: '张小明 的手机号 13812345678 与学号不匹配',
    total: 1,
    data: { runPointList: [] },
  }
  const shape = summarizeRespShape(env, {}, known)
  const text = JSON.stringify(shape)
  assert.ok(!text.includes('2021101234'), `学号不得出现在 respShape 里：${text}`)
  assert.ok(!text.includes('张小明'), `姓名不得出现：${text}`)
  assert.ok(!text.includes('13812345678'), `手机号不得出现：${text}`)
  assert.match(String(shape.envelope.msg), /20\*+34/, '学号要留下掩码痕迹')
  assert.match(String(shape.envelope.message), /张\*/, '姓名要留下掩码痕迹')
  // 与 respBody 同一行内的口径必须一致（审计原话：同一行里 respBody 掩了、envelope 没掩 = 前后矛盾）
  const body = summarizeResponseBody(JSON.stringify(env), env, known)
  const bodyText = JSON.stringify(body)
  assert.ok(!bodyText.includes('2021101234') && !bodyText.includes('张小明') && !bodyText.includes('13812345678'))
  // summarizeUpstream（老路径）也必须收口
  const up = summarizeUpstream(env, known)
  const upText = JSON.stringify(up)
  assert.ok(!upText.includes('2021101234') && !upText.includes('张小明') && !upText.includes('13812345678'), `summarizeUpstream 漏了：${upText}`)
})

test('🔴 审计 B4：**数字型**学号/手机也要掩（`{"list":[2021101234,13812345678]}`）', () => {
  const env = { list: [2021101234, 13812345678], nested: { id: 2021101234 } }
  const r = summarizeResponseBody(JSON.stringify(env), env)
  const text = JSON.stringify(r.body)
  assert.ok(!text.includes('2021101234'), `数字型学号原样落盘了：${text}`)
  assert.ok(!text.includes('13812345678'), `数字型手机原样落盘了：${text}`)
  assert.match(text, /"20\*+\d{2}"/, '应当留下掩码后的字符串形态')
  // 普通数字不能被误伤
  const ok = summarizeResponseBody(JSON.stringify({ n: 3.14, year: 2026, big: 123 }), { n: 3.14, year: 2026, big: 123 })
  assert.deepEqual(ok.body, { n: 3.14, year: 2026, big: 123 })
})

test('🔴 审计 B5：**键名**也要脱敏（学号/姓名当键名时两处都不许原样）', () => {
  const env = { data: { 2021101234: { ok: 1 }, 张小明: { ok: 2 } } }
  const r = summarizeResponseBody(JSON.stringify(env), env)
  const shape = summarizeRespShape(env)
  const bodyText = JSON.stringify(r.body)
  const shapeText = JSON.stringify(shape)
  assert.ok(!bodyText.includes('2021101234') && !bodyText.includes('张小明'), `respBody 的键名漏了：${bodyText}`)
  assert.ok(!shapeText.includes('2021101234') && !shapeText.includes('张小明'), `respShape.nested 的键名漏了：${shapeText}`)
  // 结构不变（还是两个键）
  assert.equal(Object.keys((r.body as { data: Record<string, unknown> }).data).length, 2)
})

test('🔴 审计 B6：accessToken / 超长 tokenValue / X-Auth-Token / sk- / 裸 JWT 都不许落盘，且红线不该误剔', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.cGF5bG9hZGF0YQ.c2lnbmF0dXJl'
  const env = {
    accessToken: 'a'.repeat(40),
    refreshToken: 'b'.repeat(40),
    tokenValue: 'c'.repeat(40),
    appToken: 'd'.repeat(40),
    'X-Auth-Token': 'e'.repeat(40),
    secretKey: 'f'.repeat(40),
    sessionKey: 'g'.repeat(40),
    sk: 'sk-live-abcdefghijklmnopqrstuvwx',
    jwt,
    note: `裸 JWT：${jwt}`,
  }
  const r = summarizeResponseBody(JSON.stringify(env), env)
  const text = JSON.stringify(r.body)
  for (const [k, v] of Object.entries({ accessToken: 'a'.repeat(40), refreshToken: 'b'.repeat(40), tokenValue: 'c'.repeat(40), jwt })) {
    assert.ok(!text.includes(v), `${k} 的值不该出现`)
  }
  assert.ok(!text.includes('sk-live-abcdefghijklmnopqrstuvwx'), 'sk- 形态密钥不该出现')
  // 掩码痕迹：字段名掩码 + token 样式掩码
  assert.match(text, /\[masked len=\d+\]/)
  assert.match(text, /\[token len=\d+\]/)
  // 红线：掩码后不该再命中（否则文件会被整份剔掉 —— 用户丢证据）
  assert.deepEqual(assertNoCredentials([text]).hits, [], '脱敏后的日志不该再触发导出红线')
  // 反向：**未脱敏**的裸 JWT 必须被红线判命中（否则它就会随包发出）
  assert.ok(assertNoCredentials([`{"note":"裸 JWT：${jwt}"}`]).hits.length > 0, '未脱敏的裸 JWT 必须被红线拦住')
})

test('🔴 审计 B10：非 JSON 预览先在"512+余量"整段脱敏再截断，边界不留 token 片段', () => {
  /** 让一个真凭证**跨越**第 512 字节：前 500 个 x + `WXXCX…` */
  const token = `WXXCX${'Ab3kZ9_x-y.'.repeat(6)}`
  const raw = 'x'.repeat(500) + token + 'y'.repeat(200)
  const r = summarizeResponseBody(raw, undefined, [], RESP_BODY_MAX_BYTES, 'text/html')
  const text = String(r.text)
  assert.ok(r.bytes <= RESP_TEXT_PREVIEW_CHARS + 32, `预览不该超过 512（余量内），实际 ${r.bytes}`)
  assert.ok(!text.includes(token), '完整 token 不该出现')
  assert.ok(!text.includes(token.slice(0, 12)), '边界残段（前 12 字符）也不该出现 —— 这正是审计抓到的 `WXXCXAb3kZ9_`')
  assert.match(text, /\[token len=\d+\]/, '应当是掩码后的形态')
})

test('🔴 审计 B2：recorder 产物带"已脱敏"标记 ⇒ logger 二次脱敏不再塌成 [deep]', () => {
  /** 造一个 6+ 层的结构（老实现会被 logger 从行根起算的 depth=4 砍成 [deep]） */
  const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: '最深处的值' } } } } } } }
  const rec = summarizeResponseBody(JSON.stringify(deep), deep)
  const body = rec.body as Record<string, unknown>
  assert.equal((body[REDACTED_MARK as unknown as string] as unknown) ?? true, true, '（标记是非枚举 Symbol，见下一条直接断言）')
  // 真的过一遍 logger 的 `redactObject()`：深层内容必须还在
  const redactedAgain = redactObject({ respBody: body }) as { respBody: Record<string, unknown> }
  const text = JSON.stringify(redactedAgain)
  assert.ok(text.includes('最深处的值'), `logger 二次脱敏把深层内容塌掉了：${text}`)
  assert.ok(!text.includes('[deep]'), '标记过的产物不该再出现 [deep]')
  // 标记是非枚举的：JSON.stringify 看不到、deepEqual 也不受影响
  assert.ok(!JSON.stringify(body).includes('redacted'), '标记不得进 JSON')
})

test('🔴 可疑 3：token 的"长度信息"不许因为二次替换而失真', () => {
  const token = `WXXCX${'Ab3kZ9_x-y.'.repeat(6)}` // 71 字符
  const rec = summarizeResponseBody(JSON.stringify({ token }), { token })
  const text = JSON.stringify(rec.body)
  assert.ok(text.includes(`[masked len=${token.length}]`), `应当保留**真实长度** ${token.length}：${text}`)
  assert.ok(!text.includes('len=16'), '不该出现"长度被替换成掩码串长度"的失真（审计 可疑 3）')
})

test('可疑 2：unpack 不许对"规格负载层就是 body/obj/data"的正常响应误报 suspect', () => {
  // `selectSunRunStartConfiguration` 的规格就是 `body`：正常响应 ⇒ 必须 ok
  assert.equal(unpackNote({ status: '00', body: { sunrunStartFace: '0', sunrunPointRandom: '0' } }).status, 'ok')
  assert.equal(unpackNote({ code: '0', obj: { termList: [] } }).status, 'ok')
  assert.equal(unpackNote({ status: '00', data: { paperName: 'x' } }).status, 'ok', '只有 paperName 不算"任务藏在里面"（判据要窄）')
  // 真"多包一层"（审计现场）⇒ suspect
  const real = { status: '00', code: '0', data: { paperName: '研途健行', runPointList: [{ pointId: 'L1' }] }, sunrunTaskList: [{ pointId: 'L1' }] }
  assert.equal(unpackNote(real).status, 'suspect')
  assert.equal(unpackNote(real).hint, 'data.runPointList')
  // 信封里是**业务数组**而顶层没有 ⇒ suspect
  assert.equal(unpackNote({ status: '00', data: { records: [1, 2, 3] } }).status, 'suspect')
  // 顶层就是业务数组 ⇒ ok
  assert.equal(unpackNote({ status: '00', runPointList: [1, 2] }).status, 'ok')
})
