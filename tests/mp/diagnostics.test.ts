/**
 * `utils/mp/diagnostics.ts`（「一键诊断导出」的**唯一契约**）的单测 —— 2026-09-21 新增
 *
 * 覆盖三件事：
 * 1. 脱敏函数（`maskId` / `maskName` / `maskPhone` / `tokenFingerprint`）—— 它们决定"包里到底有没有原文"；
 * 2. `diagManifestEntries()` —— 界面"导出前预览"与服务端 `manifest.json` 的**同一份**清单；
 * 3. 🔴 `assertNoCredentials()` —— 红线判据本身。**必须有反向用例**：
 *    构造带 `Bearer xxx` 的文本 ⇒ 必须判命中；正常快照 ⇒ 必须不命中。
 *    （红线判据最怕"看起来在跑、其实永远返回 ok"，所以两个方向都要钉住。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DIAG_LOG_DAYS,
  DIAG_LOG_DIR,
  DIAG_LOG_MAX_BYTES,
  DIAG_MANIFEST_NAME,
  DIAG_SNAPSHOT_NAME,
  DIAG_TIMELINE_HEAD_KEEP,
  DIAG_TIMELINE_MAX,
  assertNoCredentials,
  diagManifestEntries,
  diagTimelineInWindow,
  diagWindowMatch,
  maskDigitRuns,
  maskId,
  maskName,
  maskPhone,
  readIncludeGeometryFlag,
  tokenFingerprint,
} from '../../utils/mp/diagnostics.ts'
import type { DiagSnapshot } from '../../utils/mp/diagnostics.ts'

test('diagnostics：maskId 保留前 2 后 2，短串整串打码', () => {
  assert.equal(maskId('2021001234'), '20******34')
  assert.equal(maskId('12345'), '12*45')
  assert.equal(maskId('1234'), '****')
  assert.equal(maskId(''), '')
  assert.equal(maskId(null), '')
  assert.equal(maskId(undefined), '')
})

test('diagnostics：maskName 只留姓（复姓/单字都安全）', () => {
  assert.equal(maskName('张三'), '张*')
  assert.equal(maskName('欧阳锋'), '欧**')
  assert.equal(maskName('李'), '李') // 单字无法再遮，保持原样
  assert.equal(maskName(''), '')
})

test('diagnostics：maskPhone 只留前 3 后 4（带分隔符也认）', () => {
  assert.equal(maskPhone('13812345678'), '138****5678')
  assert.equal(maskPhone('138-1234-5678'), '138****5678')
  assert.equal(maskPhone('123456'), '12**56') // 太短 ⇒ 退回 maskId 口径（前 2 后 2）
  assert.equal(maskPhone(''), '')
})

test('diagnostics：tokenFingerprint **绝不**包含 token 本体，只给长度 + 前 4 后 4', () => {
  const token = 'WXXCX' + 'Ab3+/='.repeat(18)
  const fp = tokenFingerprint(token)
  assert.ok(!fp.includes(token), '指纹里不能出现 token 本体')
  assert.match(fp, /^len=\d+ head=WXXC tail=.{4}$/)
  assert.ok(fp.includes(`len=${token.length}`))
  assert.equal(tokenFingerprint(''), '(无)')
  assert.equal(tokenFingerprint(null), '(无)')
})

/**
 * 🆕 2026-09-22：数字兜底掩码**必须放过窗口 id**（真实浏览器导出解包时实测抓到）。
 * 实测现场：时间线里那条 `开始记录诊断（服务端窗口 w-20260922-130240-c41da2…）` 被掩成
 * `w-20****22-130240-c41da2` ⇒ 与 manifest 里的窗口 id 对不上，证据链断了。
 */
