/**
 * 「今日该任务次数已达上限」的判据与文案（2026-10-07 用户要求：把这个状态显示对）
 *
 * 实测原话（厂商小程序后端，`getRunBegin` 阶段）：
 *   `status:"01" code:"1" msg:"该任务次数今日已达上限!"`
 * 判据要点：
 *  1. **必须"配额主体 + 到达上限"同时命中**才算（否则会把"次数不足""请重新登录"之类误判）；
 *  2. 文案必须**带上服务端原话**（用户要拿它核对/反馈），且**不是**"开跑失败"这种误导说法；
 *  3. 标记按**本地日期**判"是不是今天"（不能用 UTC 切日，否则东八区早上会提前/延后失效）；
 *  4. 坏数据一律安全降级（绝不抛）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dailyQuotaNotice,
  dailyQuotaProgressNote,
  isDailyQuotaReachedMessage,
  isQuotaMarkActive,
  localDateKey,
  parseQuotaMark,
  DAILY_QUOTA_KEY,
  type DailyQuotaMark,
} from '../../utils/mp/dailyQuota.ts'

test('配额判据：实测原话命中（含感叹号与前后空白）', () => {
  assert.equal(isDailyQuotaReachedMessage('该任务次数今日已达上限!'), true)
  assert.equal(isDailyQuotaReachedMessage('  该任务次数今日已达上限！  '), true)
  assert.equal(isDailyQuotaReachedMessage('今日次数已用完'), true)
  assert.equal(isDailyQuotaReachedMessage('今日名额已满，请明天再来'), true)
  assert.equal(isDailyQuotaReachedMessage('该任务次数今日已达上限'), true)
})

test('配额判据：**不许**把别的失败文案误判成配额已满', () => {
  for (const msg of [
    '',
    null,
    undefined,
    0,
    '提交成功',
    '暂无自由跑任务,请选择阳光跑!',
    '请重新登录',
    '网络超时，请检查网络',
    '入参路线id为空！',
    'GPS位置为空！',
    '次数不足', // 只有"配额主体"，没有"到达上限"
    '已达上限', // 只有"到达上限"，没有配额主体
  ]) {
    assert.equal(isDailyQuotaReachedMessage(msg), false, `不该命中：${String(msg)}`)
  }
})

test('配额文案：带服务端原话、说明不是本程序的问题、且不含 markdown 标记', () => {
  const text = dailyQuotaNotice('该任务次数今日已达上限!')
  assert.ok(text.includes('该任务次数今日已达上限!'), '必须原样带出服务端原话（用户要拿它核对/反馈）')
  assert.ok(text.includes('配额'), '必须说清这是"每日次数配额"，而不是本程序/报文的问题')
  assert.ok(!text.includes('开跑失败'), '不许再用"开跑失败"这种误导说法')
  assert.ok(!/\*\*|`|^#/m.test(text), '用户可见文案不得含 markdown 标记')
  // 服务端什么都没给时也要有一句默认原话，不能出现空的原话位
  const fallback = dailyQuotaNotice('')
  assert.ok(fallback.includes('该任务次数今日已达上限'), '空消息时给默认原话')
  assert.ok(!fallback.includes('原话：)'), '不允许出现"原话：）"这种空位')
})

test('配额清单文案：短、带原话、不含 markdown 标记', () => {
  const line = dailyQuotaProgressNote('该任务次数今日已达上限!')
  assert.ok(line.includes('该任务次数今日已达上限!'))
  assert.ok(line.length < 120, `清单里那一步要短（实际 ${line.length} 字）`)
  assert.ok(!/\*\*|`/.test(line))
})

test('日期键：按**本地**时区切日（不能用 UTC）', () => {
  // 用本地时间构造 ⇒ 与 TZ 无关：本地 00:05 必须算"当天"，而不是 UTC 的前一天
  assert.equal(localDateKey(new Date(2026, 9, 7, 0, 5, 0)), '2026-10-07')
  assert.equal(localDateKey(new Date(2026, 9, 7, 23, 59, 59)), '2026-10-07')
  assert.equal(localDateKey(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01')
  assert.equal(localDateKey(new Date(2026, 11, 31, 12, 0, 0)), '2026-12-31')
})

test('标记有效期：同一天 + 同一任务才算生效；跨天自动失效', () => {
  const mark: DailyQuotaMark = { date: '2026-10-07', paperId: 'sunrunTaskPaper-1', message: 'x' }
  const sameDay = new Date(2026, 9, 7, 21, 0, 0)
  const nextDay = new Date(2026, 9, 8, 8, 0, 0)
  assert.equal(isQuotaMarkActive(mark, 'sunrunTaskPaper-1', sameDay), true)
  assert.equal(isQuotaMarkActive(mark, 'sunrunTaskPaper-2', sameDay), false, '别的任务不能被这条标记挡住')
  assert.equal(isQuotaMarkActive(mark, 'sunrunTaskPaper-1', nextDay), false, '跨天必须自动失效')
})

test('标记有效期：记不下任务号时按"当前任务"算（宁可少挡，不可乱挡的反面——这里必须挡）', () => {
  const mark: DailyQuotaMark = { date: '2026-10-07', paperId: '', message: 'x' }
  assert.equal(isQuotaMarkActive(mark, 'any-task', new Date(2026, 9, 7, 12, 0, 0)), true)
  assert.equal(isQuotaMarkActive(mark, '', new Date(2026, 9, 7, 12, 0, 0)), true)
})

test('标记有效期：空值/坏数据一律 false（绝不抛）', () => {
  const now = new Date(2026, 9, 7, 12, 0, 0)
  assert.equal(isQuotaMarkActive(null, 't', now), false)
  assert.equal(isQuotaMarkActive(undefined, 't', now), false)
  assert.equal(isQuotaMarkActive({} as DailyQuotaMark, 't', now), false)
  assert.equal(isQuotaMarkActive({ date: '' } as DailyQuotaMark, 't', now), false)
})

test('解析落盘标记：正常往返；坏数据安全降级为 null', () => {
  const mark: DailyQuotaMark = { date: '2026-10-07', paperId: 'p1', message: '该任务次数今日已达上限!' }
  assert.deepEqual(parseQuotaMark(JSON.stringify(mark)), mark)
  for (const bad of ['', '{', 'null', '[]', '"abc"', '123', '{}', '{"paperId":"p1"}', undefined, null]) {
    assert.equal(parseQuotaMark(bad), null, `坏数据必须 null：${String(bad)}`)
  }
  // 缺字段的安全默认（date 在就必须给对象）
  assert.deepEqual(parseQuotaMark('{"date":"2026-10-07"}'), { date: '2026-10-07', paperId: '', message: '' })
})

test('localStorage 键名是契约（改名等于让"记住今天"失效）', () => {
  assert.equal(DAILY_QUOTA_KEY, 'mp_daily_quota_reached')
})
