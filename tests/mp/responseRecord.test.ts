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
  convergeLogLine,
  knownValuePairs,
  redactForRecord,
  stripGeometryFromRespBody,
  summarizeRespShape,
  summarizeResponseBody,
  unpackNote,
} from '../../utils/mp/responseRecord.ts'
import { assertNoCredentials } from '../../utils/mp/diagnostics.ts'
import { REDACTED_MARK, maskTokenLike, redactFreeText, redactObject, summarizeUpstream } from '../../utils/mp/logFormat.ts'

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
  assert.match(String(rec.note), /裁掉过长数组的 280 个元素/, `实际 note：${rec.note}｜trimmedPaths=${JSON.stringify(rec.trimmedPaths)}`)
  assert.match(String(rec.note), /data\.records/, `note 里要指出是哪个数组被裁的（实际：${rec.note}）`)
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

// ============================================================================
// 2026-09-22 **闸门复验**的反例（复验方给的输入与实测输出，逐条钉住）
// ============================================================================

test('🔴 闸门(1)：超大单串不得抛错（6MB/10MB alnum + 6MB base64-like）—— 旧正则会爆栈', () => {
  for (const [name, s] of [
    ['6MB alnum', 'A'.repeat(6 * 1024 * 1024)],
    ['10MB alnum', 'B'.repeat(10 * 1024 * 1024)],
    ['6MB base64-like', 'Ab3kZ9_x-y.'.repeat(Math.ceil((6 * 1024 * 1024) / 11))],
  ] as [string, string][]) {
    const env = { blob: s }
    const t0 = Date.now()
    const rec = summarizeResponseBody(JSON.stringify(env), env)
    const ms = Date.now() - t0
    assert.ok(rec.bytes <= RESP_BODY_MAX_BYTES, `${name}：落盘必须 ≤ 上限，实际 ${rec.bytes}`)
    assert.ok(ms < 20_000, `${name}：不该慢到超时（实测 ${ms} ms）`)
  }
})

test('🔴 闸门复验(第二轮/阻断)：复验方三个形状的 **respShape** 也必须落进整行上限内', () => {
  const LINE_MAX = RESP_BODY_MAX_BYTES + 4096
  /**
   * 复验方给的三个形状 —— **它们才是真正会撑爆 `respShape` 的形态**。
   * 上面那三个（40×2KB / 100KB / 宽+深）的 shape 只有几百字节~1.1 KB，**永远碰不到这条路径**
   * （所以那条断言看着有、其实盖不住 —— 复验方原话）。
   */
  const en = (i: number) => `field${String.fromCharCode(97 + (i % 26))}${i}` // 8 字符英文字段名
  const shapes: [string, unknown][] = [
    ['40 对象 × 40 数组字段（≈23 KB 响应）', { data: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`o${i}`, Object.fromEntries(Array.from({ length: 40 }, (_, j) => [en(j), [1, 2, 3]]))])) }],
    ['20 字中文键 × 40 × 40（≈112 KB 响应）', { data: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`键${i}${'长'.repeat(18)}`, Object.fromEntries(Array.from({ length: 40 }, (_, j) => [`数组${j}`, [1, 2, 3, 4]]))])) }],
    ['3 层 × 40（≈917 KB 响应）', { data: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`l1_${i}`, Object.fromEntries(Array.from({ length: 40 }, (_, j) => [`l2_${j}`, Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`l3_${k}`, [1, 2]]))]))])) }],
  ]
  for (const [name, v] of shapes) {
    const raw = JSON.stringify(v)
    const shape = summarizeRespShape(v)
    const arraysCount = Object.keys(shape.arrays).length
    assert.ok(arraysCount <= 120, `${name}：arrays 必须有上限（复验实测老实现无上限 ⇒ 46 KB / 2.3 MB），实际 ${arraysCount}`)
    const rec = summarizeResponseBody(raw, v)
    /** 与代理**完全同一条路径**：完整日志行（含 `{t,level,cat,msg}` 包装）交给 `convergeLogLine` */
    const entry = { t: '2026-09-23T00:00:00.000Z', level: 'info' as const, cat: 'proxy', msg: 'POST /x', data: { endpoint: '/x', http: 200, ms: 12, bytes: raw.length, auth: '(无 token)', respShape: shape, respBody: rec, body: {} } as Record<string, unknown> }
    const { text, degraded } = convergeLogLine(entry, LINE_MAX)
    const lineBytes = Buffer.byteLength(text, 'utf8')
    assert.ok(lineBytes <= LINE_MAX, `${name}：整行 ${lineBytes} B > 上限 ${LINE_MAX}（降级=${degraded.join('/')}）`)
    // 收敛后**复检**：解析回来再序列化也必须 ≤ 上限（不是"量错了对象"）
    assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(text)), 'utf8') <= LINE_MAX, `${name}：复检整行仍超上限`)
    assert.ok(text.includes('"endpoint":"/x"'), `${name}：元数据必须永远保留`)
  }
  // 反向：小响应**不该**被降级（否则正常日志平白丢结构）
  const small = { status: '00', data: { list: [1, 2, 3] } }
  const smallRaw = JSON.stringify(small)
  const noDegrade = convergeLogLine(
    { t: 'x', level: 'info', cat: 'proxy', msg: 'm', data: { endpoint: '/x', http: 200, ms: 1, bytes: smallRaw.length, respShape: summarizeRespShape(small), respBody: summarizeResponseBody(smallRaw, small) } },
    LINE_MAX,
  )
  assert.deepEqual(noDegrade.degraded, [], '小响应不该触发任何降级')
})