test('diagnostics：maskDigitRuns —— 掩学号/手机号，但**放过窗口 id**（否则时间线与 manifest 对不上）', () => {
  assert.equal(maskDigitRuns('读到学生档案 2021101234'), `读到学生档案 ${maskId('2021101234')}`)
  assert.equal(maskDigitRuns('联系 13812345678'), `联系 ${maskPhone('13812345678')}`)
  assert.equal(
    maskDigitRuns('开始记录诊断（服务端窗口 w-20260922-130240-c41da2，接下来请按顺序复现问题）'),
    '开始记录诊断（服务端窗口 w-20260922-130240-c41da2，接下来请按顺序复现问题）',
    '窗口 id 里的 8 位日期段不得被当学号掩掉',
  )
  // 同一条文本里两者共存：窗口 id 原样、学号照掩
  assert.equal(maskDigitRuns('窗口 w-20260922-130240-c41da2 / 学号 2021101234'), `窗口 w-20260922-130240-c41da2 / 学号 ${maskId('2021101234')}`)
  // 反例：没有 `w-` 前缀的同样数字串**仍然要掩**（不能因为加了例外就把兜底放开）
  assert.equal(maskDigitRuns('编号 20260922-130240'), `编号 ${maskId('20260922')}-130240`)
})

test('diagnostics：常量口径（包内文件名 / 日志目录 / 天数与上限）', () => {
  assert.equal(DIAG_MANIFEST_NAME, 'manifest.json')
  assert.equal(DIAG_SNAPSHOT_NAME, 'snapshot.json')
  assert.equal(DIAG_LOG_DIR, 'logs')
  assert.equal(DIAG_LOG_DAYS, 3)
  assert.equal(DIAG_LOG_MAX_BYTES, 8 * 1024 * 1024)
  assert.equal(DIAG_TIMELINE_MAX, 300)
  assert.ok(DIAG_TIMELINE_HEAD_KEEP > 0 && DIAG_TIMELINE_HEAD_KEEP < DIAG_TIMELINE_MAX, '开头条数必须是 0 与上限之间的真分数')
})

/**
 * 🆕 2026-09-22：**按记录窗口过滤事件时间线**（issue #12 二次返工）。
 *
 * 旧口径是"只取最近 `DIAG_TIMELINE_MAX` 条"⇒ 长记录会把**最早**那段（含「开始记录」本身）挤掉。
 * 新口径：先按窗口时间过滤；超上限时保留**最早 `DIAG_TIMELINE_HEAD_KEEP` 条 + 最新若干条**并如实计入统计。
 */
test('diagnostics：diagTimelineInWindow —— 只留窗口内的条目，窗口外的计数（不是静默丢弃）', () => {
  const at = (s: string) => ({ at: s, level: 'info', cat: 'ui', text: s })
  const entries = [at('2026-09-22T09:59:00.000Z'), at('2026-09-22T10:00:00.500Z'), at('2026-09-22T10:01:00.000Z'), at('2026-09-22T10:05:00.000Z')]
  const start = Date.parse('2026-09-22T10:00:00.000Z')
  const end = Date.parse('2026-09-22T10:02:00.000Z')
  const { items, stats } = diagTimelineInWindow(entries, { startedAtMs: start, endedAtMs: end }, end, 300, 20)
  assert.deepEqual(
    items.map((i) => i.at),
    ['2026-09-22T10:00:00.500Z', '2026-09-22T10:01:00.000Z'],
    '窗口外的两条必须被剔除（含窗口开始前那条）',
  )
  assert.deepEqual(stats, { input: 4, inWindow: 2, outOfWindow: 2, unparsable: 0, droppedToCap: 0 })
})

test('diagnostics：diagTimelineInWindow —— 左边界留 1s 容差、**右边界严格**（实测修正：导出那条日志不许混进来）', () => {
  const at = (s: string) => ({ at: s, level: 'info', cat: 'ui', text: s })
  const start = Date.parse('2026-09-22T10:00:00.000Z')
  const end = Date.parse('2026-09-22T10:02:00.000Z')
  const entries = [
    at('2026-09-22T09:59:59.400Z'), // 开始前 0.6s：点按钮⇄服务端落窗口的往返 ⇒ 容差内，保留
    at('2026-09-22T10:00:00.100Z'),
    at('2026-09-22T10:02:00.000Z'), // 正好结束时刻 ⇒ 保留
    at('2026-09-22T10:02:01.200Z'), // 结束后 1.2s（「结束并导出」自己那条）⇒ 必须剔除
  ]
  const { items, stats } = diagTimelineInWindow(entries, { startedAtMs: start, endedAtMs: end }, end, 300, 20)
  assert.deepEqual(
    items.map((i) => i.at),
    ['2026-09-22T09:59:59.400Z', '2026-09-22T10:00:00.100Z', '2026-09-22T10:02:00.000Z'],
    '右边界的容差必须为 0：窗口封存之后发生的事明确不属于这一段记录',
  )
  assert.equal(stats.outOfWindow, 1)
  assert.equal(stats.inWindow, 3)
})

