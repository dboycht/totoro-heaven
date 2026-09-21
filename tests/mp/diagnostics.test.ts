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
  assertNoCredentials,
  diagManifestEntries,
  maskId,
  maskName,
  maskPhone,
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

test('diagnostics：常量口径（包内文件名 / 日志目录 / 天数与上限）', () => {
  assert.equal(DIAG_MANIFEST_NAME, 'manifest.json')
  assert.equal(DIAG_SNAPSHOT_NAME, 'snapshot.json')
  assert.equal(DIAG_LOG_DIR, 'logs')
  assert.equal(DIAG_LOG_DAYS, 3)
  assert.equal(DIAG_LOG_MAX_BYTES, 8 * 1024 * 1024)
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