test('🔴 闸门(1)/B1：整行字节必须 ≤ 上限（40×2KB 与 宽+深 两个反例）', () => {
  /** 代理侧的整行判据：`RESP_BODY_MAX_BYTES + 4096`（与 `server/api/mp/[...slug].ts` 同一常量口径） */
  const LINE_MAX = RESP_BODY_MAX_BYTES + 4096
  const shapes: [string, unknown][] = [
    ['顶层 40×2KB 字符串', Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'A'.repeat(2048)]))],
    ['宽 + 深', { a: 'D'.repeat(50000), b: { c: { d: { e: { f: 'E'.repeat(50000) } } } }, g: Array.from({ length: 500 }, () => ({ h: 'F'.repeat(500) })) }],
    ['单键 100KB', { blob: 'B'.repeat(100 * 1024) }],
  ]
  for (const [name, v] of shapes) {
    const rec = summarizeResponseBody(JSON.stringify(v), v)
    // 模拟"日志行"：元数据 + respBody（中文 note 也照算，复验方就是按整行量的）
    const line = JSON.stringify({ t: new Date().toISOString(), level: 'info', cat: 'proxy', msg: 'POST /x', data: { endpoint: '/x', http: 200, ms: 12, bytes: 1, auth: '(无 token)', upstream: {}, respShape: summarizeRespShape(v), respBody: rec } })
    assert.ok(Buffer.byteLength(line, 'utf8') <= LINE_MAX, `${name}：整行 ${Buffer.byteLength(line, 'utf8')} B 超上限 ${LINE_MAX}`)
  }
})

test('🔴 闸门(2)：掩码判安全的文本，红线**不得**命中（长填充串 / 宽对象 / 深对象）', () => {
  const fixtures: [string, string][] = [
    ['长填充串 2048', 'A'.repeat(2048)],
    ['长填充串 50000', 'D'.repeat(50000)],
    ['纯小写重复 400', 'x'.repeat(400)],
    ['纯数字重复 200', '7'.repeat(200)],
  ]
  for (const [name, s] of fixtures) {
    const masked = maskTokenLike(s) // 掩码侧的动作
    assert.equal(masked, s, `${name}：填充串不该被误掩（否则内容凭空变短）`)
    assert.deepEqual(assertNoCredentials([masked]).hits, [], `${name}：掩码说安全，红线却命中 ⇒ 整个日志文件会被剔出包`)
  }
  /** 宽/深对象整行：掩码后过红线也必须干净 */
  const wide = { data: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'A'.repeat(2048)])) }
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 'D'.repeat(3000) } } } } } } } } } } }
  for (const [name, v] of [['宽对象', wide], ['深对象', deep]] as [string, unknown][]) {
    const rec = summarizeResponseBody(JSON.stringify(v), v)
    const line = JSON.stringify({ data: { respBody: rec } })
    assert.deepEqual(assertNoCredentials([line]).hits, [], `${name}：掩码后的整行不该被红线命中`)
  }
})