test('diagnostics：diagTimelineInWindow —— 仍在记录时右边界取"此刻"；坏时间戳单列计数并剔除', () => {
  const entries = [
    { at: '2026-09-22T10:00:30.000Z', level: 'info', cat: 'ui', text: 'a' },
    { at: '（没有时间戳）', level: 'info', cat: 'ui', text: 'b' },
    { at: '2026-09-22T10:09:00.000Z', level: 'info', cat: 'ui', text: 'c' },
  ]
  const start = Date.parse('2026-09-22T10:00:00.000Z')
  // 窗口仍在记录（endedAtMs = 0）⇒ 右边界用传进来的"此刻" 10:05
  const now = Date.parse('2026-09-22T10:05:00.000Z')
  const { items, stats } = diagTimelineInWindow(entries, { startedAtMs: start, endedAtMs: 0 }, now, 300, 20)
  assert.deepEqual(items.map((i) => i.text), ['a'], '未来那条（10:09 > 此刻）要被挡掉')
  assert.equal(stats.unparsable, 1, '解析不出时间的条目要**单独计数**（便于以后发现"时间戳换了写法"）')
  assert.equal(stats.outOfWindow, 1)
})

test('diagnostics：diagTimelineInWindow —— 没有窗口时不过滤（退回旧口径），但同样受上限约束', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ at: new Date(Date.parse('2026-09-22T10:00:00.000Z') + i * 1000).toISOString(), level: 'info', cat: 'ui', text: `#${i}` }))
  const { items, stats } = diagTimelineInWindow(many, null, Date.now(), 300, 20)
  assert.equal(stats.input, 400)
  assert.equal(stats.inWindow, 400, '没有窗口 ⇒ 全部算"在窗口内"（服务端据此在 manifest 里写明"未按窗口过滤"）')
  assert.equal(stats.outOfWindow, 0)
  assert.equal(items.length, 300, '上限照旧生效（宁可少给也不能让包爆掉）')
  assert.equal(stats.droppedToCap, 100)
})

test('diagnostics：diagTimelineInWindow —— 超上限时保留**最早 20 条 + 最新 280 条**（开头那段是定位问题的关键）', () => {
  const many = Array.from({ length: 350 }, (_, i) => ({ at: `2026-09-22T10:00:${String(i).padStart(2, '0')}.000Z`, level: 'info', cat: 'ui', text: `#${i}` }))
  const { items, stats } = diagTimelineInWindow(many, null, Date.now(), 300, 20)
  assert.equal(items.length, 300)
  assert.deepEqual(items.slice(0, 3).map((i) => i.text), ['#0', '#1', '#2'], '开头必须保住（含「开始记录」那一条，旧口径恰恰丢掉它）')
  assert.equal(items[19]!.text, '#19')
  assert.equal(items[20]!.text, '#70', '中间那段让位：从"总数-尾部"处接上，20 + 280 = 300')
  assert.equal(items[299]!.text, '#349', '末尾一条永远在（最新发生的事也在）')
  assert.equal(stats.droppedToCap, 50)
  // 上限本身也要健壮：0 条上限 = 什么都不给，而不是抛错或全给
  assert.equal(diagTimelineInWindow(many, null, Date.now(), 0, 20).items.length, 0)
})

test('diagnostics：diagManifestEntries —— 传了窗口就在清单里**明写窗口 id 与起止时间**', () => {
  const win = { id: 'w-20260922-101500-ab12cd', startedAt: '2026-09-22T02:15:00.000Z', endedAt: '2026-09-22T02:20:00.000Z' }
  const entries = diagManifestEntries({ logNames: ['app-2026-09-22.log'], includeGeometry: true, logNote: '本次只收录记录窗口内的日志行（保留 12 行）', window: win })
  const winEntry = entries.find((e) => e.name === '(记录窗口)')
  assert.ok(winEntry, '有窗口就必须有一条「(记录窗口)」说明 —— 维护者要能一眼看出这个包只覆盖哪一段')
  assert.match(winEntry!.note, /w-20260922-101500-ab12cd/)
  assert.match(winEntry!.note, /2026-09-22T02:15:00\.000Z/)
  assert.match(winEntry!.note, /2026-09-22T02:20:00\.000Z/)
  const logEntry = entries.find((e) => e.name === `${DIAG_LOG_DIR}/app-2026-09-22.log`)!
  assert.match(logEntry.note, /本次只收录记录窗口内的日志行/, 'logNote 要拼进日志条目的说明')
  // 不传窗口 ⇒ 没有那一条（老调用方/老快照路径不变）
  assert.equal(diagManifestEntries({ logNames: [], includeGeometry: true }).find((e) => e.name === '(记录窗口)'), undefined)
})

