/**
 * 「成绩记录」三态 + 认领逻辑的单测（2026-10-07）
 *
 * 背景：本机记录在**每次结算**时就写一条（不看有没有真实提交），而用户把其中的绿色「有效」
 * 读成了服务端判定 —— 于是"一笔根本没提交的跑也显示有效"。修法见 `utils/mp/recordState.ts`：
 * 给记录打三态、真实提交成功后**按 `settledAtMs` 认领**并写回真实场次号与服务端判定。
 * 这里把那些规则钉死（尤其是"不许把本地预判冒充服务端结论"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyServerVerdict,
  claimRecordForRealSubmit,
  newLocalRecordId,
  recordDetailNote,
  recordSubmitState,
  recordSubmitStateLabel,
  recordVerdictIsAuthoritative,
  recordVerdictPrefix,
  setRecordDetailOk,
  type RecordLike,
} from '../../utils/mp/recordState.ts'

/** 夹具：本机记录的**最小形状**（`RecordLike` 带索引签名 ⇒ 允许逐条塞不同字段） */
const rec = (over: Record<string, unknown> = {}): RecordLike => ({
  scoreId: 'sunrunId2026100701',
  paperId: 'p1',
  runTime: '2026-10-07',
  scorePassType: 1,
  ...over,
})

test('newLocalRecordId：形状固定且互不相同（同一毫秒也不许撞）', () => {
  const a = newLocalRecordId(1000, 0.1)
  const b = newLocalRecordId(1000, 0.9)
  assert.match(a, /^local-[0-9a-z]+-[0-9a-z]{4}$/)
  assert.notEqual(a, b)
  assert.equal(newLocalRecordId(1000, 0.1), a, '同参数可复现（纯函数）')
})

test('三态识别：只认三个合法值，缺字段/垃圾值一律 unknown（旧数据不猜）', () => {
  assert.equal(recordSubmitState({ submitState: 'local' }), 'local')
  assert.equal(recordSubmitState({ submitState: 'submitted' }), 'submitted')
  assert.equal(recordSubmitState({ submitState: 'demo' }), 'demo')
  for (const bad of [{}, { submitState: '' }, { submitState: 'LOCAL' }, { submitState: 1 }, null, undefined]) {
    assert.equal(recordSubmitState(bad as never), 'unknown', `应是 unknown：${JSON.stringify(bad)}`)
  }
})