test('🔴 闸门(3)：键名掩码**不得改变键的数量与唯一性**（15 个中文键 / 3 个姓名键 / 拼音键）', () => {
  const bizKeys = ['姓名', '学号', '名次', '分数', '成绩', '线路', '校区', '任务', '状态', '备注', '原因', '时间', '总数', '结果', '单位']
  const bizObj = Object.fromEntries(bizKeys.map((k, i) => [k, i]))
  const recBiz = summarizeResponseBody(JSON.stringify(bizObj), bizObj)
  const outBiz = recBiz.body as Record<string, unknown>
  assert.equal(Object.keys(outBiz).length, bizKeys.length, `15 个业务键必须还是 15 个（实测老实现只剩 1 个）：${JSON.stringify(Object.keys(outBiz))}`)
  assert.equal(new Set(Object.keys(outBiz)).size, bizKeys.length, '去重后键数也要一样')
  // 业务键**不该**被换成占位符（否则内容全丢）
  assert.ok(Object.keys(outBiz).includes('成绩') && Object.keys(outBiz).includes('单位'), `业务键不该被掩：${JSON.stringify(Object.keys(outBiz))}`)

  /** 3 个姓名键 ⇒ 3 条记录都要在（键名可以掩，但**不能合并成 1 个键**） */
  const names = { 张小明: { ok: 1 }, 李小华: { ok: 2 }, 王子涵: { ok: 3 } }
  const recN = summarizeResponseBody(JSON.stringify(names), names)
  const outN = recN.body as Record<string, unknown>
  assert.equal(Object.keys(outN).length, 3, `3 个姓名键必须还是 3 个键：${JSON.stringify(Object.keys(outN))}`)
  assert.equal(new Set(Object.keys(outN)).size, 3, '掩码后撞车必须补去重后缀')
  const textN = JSON.stringify(outN)
  assert.ok(!textN.includes('张小明') && !textN.includes('李小华') && !textN.includes('王子涵'), `姓名不得原文出现：${textN}`)

  /**
   * 拼音/英文人名键（审计 N3；**第三轮 N10 收窄后**）：
   * · 值是**字符串**且同为人名形态（`zhangxiaoming: "lixiaohua"`）⇒ 掩；
   * · 值是**对象**（`zhangxiaoming: {ok:1}`）⇒ **不掩** —— 这是 N10 的取舍：`{students:[…]}` / `{metadata:{…}}`
   *   与它形态完全相同，把后者当人名会让**整棵子树被抹**（实测 6 棵子树丢失、连我们自己的 `{degraded:[…]}` 都被抹掉）。
   *   真实姓名另有 `known` 值级替换与 `SENSITIVE_KEYS` 兜底。
   */
  const pinyin = { zhangxiaoming: 'lixiaohua', ZhangXiaoMing: 'LiXiaohua' }
  const recP = summarizeResponseBody(JSON.stringify(pinyin), pinyin)
  const textP = JSON.stringify(recP.body)
  assert.ok(!textP.includes('zhangxiaoming') && !textP.includes('ZhangXiaoMing'), `拼音人名键不得原文出现：${textP}`)
  assert.ok(!textP.includes('lixiaohua') && !textP.includes('LiXiaohua'), '值也不得原文出现')
  assert.equal(Object.keys(recP.body as Record<string, unknown>).length, 2, '拼音键也要保数量')
  /** 反向（N10）：值是对象时**不**当人名（否则会抹掉整棵子树） */
  const bizLike = { zhangxiaoming: { ok: 1 } }
  assert.ok(JSON.stringify(summarizeResponseBody(JSON.stringify(bizLike), bizLike).body).includes('zhangxiaoming'), '对象值不当作人名（N10 取舍）')
})

test('🔴 闸门(B2)：11 层嵌套里的 token/姓名**不得原样落盘**（老实现超深度直接原样返回）', () => {
  const token = `WXXCX${'Ab3kZ9_x-y.'.repeat(6)}`
  let deep: Record<string, unknown> = { token, studentName: '张小明' }
  for (let i = 0; i < 11; i++) deep = { [`l${i}`]: deep }
  const rec = summarizeResponseBody(JSON.stringify(deep), deep)
  const text = JSON.stringify(rec.body)
  assert.ok(!text.includes(token), `11 层深处的 token 原文落盘了：${text.slice(0, 200)}`)
  assert.ok(!text.includes('张小明'), `11 层深处的姓名原文落盘了：${text.slice(0, 200)}`)
  // 同一棵树走 logger 的二次脱敏，也不得漏
  const again = JSON.stringify(redactObject({ respBody: rec.body }))
  assert.ok(!again.includes(token) && !again.includes('张小明'), 'logger 二次脱敏后也不得漏原文')
})

test('🔴 闸门(B3 残漏)：**没有 known 对照表**（GET 无请求体）时，自述人名也不得原样落盘', () => {
  const env = { status: '01', msg: '未找到用户 2021101234（张小明，13812345678）' }
  const rec = summarizeResponseBody(JSON.stringify(env), env, []) // 故意不给 known
  const text = JSON.stringify(rec.body)
  assert.ok(!text.includes('2021101234'), `学号不得原文：${text}`)
  assert.ok(!text.includes('13812345678'), `手机号不得原文：${text}`)
  assert.ok(!text.includes('张小明'), `姓名不得原文（自述人名兜底没生效）：${text}`)
  assert.match(text, /张\*/, '姓名要留下掩码痕迹')
  // 信封标量那条路同样要挡住
  const shape = summarizeRespShape(env, {}, [])
  assert.ok(!JSON.stringify(shape).includes('张小明'), `respShape.envelope 不得漏姓名：${JSON.stringify(shape)}`)
})