test('diagnostics：diagManifestEntries 用 `logs/` 前缀列出日志，并说明是否含坐标', () => {
  const entries = diagManifestEntries({ logNames: ['app-2026-09-21.log', 'app-2026-09-20.log'], includeGeometry: true })
  const names = entries.map((e) => e.name)
  assert.deepEqual(names.slice(0, 2), [DIAG_MANIFEST_NAME, DIAG_SNAPSHOT_NAME])
  assert.deepEqual(names.slice(2, 4), [`${DIAG_LOG_DIR}/app-2026-09-21.log`, `${DIAG_LOG_DIR}/app-2026-09-20.log`])
  assert.ok(entries.every((e) => e.note.length > 0), '每条都要有人话说明（界面要直接展示）')
  const geom = entries[entries.length - 1]!.note
  assert.match(geom, /包含你描过的跑道与任务的坐标/)

  const noGeom = diagManifestEntries({ logNames: [], includeGeometry: false })
  assert.match(noGeom[noGeom.length - 1]!.note, /不含跑道\/任务的坐标/)
  assert.ok(noGeom.every((e) => !e.name.includes(DIAG_LOG_DIR)), '没有日志时不该列出日志条目')
})

/** 一份"正常"的快照（全部字段已脱敏，理应**不**命中红线） */
function sampleSnapshot(): DiagSnapshot {
  return {
    collectedAt: '2026-09-21 10:30:00',
    collectedAtMs: Date.parse('2026-09-21T10:30:00+08:00'),
    appVersion: '1.2.4',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    route: '/run',
    session: {
      hasToken: true,
      tokenFingerprint: tokenFingerprint('WXXCX' + 'Ab3+/='.repeat(18)),
      baseUrl: 'https://wxxcx.xtotoro.com',
      schoolCode: '1001',
      schoolName: '某大学',
      campusId: 'c-1',
      campusName: '东校区',
      snCode: maskId('2021001234'),
      studentName: maskName('张三'),
    },
    task: {
      present: true,
      summary: {
        paperId: 'p-1',
        paperName: '阳光跑',
        taskName: '2026 秋季',
        km: 2,
        fitDegreeThreshold: 60,
        validFrom: '2026-09-01',
        validTo: '2026-12-31',
        runPointListCount: 3,
      },
      lines: [{ pointId: 'pt-1', pointName: '1 号线', pointCount: 42, taskId: 't-1', campusName: '东校区' }],
      raw: { runPointList: [{ pointId: 'pt-1' }], note: '原始任务 JSON' },
    },
    trackLibrary: {
      count: 1,
      includeGeometry: true,
      entries: [{ lineId: 'pt-1', lineName: '1 号线', outerPoints: 10, innerPoints: 8, createdAt: '2026-09-20', hasStartPoint: true }],
    },
    gate: { allow: true, reason: '可提交', blockedBy: '', switches: { night: false }, cameraFlag: null, cameraFlagLineId: '', cameraFlagError: '' },
    timeline: [{ at: '2026-09-21T10:29:00+08:00', level: 'info', cat: 'ui', text: '点击「开始跑步」' }],
  }
}

test('🔴 红线：正常快照（含掩码后的账号与 token 指纹）**不得**被判命中', () => {
  const snap = sampleSnapshot()
  const verdict = assertNoCredentials([JSON.stringify(snap, null, 2)])
  assert.deepEqual(verdict.hits, [], `正常快照不该命中红线，却命中：${verdict.hits.join('、')}`)
  assert.equal(verdict.ok, true)
})