test('三态文案：用户可见且不含 markdown 标记', () => {
  const labels = [
    recordSubmitStateLabel({ submitState: 'submitted' }),
    recordSubmitStateLabel({ submitState: 'local' }),
    recordSubmitStateLabel({ submitState: 'demo' }),
    recordSubmitStateLabel({}),
  ]
  assert.deepEqual(labels, ['已真实提交', '仅本地结算', '演示', '未记录（旧数据）'])
  for (const s of labels) assert.ok(!/\*\*|`/.test(s), `不得含 markdown：${s}`)
})

test('判定的权威性：**只有"已真实提交"才允许当服务端结论**', () => {
  assert.equal(recordVerdictIsAuthoritative({ submitState: 'submitted' }), true)
  assert.equal(recordVerdictIsAuthoritative({ submitState: 'local' }), false)
  assert.equal(recordVerdictIsAuthoritative({ submitState: 'demo' }), false)
  assert.equal(recordVerdictIsAuthoritative({}), false, '旧数据也不能冒充服务端判定')
  assert.equal(recordVerdictPrefix({ submitState: 'submitted' }), '')
  assert.equal(recordVerdictPrefix({ submitState: 'local' }), '本地预判：')
})

test('轨迹状态文案：三态 + 旧数据各有各的说法', () => {
  assert.equal(recordDetailNote({ submitState: 'submitted', detailOk: true }), '轨迹已交')
  assert.equal(recordDetailNote({ submitState: 'submitted', detailOk: false }), '轨迹未交')
  assert.equal(recordDetailNote({ submitState: 'submitted' }), '轨迹未记录')
  assert.equal(recordDetailNote({ submitState: 'local' }), '未提交（无云端轨迹）')
  assert.equal(recordDetailNote({ submitState: 'demo' }), '演示数据不提交')
  assert.equal(recordDetailNote({}), '未记录（旧数据）')
})

test('认领：按 settledAtMs 精确命中那一条，写回真实场次号与轨迹状态', () => {
  const records = [
    rec({ settledAtMs: 111, submitState: 'local', localId: 'local-a' }),
    rec({ settledAtMs: 222, submitState: 'local', localId: 'local-b', scoreId: 'sunrunId2026100702' }),
  ]
  const { records: next, claimed } = claimRecordForRealSubmit(records, {
    settledAtMs: 222,
    scantronId: 'sunrunId202610072508',
    detailOk: true,
  })
  assert.equal(claimed, true)
  assert.equal(next[0]!.submitState, 'local', '没命中的那条不许动')
  assert.equal(next[0]!.scoreId, 'sunrunId2026100701')
  assert.equal(next[1]!.submitState, 'submitted')
  assert.equal(next[1]!.scoreId, 'sunrunId202610072508', '写回**真实**场次号（不再是本地生成的假号）')
  assert.equal(next[1]!.detailOk, true)
  assert.equal(records[1]!.submitState, 'local', '纯函数：不许改入参')
})

test('认领：认领不到（没有 settledAtMs / 对不上）⇒ 原样返回并如实报 claimed=false', () => {
  const records = [rec({ settledAtMs: 111, submitState: 'local' })]
  const noKey = claimRecordForRealSubmit(records, { scantronId: 'x' })
  assert.equal(noKey.claimed, false)
  assert.deepEqual(noKey.records, records)
  const miss = claimRecordForRealSubmit(records, { settledAtMs: 999, scantronId: 'x' })
  assert.equal(miss.claimed, false)
  assert.equal(miss.records[0]!.submitState, 'local', '认领不到就不许改任何一条（宁可不标，也不许标错）')
})

test('认领：只认领第一条命中的（同毫秒不可能有两条，但逻辑上要防重复）', () => {
  const records = [rec({ settledAtMs: 5, submitState: 'local' }), rec({ settledAtMs: 5, submitState: 'local' })]
  const { records: next } = claimRecordForRealSubmit(records, { settledAtMs: 5, scantronId: 'x', detailOk: false })
  assert.equal(next[0]!.submitState, 'submitted')
  assert.equal(next[1]!.submitState, 'local')
})

test('认领：不带 detailOk 时不写这个字段（别拿 undefined 覆盖已有值）', () => {
  const { records: next } = claimRecordForRealSubmit([rec({ settledAtMs: 7, submitState: 'local' })], {
    settledAtMs: 7,
    scantronId: 'x',
  })
  assert.equal('detailOk' in next[0]!, false)
})

test('轨迹结果可单独更新（补交成功后走这条）', () => {
  const records = [rec({ submitState: 'submitted', scoreId: 'a', detailOk: false }), rec({ submitState: 'submitted', scoreId: 'b', detailOk: false })]
  const next = setRecordDetailOk(records, 'b', true)
  assert.equal(next[0]!.detailOk, false)
  assert.equal(next[1]!.detailOk, true)
})

test('服务端判定写回：按场次号命中，并顺手把三态标成 submitted', () => {
  const records = [rec({ scoreId: 'sunrunId202610072508', submitState: 'submitted', scorePassType: 1 })]
  const next = applyServerVerdict(records, 'sunrunId202610072508', { scorePassType: 0, scorePassRemark: '里程不足' })
  assert.equal(next[0]!.scorePassType, 0)
  assert.equal(next[0]!.scorePassRemark, '里程不足')
  // 找不到就不改
  const same = applyServerVerdict(records, 'nope', { scorePassType: 0 })
  assert.equal(same[0]!.scorePassType, 1)
  // undefined 不许覆盖已有值
  const keep = applyServerVerdict(records, 'sunrunId202610072508', {})
  assert.equal(keep[0]!.scorePassType, 1)
})