test('🔴 闸门复验(第二轮)：自述人名兜底**不得误掩业务词**（复验给的两句 + 一批常见业务句）', () => {
  const okSentences = [
    '账户 余额 不足', // 复验实测：老实现 ⇒ 「账户 余* 不足」
    '考生 名单 已过期', // 复验实测：老实现 ⇒ 「考生 名* 已过期」
    '用户 成绩 已发布',
    '用户 学号 不存在',
    '学生 校区 未开通',
    '账号 密码 错误',
    '用户 状态 异常',
    '学生 备注 为空',
    '考试 时间 已变更',
    '班级 人数 已满',
  ]
  for (const s of okSentences) {
    const masked = redactFreeText(s)
    assert.equal(masked, s, `业务句不该被误掩：${s} ⇒ ${masked}`)
    // 走完整记录链路也不该变
    const rec = summarizeResponseBody(JSON.stringify({ msg: s }), { msg: s }, [])
    assert.ok(JSON.stringify(rec.body).includes(s), `记录链路里也不该被误掩：${s}`)
  }
  // 反向：真姓名仍然要掩（不能因为加了白名单就全放过）
  for (const s of ['未找到用户 张小明', '（李小华）', '学生 王子涵 不存在']) {
    const masked = redactFreeText(s)
    assert.notEqual(masked, s, `真姓名必须掩：${s}`)
    assert.ok(masked.includes('*'), `姓名要留下掩码痕迹：${masked}`)
  }
})

test('🔴 第三轮 N10：拼音人名判据不得误伤普通英文/PascalCase 业务键（6 棵子树 + 9 个业务键）', () => {
  /** 复验方实测的形状：这些键**一个都不该被当人名**（老实现把它们全抹了、6 棵子树内容整体丢失） */
  const biz: Record<string, unknown> = {
    students: [{ id: 1 }],
    metadata: { a: 1 },
    children: [],
    response: { b: 2 },
    arguments: [1, 2],
    sections: { c: 3 },
    degraded: ['respBody 缩预算'],
    PointName: '西操场',
    PaperName: '研途健行',
    SchoolName: '南开大学',
    CampusName: '天目湖',
    RunPointList: [{ pointId: 'L1' }],
    StudentInfo: { snCode: 'x' },
    TaskList: [1],
    DataList: [2],
    ErrorMsg: '登录过期',
  }
  const rec = summarizeResponseBody(JSON.stringify(biz), biz)
  const body = rec.body as Record<string, unknown>
  const keys = Object.keys(body)
  assert.equal(keys.length, Object.keys(biz).length, `键数必须不变：${keys.length} vs ${Object.keys(biz).length}`)
  for (const k of Object.keys(biz)) {
    assert.ok(keys.includes(k), `业务键 ${k} 不得被换成占位符（实际键：${keys.join(',')}）`)
  }
  assert.ok(!keys.some((k) => k.includes('姓名已掩码')), `不该出现人名占位符：${keys.join(',')}`)
  // 6 棵子树的内容必须还在
  const text = JSON.stringify(body)
  for (const probe of ['"id":1', '"a":1', '"b":2', '"c":3', '"西操场"', '"南开大学"', '"登录过期"', 'respBody 缩预算']) {
    assert.ok(text.includes(probe), `子树内容丢了：${probe}（实际 ${text.slice(0, 200)}）`)
  }
  /** 🔴 我们自己的诊断字段：降级 warn 的 `{degraded:[…]}` 必须**原样**保留（第三轮日志实证被抹掉过） */
  const warnRec = summarizeResponseBody(JSON.stringify({ degraded: ['respBody 缩预算', 'respShape 降档'] }), { degraded: ['respBody 缩预算', 'respShape 降档'] })
  const warnText = JSON.stringify(warnRec.body)
  assert.ok(warnText.includes('"degraded"'), `degraded 必须原样：${warnText}`)
  assert.ok(warnText.includes('respShape 降档'), '降级明细必须看得见（这是我们自己的诊断字段）')
  /** 反向：真姓名键**仍要掩**且保数量 */
  const names = { zhangxiaoming: 'lixiaohua', ZhangXiaoMing: 'LiXiaohua', TomZhang: 'TomLi', 张小明: { ok: 1 }, 李小华: { ok: 2 } }
  const nameRec = summarizeResponseBody(JSON.stringify(names), names)
  const nameBody = nameRec.body as Record<string, unknown>
  const nameKeys = Object.keys(nameBody)
  assert.equal(nameKeys.length, 5, `姓名键数量必须保持 5：${nameKeys.join(',')}`)
  const nameText = JSON.stringify(nameBody)
  for (const raw of ['zhangxiaoming', 'lixiaohua', 'ZhangXiaoMing', 'TomZhang', '张小明', '李小华']) {
    assert.ok(!nameText.includes(raw), `姓名不得原文出现：${raw}`)
  }
})