test('🔴 红线（反向用例）：带 `Bearer xxx` 的文本**必须**被判命中', () => {
  /**
   * ⚠️ 这里的假 token 必须写成 **base64url 样式的长串**（`[A-Za-z0-9._-]` 连续 ≥16 位）——
   * 第一版直接复用了 `logger.test.ts` 的假 token（`'WXXCX' + 'Ab3+/='.repeat(n)`），
   * 里面 `+` `/` `=` 会把字符连续段切碎（最长连续段只有 8 位）⇒ 正则**正确地**不命中，
   * 于是"红线不拦"这个**假警报**反而把真正的判据掩盖了（实测踩到，特意留注）。
   */
  const bearerToken = `WXXCX${'Ab3kZ9_x-y.'.repeat(6)}` // 113 字符，无 `+`/`/`/`=` 隔断
  const leaked = `POST /api/mp/GetStudentInfoByToken\nAuthorization: Bearer ${bearerToken}\n`
  const verdict = assertNoCredentials([leaked])
  assert.equal(verdict.ok, false, '含 Bearer 凭证的文本必须判命中（否则红线形同虚设）')
  assert.ok(verdict.hits.includes('Bearer 凭证'), `命中原因里要有「Bearer 凭证」，实际：${verdict.hits.join('、')}`)
})

test('🔴 红线（反向用例）：JWT 样式 / token 字段明文 / token= 查询串 三类都必须命中', () => {
  const jwtLike = `{"msg":"上游返回 ${'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'}.${'cGF5bG9hZGF0YQ'}.${'c2lnbmF0dXJl'}"}`
  const tokenField = `{"token":"${'A'.repeat(24)}"}`
  const tokenQuery = `GET /api/mp/GetRunBegin?token=${'B'.repeat(24)}`
  assert.ok(assertNoCredentials([jwtLike]).hits.includes('JWT 样式串'))
  assert.ok(assertNoCredentials([tokenField]).hits.includes('token 字段明文'))
  assert.ok(assertNoCredentials([tokenQuery]).hits.includes('token= 查询串'))
  // 多段文本一起过时，命中原因要**去重**（否则错误信息会刷一长串同样的类别）
  const merged = assertNoCredentials([jwtLike, jwtLike, tokenField])
  assert.equal(merged.hits.length, new Set(merged.hits).size)
})

test('🔴 红线：短串 / 掩码标记 / 空文本都不算命中（不能把正常日志误判成凭证）', () => {
  assert.equal(assertNoCredentials([]).ok, true)
  assert.equal(assertNoCredentials(['']).ok, true)
  assert.equal(assertNoCredentials(['Authorization: Bearer 短']).ok, true) // 太短，不像真凭证
  assert.equal(assertNoCredentials(['{"token":"[masked len=40]"}, token=[token len=40]']).ok, true)
  assert.equal(assertNoCredentials(['日志：端点 /api/mp/GetRunBegin，耗时 312ms']).ok, true)
})

/**
 * 🆕 2026-09-22（审计 B2/B4）：窗口一致性判据是**服务端 409 闸门**与**界面导出前自检**共用的纯函数。
 * 两处各写一遍迟早漂移（一严一松就是漏洞），所以这里把三态逐条钉住。
 */
test('diagnostics：diagWindowMatch —— 一致放行；不一致分"没窗口/被换掉/重启过"三种（服务端与界面共用）', () => {
  const I1 = '1790053310004-e3138b9cc94e1995'
  const I2 = '1790054000000-abcdefabcdefabcd'
  // 一致（含"客户端没声称窗口"= 老前端 ⇒ 放行，让服务端走无窗口兜底路径）
  assert.equal(diagWindowMatch({ clientWindowId: 'w-1', respondedWindowId: 'w-1', serverInstanceId: I1 }), null)
  assert.equal(diagWindowMatch({ clientWindowId: '', respondedWindowId: 'w-9', serverInstanceId: I1 }), null, '客户端没声称窗口 ⇒ 不该拦（老前端兼容）')
  // 服务端压根没有窗口
  assert.deepEqual(diagWindowMatch({ clientWindowId: 'w-1', respondedWindowId: '', serverInstanceId: I1 }), {
    reason: 'unreported',
    detail: '服务端现在没有记录窗口（这次运行没点过「开始记录」，或它已被清掉）',
  })
  // 窗口被换成另一个（同一实例内：另一个标签页点了开始记录）
  const overwritten = diagWindowMatch({ clientWindowId: 'w-1', respondedWindowId: 'w-2', serverInstanceId: I1, reportedInstanceId: I1 })
  assert.equal(overwritten?.reason, 'overwritten')
  assert.match(overwritten!.detail, /w-2/)
  // 换了进程实例（EXE/dev 重启）⇒ 提示语要说"重启过"，而不是"被换掉"
  const restarted = diagWindowMatch({ clientWindowId: 'w-1', respondedWindowId: 'w-2', serverInstanceId: I2, reportedInstanceId: I1 })
  assert.equal(restarted?.reason, 'instance-changed', '实例变了要优先按"重启过"报（对用户更贴切）')
  assert.match(restarted!.detail, /重启/)
  // 界面没见过实例（老前端）⇒ 只按 id 判，仍要拦住
  assert.equal(diagWindowMatch({ clientWindowId: 'w-1', respondedWindowId: 'w-2', serverInstanceId: I1, reportedInstanceId: '' })?.reason, 'overwritten')
})

/**
 * 🔴 2026-09-22（终检审计 B2）：**响应头核对必须用"快照采集那一刻"的实例号**，
 * 不能把同一个 ref（"此刻"的实例号）同时喂给两个语义不同的参数 ——
 * 那样 `reportedInstance !== instance` 恒假，"本程序重启过"这句提示永远说不出来。
 *
 * 这一条把组件里那个**具体调用形状**钉住（组件无法做单测，所以在契约层验判据输入）：
 *   · 正确写法（快照里的历史实例 A vs 此刻的实例 B）⇒ `instance-changed`，文案必须含"重启"；
 *   · 旧写法（两个参数都传"此刻"）⇒ 只会得到 `overwritten`（即旧 bug 的表现）。
 */
test('diagnostics：重启场景下 diagWindowMatch 必须说"重启过"（审计 B2：两个参数不许喂同一个值）', () => {
  const instA = '1790052405348-872f9ed134b37830' // 采集快照那一刻的实例
  const instB = '1790053310004-e3138b9cc94e1995' // 服务端重启后的新实例
  const base = { clientWindowId: 'w-1', respondedWindowId: 'w-2' }
  // ✅ 正确：reportedInstanceId = 快照里的历史值
  const good = diagWindowMatch({ ...base, serverInstanceId: instB, reportedInstanceId: instA })
  assert.equal(good?.reason, 'instance-changed')
  assert.match(good!.detail, /重启/, '文案必须明确说"本程序重启过"')
  // ❌ 旧写法：同一个值喂两个参数 ⇒ 永远只能是 overwritten
  const bad = diagWindowMatch({ ...base, serverInstanceId: instB, reportedInstanceId: instB })
  assert.equal(bad?.reason, 'overwritten', '这是旧实现的表现（判据退化成"窗口被换掉"）—— 组件已改成传快照里的历史值')
  // 窗口 id 一致时无论如何都放行（把"放行条件"钉住）
  assert.equal(diagWindowMatch({ clientWindowId: 'w-1', respondedWindowId: 'w-1', serverInstanceId: instB, reportedInstanceId: instA }), null)
})

/**
 * 🆕 2026-09-22（审计 B6）：坐标开关**只认显式布尔**，不许 fail-open。
 * 判据：`{}` / `{"includeGeometry":0}` / `"false"` 都**不算"关闭坐标"**。
 */
test('diagnostics：readIncludeGeometryFlag —— 只认显式布尔；空体/字符串/数字都不许被当成"包含坐标"', () => {
  assert.deepEqual(readIncludeGeometryFlag({ includeGeometry: true }), { kind: 'ok', value: true })
  assert.deepEqual(readIncludeGeometryFlag({ includeGeometry: false }), { kind: 'ok', value: false })
  assert.deepEqual(readIncludeGeometryFlag({}), { kind: 'missing' }, '空体 ⇒ 交给调用方决定（PATCH 会 400；start 用默认值）')
  assert.deepEqual(readIncludeGeometryFlag(null), { kind: 'missing' })
  assert.deepEqual(readIncludeGeometryFlag([]), { kind: 'missing' })
  // 🔴 这三条就是原 bug 的触发写法：以前全都会被判成 true（隐私开关被无声打开）
  assert.deepEqual(readIncludeGeometryFlag({ includeGeometry: 'false' }), { kind: 'invalid', got: '字符串 "false"' })
  assert.deepEqual(readIncludeGeometryFlag({ includeGeometry: 0 }), { kind: 'invalid', got: 'number' })
  assert.equal(readIncludeGeometryFlag({ includeGeometry: 1 }).kind, 'invalid')
  assert.equal(readIncludeGeometryFlag({ includeGeometry: null }).kind, 'invalid')
})