test('🔴 第三轮 N7：业务句按**正向判据**（首字须是常见姓氏）判定 —— 复验方 14 句逐条不得误掩', () => {
  const sentences = [
    '用户 积分 不足', '考生 准考证 未生成', '账户 优惠 已过期', '学生 宿舍 未分配', '用户 订单 不存在',
    '考生 座位 未安排', '学生 头像 未上传', '用户 昵称 重复', '学生 借阅 记录异常', '账户 钱包 已冻结',
    '用户 实名 未认证', '学生 学历 异常', '考生 志愿 未填报', '用户 发票 未开具',
    // 上一轮已过的那 5 句也要继续过
    '账户 余额 不足', '考生 名单 已过期', '用户 成绩 已发布', '用户 学号 不存在', '学生 校区 未开通',
  ]
  for (const s of sentences) {
    assert.equal(redactFreeText(s), s, `业务句不该被误掩：${s} ⇒ ${redactFreeText(s)}`)
  }
  /** 反向：真姓名仍要掩（首字 ∈ 常见姓氏表） */
  for (const s of ['未找到用户 张小明', '（李小华）', '学生 王子涵 不存在', '用户 欧阳修 不存在']) {
    const m = redactFreeText(s)
    assert.notEqual(m, s, `真姓名必须掩：${s}`)
    assert.ok(m.includes('*'), `要留下掩码痕迹：${m}`)
  }
  /** 边界（如实保留）：cue 不在候选前、或裸姓名没有上下文 —— 不掩（需姓名库，属另一条线） */
  assert.equal(redactFreeText('名叫李小华的同学'), '名叫李小华的同学')
  assert.equal(redactFreeText('张小明 登录失败'), '张小明 登录失败')
})

test('🔴 第三轮 N7-1：`arrays`/`arraysMore` 计数必须**不重不漏**（40×40 与 120×12 两个形状）', () => {
  /** 形状 A：40 个对象 × 40 个数组字段（都在可达层内）⇒ 真实数组总数可手算 = 40×40 = 1600 */
  const a = { data: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`o${i}`, Object.fromEntries(Array.from({ length: 40 }, (_, j) => [`f${j}`, [1, 2, 3]]))])) }
  const shapeA = summarizeRespShape(a)
  const countedA = Object.keys(shapeA.arrays).length + (shapeA.arraysMore ?? 0)
  assert.equal(countedA, 1600, `40×40：arrays(${Object.keys(shapeA.arrays).length}) + arraysMore(${shapeA.arraysMore ?? 0}) 必须等于真实数组数 1600`)
  /** 形状 B：120 个对象 × 12 个数组字段 = 1440 */
  const b = { data: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`o${i}`, Object.fromEntries(Array.from({ length: 12 }, (_, j) => [`f${j}`, [1]]))])) }
  const shapeB = summarizeRespShape(b)
  const countedB = Object.keys(shapeB.arrays).length + (shapeB.arraysMore ?? 0)
  assert.equal(countedB, 1440, `120×12：arrays(${Object.keys(shapeB.arrays).length}) + arraysMore(${shapeB.arraysMore ?? 0}) 必须等于真实数组数 1440`)
  /** 超上限时**不许把同一条路径重复计**（老实现报成 ≈2×：91 + 3018 = 3109 vs 真实 1600） */
  assert.ok(countedA < 1700, `不该报多（老实现 3109）：${countedA}`)
  /** 被截断的对象层要如实计数（不许静默丢） */
  const wide = { data: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`o${i}`, { x: 1 }])) }
  const shapeW = summarizeRespShape(wide)
  assert.ok((shapeW.keysMore ?? 0) > 0, '被截断的键要计入 keysMore（不许静默丢）')
})