/**
 * 🔴 2026-09-22（独立审计 B3 实测反例）：判据原先只在**原始 JSON 文本**上跑，
 * 而 JSON 里引号是 `\"`、制表符是 `\t` ⇒ **被转义进 JSON 的凭证全部漏网**（红线形同虚设）。
 * 这一条直接用审计给的那串把修复钉死。
 */
test('🔴 红线（审计 B3 反例）：**被 JSON 转义**的 token 字段 / Bearer 也必须命中', () => {
  const token34 = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7' // 34 位
  const escapedTokenField = `{"timeline":[{"text":"body={\\"token\\":\\"${token34}\\"}"}]}`
  assert.equal(escapedTokenField.includes('"token":"'), false, '前提：原文里没有未转义的 “token”:” 形态（所以旧判据必然漏）')
  const verdict = assertNoCredentials([escapedTokenField])
  assert.equal(verdict.ok, false, '转义后的 token 字段明文必须被判命中（否则红线形同虚设）')
  assert.ok(verdict.hits.includes('token 字段明文'), `命中原因要有「token 字段明文」，实际：${verdict.hits.join('、')}`)

  // 转义的控制字符同样不许成为漏网通道：`Bearer\t<长串>` / `Bearer\n<长串>`
  const bearerWithTab = `日志：Authorization: Bearer\\t${'Ab3kZ9_x-y.'.repeat(6)}`
  assert.ok(assertNoCredentials([bearerWithTab]).hits.includes('Bearer 凭证'), 'Bearer 后跟转义制表符也要命中')
  const bearerWithNewline = `日志：Bearer\\n${'Ab3kZ9_x-y.'.repeat(6)}`
  assert.ok(assertNoCredentials([bearerWithNewline]).hits.includes('Bearer 凭证'), 'Bearer 后跟转义换行也要命中')

  // 反向：正常文本（含被掩码的记号）不得因为"多跑一遍还原"就变成命中
  assert.equal(assertNoCredentials(['{"token":"[masked len=40]"}']).ok, true)
  assert.equal(assertNoCredentials([`{"note":"长度 34 的字符串 ${token34}"}`]).ok, true, '没有 token 字段名就不该判命中')
})

/**
 * 🆕 2026-09-22（审计 B5）：`diagManifestEntries()` 的 note 会**原样渲染到界面**，
 * 所以**运行期生成的文案也要有人守**（`uiText.test.ts` 只扫 `.vue` 模板字面量，插值出来的逃得过）。
 */
test('用户可见文本：diagManifestEntries 生成的每条 note 都不许含 markdown 成对星号', () => {
  const BOLD_CN = /\*\*[^*\n]*[\u4e00-\u9fa5][^*\n]*\*\*/g
  const cases = [
    diagManifestEntries({ logNames: ['app-2026-09-22.log'], includeGeometry: true }),
    diagManifestEntries({ logNames: [], includeGeometry: false }),
    diagManifestEntries({
      logNames: ['app-2026-09-21.log'],
      includeGeometry: true,
      logNote: '本次只收录记录窗口内的日志行（共保留 12 行）',
      window: { id: 'w-20260922-130240-c41da2', startedAt: '2026-09-22T05:02:40.001Z', endedAt: '2026-09-22T05:02:52.187Z' },
    }),
    diagManifestEntries({ logNames: [], includeGeometry: false, window: { id: 'w-x', startedAt: 'a', endedAt: '' } }),
  ]
  const bad: string[] = []
  for (const entries of cases) {
    for (const e of entries) {
      for (const m of e.note.matchAll(BOLD_CN)) bad.push(`${e.name}: ${m[0]}`)
      if (e.note.includes('`')) bad.push(`${e.name}: 反引号 -> ${e.note.slice(0, 40)}`)
    }
  }
  assert.deepEqual(bad, [], `清单文案里有 markdown（用户会看到字面星号）：\n  - ${bad.join('\n  - ')}`)
})