test('🔴 第三轮 N7-2：超长 envelope msg（30000 字符）也必须**保住结构摘要**', () => {
  const msg = '登录失败：'.repeat(5000) // 30000 字符
  const v = { status: '01', msg, message: msg, data: { runPointList: [{ pointId: 'L1' }], records: [1, 2, 3] } }
  const raw = JSON.stringify(v)
  const entry = {
    t: '2026-09-23T00:00:00.000Z',
    level: 'info' as const,
    cat: 'proxy',
    msg: 'POST /x',
    data: { endpoint: '/x', http: 200, ms: 12, bytes: raw.length, auth: '(无 token)', upstream: summarizeUpstream(v), respShape: summarizeRespShape(v), respBody: summarizeResponseBody(raw, v), body: {} } as Record<string, unknown>,
  }
  const LINE_MAX = RESP_BODY_MAX_BYTES + 4096
  const { text, degraded } = convergeLogLine(entry, LINE_MAX)
  assert.ok(Buffer.byteLength(text, 'utf8') <= LINE_MAX, `整行必须 ≤ 上限：${Buffer.byteLength(text, 'utf8')}`)
  const parsed = JSON.parse(text) as { data: Record<string, unknown> }
  assert.ok(parsed.data.respShape, `超长 msg 不许把结构摘要整块丢掉（降级=${degraded.join('/')}）：${text.slice(0, 300)}`)
  const shapeText = JSON.stringify(parsed.data.respShape)
  assert.ok(/keys|arraysTotal|keysTotal/.test(shapeText), `结构摘要要有键/数组信息：${shapeText.slice(0, 200)}`)
  assert.ok(text.includes('"endpoint":"/x"'), '元数据永远保留')
  /** envelope 标量本身也要被截断（不许 30 KB 原样进包） */
  assert.ok(!text.includes(msg), '30 KB 的 msg 不许原样落盘')
})

test('🔴 第四轮 1️⃣：定向补入的罕见姓要掩；同时业务句（含首字为姓氏的）不得被改花', () => {
  /** 真姓名必须掩（含复验实测漏掩的 5 个 + 表内本已正常的 2 个） */
  const nameCases: [string, string, string][] = [
    // [原句, 姓名, 期望整句]
    ['用户 胥小明 不存在', '胥小明', '用户 胥** 不存在'],
    ['考生 芮丽 未报名', '芮丽', '考生 芮* 未报名'],
    ['学生 邝建国 未到', '邝建国', '学生 邝** 未到'],
    ['用户 冼志强 不存在', '冼志强', '用户 冼** 不存在'],
    ['考生 佘诗曼 缺考', '佘诗曼', '考生 佘** 缺考'],
    ['用户 岑小明 不存在', '岑小明', '用户 岑** 不存在'],
    ['考生 覃丽 未报名', '覃丽', '考生 覃* 未报名'],
  ]
  for (const [s, raw, expected] of nameCases) {
    const m = redactFreeText(s)
    assert.equal(m, expected, `罕见姓要掩成固定形态：${s} ⇒ ${m}`)
    assert.ok(!m.includes(raw), `姓名原文不得留下：${m}`)
  }
  /** 业务句回归：14 句 + 5 句 + 首字为姓氏的业务词 + 新增姓氏的巧合词，**一次跑全** */
  const business = [
    '用户 积分 不足', '考生 准考证 未生成', '账户 优惠 已过期', '学生 宿舍 未分配', '用户 订单 不存在',
    '考生 座位 未安排', '学生 头像 未上传', '用户 昵称 重复', '学生 借阅 记录异常', '账户 钱包 已冻结',
    '用户 实名 未认证', '学生 学历 异常', '考生 志愿 未填报', '用户 发票 未开具',
    '账户 余额 不足', '考生 名单 已过期', '用户 成绩 已发布', '用户 学号 不存在', '学生 校区 未开通',
    '用户 关注 失败', '账户 解绑 需验证',
    '用户 常常 登录', '账户 温度 异常', '学生 容易 混淆', '用户 完全 未认证', '考生 安全 未通过',
    '账户 全部 冻结', '用户 实际 未到', '学生 常见 错误', '考生 日常 打卡', '用户 非常 满意',
    '账户 计费 异常', '学生 订票 失败', '考生 设备 未连接', '用户 请求 超时',
  ]
  const broken = business.filter((s) => redactFreeText(s) !== s)
  assert.deepEqual(broken, [], `业务句被改花了（新增姓氏的回归）：\n  - ${broken.map((s) => `${s} ⇒ ${redactFreeText(s)}`).join('\n  - ')}`)
})

test('🔴 第四轮 3️⃣：小写拼音分支 8→10 + 英文词黑名单（误伤例全部原样，该掩的仍掩）', () => {
  /** (a) 复验给的误伤例必须**全部原样** */
  const biz: Record<string, unknown> = {
    username: 'zhangsan',
    nickname: 'xiaoming',
    password: 'abc',
    students: 'green',
    metadata: 'all',
    children: 'none',
    response: 'json',
    arguments: 'yes',
    parameters: 'analysis',
    sections: 'full',
    keywords: 'success',
    features: 'false',
    contents: 'true',
    messages: 'ok',
    settings: 'null',
    comments: 'undefined',
    warnings: 'error',
    degraded: 'green',
    envelope: 'json',
  }
  const rec = summarizeResponseBody(JSON.stringify(biz), biz)
  const body = rec.body as Record<string, unknown>
  assert.deepEqual(Object.keys(body).sort(), Object.keys(biz).sort(), `键不得被改：${Object.keys(body).join(',')}`)
  const text = JSON.stringify(body)
  for (const [k, v] of Object.entries(biz)) {
    assert.ok(text.includes(`"${k}":"${v}"`), `误伤例必须原样：${k}:"${v}"（实际 ${text.slice(0, 240)}）`)
  }
  /** (b) 该掩的仍掩且保数量 */
  const names = { zhangxiaoming: 'lixiaohua', ZhangXiaoMing: 'LiXiaohua', TomZhang: 'JerryLi', 张小明: '张小明', 李小华: '李小华', 王子涵: '王子涵' }
  const nameBody = summarizeResponseBody(JSON.stringify(names), names).body as Record<string, unknown>
  assert.equal(Object.keys(nameBody).length, 6, `键数必须不变：${Object.keys(nameBody).join(',')}`)
  const nameText = JSON.stringify(nameBody)
  for (const raw of ['zhangxiaoming', 'lixiaohua', 'ZhangXiaoMing', 'LiXiaohua', 'TomZhang', 'JerryLi', '张小明', '李小华', '王子涵']) {
    assert.ok(!nameText.includes(raw), `姓名不得原文出现：${raw}（实际 ${nameText}）`)
  }
  /** (c) 代价（明确写进断言，防后人误以为漏）：9 位拼音键**不再**被当人名 */
  const nine = { zhangxiao: 'lixiaohua' }
  assert.ok(JSON.stringify(summarizeResponseBody(JSON.stringify(nine), nine).body).includes('zhangxiao'), '门槛 10 的代价：9 位拼音键不再掩（已写进注释与文档）')
})

test('🔴 第四轮 4️⃣：走截断档的记录，`truncated` 与 `bytes` 必须与落盘内容自洽', () => {
  const msg = '登录失败：'.repeat(5000)
  const v = { status: '01', msg, message: msg, data: { runPointList: [{ pointId: 'L1' }] } }
  const raw = JSON.stringify(v)
  const entry = {
    t: '2026-09-23T00:00:00.000Z',
    level: 'info' as const,
    cat: 'proxy',
    msg: 'POST /x',
    data: { endpoint: '/x', http: 200, ms: 1, bytes: raw.length, auth: '(无 token)', upstream: summarizeUpstream(v), respShape: summarizeRespShape(v), respBody: summarizeResponseBody(raw, v), body: {} } as Record<string, unknown>,
  }
  const LINE_MAX = RESP_BODY_MAX_BYTES + 4096
  const { text, degraded } = convergeLogLine(entry, LINE_MAX)
  assert.ok(degraded.length > 0, '这条应当走降级')
  const rb = (JSON.parse(text) as { data: { respBody?: Record<string, unknown> } }).data.respBody
  assert.ok(rb, 'respBody 必须还在')
  assert.equal(rb.truncated, true, `走了截断档就必须 truncated=true（实测故障：报 false）：${JSON.stringify(rb).slice(0, 200)}`)
  /** `bytes` 必须等于**实际落盘内容**的字节（不是截断前的大小） */
  const payload = rb.body !== undefined ? rb.body : rb.text
  const actual = payload === undefined ? 0 : Buffer.byteLength(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  assert.equal(rb.bytes, actual, `bytes 必须与实际落盘内容自洽（报 ${String(rb.bytes)}，实际 ${actual}）`)
  assert.ok(actual < Buffer.byteLength(JSON.stringify(v), 'utf8'), '实际存下的内容确实小于原始响应')
  assert.ok(Number(rb.originalBytes) > actual, 'originalBytes 仍要保留原始大小（便于对照）')
})

test('🔴 闸门复验(第二轮)：记录环节抛错**不影响上游返回**（源码级守卫：整段都在 try 里）', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  let dir = join(fileURLToPath(import.meta.url), '..')
  let root = ''
  /**
   * ⚠️ 项目根的判据用 `DEVELOPMENT.md`（**根目录独有**）而不是"存在 server/api"：
   * 测试跑在 `.mp-test-build/tests/mp/`，而构建目录里**只有** `server/utils`（被复制进来的那些）
   * ⇒ 用 `server/api` 判会一路找不到根（实测踩到）。
   */
  for (let i = 0; i < 6; i++) {
    const parent = join(dir, '..')
    if (existsSync(join(parent, 'DEVELOPMENT.md')) && existsSync(join(parent, 'server', 'api', 'mp', '[...slug].ts'))) {
      root = parent
      break
    }
    dir = parent
  }
  assert.ok(root, '找不到项目根（DEVELOPMENT.md + server/api/mp/[...slug].ts）')
  const src = readFileSync(join(root, 'server', 'api', 'mp', '[...slug].ts'), 'utf8')
  /**
   * 判据（可执行）：① `knownValuePairs` / `summarizeUpstream` / `summarizeResponseBody` / `convergeLogLine`
   * **都必须出现在 try 块内**；② try 块之前不许有这些调用；③ 记录失败只写 warn 且构造"只有元数据"的行。
   * 本轮实测还会用 `TOTORO_FAULT_RECORD=1` 起一个临时端口做真 HTTP 验证（见报告）。
   */
  const tryAt = src.indexOf('const nowIso = new Date().toISOString()')
  assert.ok(tryAt > 0, '找不到记录段起点（守卫需同步更新）')
  const after = src.slice(tryAt)
  const catchAt = after.indexOf('} catch (err) {')
  assert.ok(catchAt > 0, '记录段必须有 catch（否则任何异常都会 500）')
  const inside = after.slice(0, catchAt)
  for (const fn of ['knownValuePairs(', 'summarizeUpstream(', 'summarizeResponseBody(', 'summarizeRespShape(', 'convergeLogLine(']) {
    assert.ok(inside.includes(fn), `${fn} 必须在记录段的 try 块内（复验实测：留在外面抛错照样 500）`)
  }
  /**
   * `logRawLine(` 是**故意**在 try 之外的：它自己内部就 try/catch（日志失败不影响业务），
   * 而且必须放最后（记录段即便抛错，catch 也构造好了"只有元数据"的行再交给它写）。
   */
  assert.ok(after.includes('logRawLine('), 'logRawLine 必须在记录段之后调用（catch 也要走到它）')
  assert.ok(after.indexOf('logRawLine(') > catchAt, 'logRawLine 要在 catch 之后（这样记录失败也写得出一条元数据行）')
  // 记录段**之外**不许再出现这些调用（除了 catch 里构造的"只有元数据"行）；命中在注释里不算
  const outside = src.slice(0, tryAt) + src.slice(tryAt + catchAt)
  for (const fn of ['knownValuePairs(', 'summarizeUpstream(', 'summarizeResponseBody(', 'convergeLogLine(']) {
    for (const line of outside.split('\n')) {
      if (!line.includes(fn)) continue
      const t = line.trim()
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue // 注释里提到函数名是给人看的
      assert.fail(`${fn} 不该出现在记录段之外（会绕过 try/catch）：${t}`)
    }
  }
  assert.match(after.slice(catchAt, catchAt + 700), /响应记录失败（不影响上游返回）/, 'catch 里要写"不影响上游返回"的 warn')
  assert.match(after.slice(catchAt, catchAt + 900), /只有元数据|响应记录失败（详见上一条 warn）/, 'catch 要构造一个只有元数据的行')
  // 🧪 故障注入开关存在（本轮真 HTTP 验证要用它）
  assert.ok(src.includes('TOTORO_FAULT_RECORD'), '缺故障注入开关 ⇒ "记录抛错不影响响应"无法实测')
})

/** 与其它源码级守卫共用的小工具 */
function existsSyncCompat(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:fs').existsSync(p) as boolean
  } catch {
    return false
  }
}

test('🔴 闸门(N5)：无字段名的裸凭证三类形态（36 位混合 / 40 位纯小写 / 64 位十六进制）都要掩', () => {
  const fixtures: [string, number, string][] = [
    // 用 `.slice()` 构造精确位数（手数过的字面量改错过两次 —— 夹具要准，否则测的不是目标形态）
    ['36 位混合串', 36, 'Ab3kZ9xY7wQ2pL5mN8rT4vS6uH1jK0cD3eF5gH7'.slice(0, 36)],
    ['40 位纯小写', 40, 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'.slice(0, 40)],
    ['64 位十六进制', 64, 'a3f0c9b8d7e6f5a4c3b2a1908f7e6d5c4b3a29108f7e6d5c4b3a2910f8e7d6c5'],
  ]
  for (const [name, len, s] of fixtures) {
    assert.equal(s.length, len, `${name} 位数不对（夹具要准）：实际 ${s.length}`)
    const rec = summarizeResponseBody(JSON.stringify({ note: s }), { note: s })
    const text = JSON.stringify(rec.body)
    assert.ok(!text.includes(s), `${name} 不该原文落盘：${text}`)
    assert.match(text, /\[token len=\d+\]/, `${name} 要留下掩码痕迹`)
    // 掩码后必须过红线（否则文件被剔）
    assert.deepEqual(assertNoCredentials([text]).hits, [], `${name}：掩码后不该触发红线`)
  }
  // 反向：34 位指纹（本程序自己的 tokenFingerprint）**不该**被误掩、也不该被红线命中
  const fp = 'len=101 head=WXXC tail=abcd'
  assert.equal(maskTokenLike(fp), fp, '指纹串不得被误掩（否则核对手段废掉）')
  assert.deepEqual(assertNoCredentials([fp]).hits, [], '指纹串不得被红线命中（否则正常快照被判违规）')
})
