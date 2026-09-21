/**
 * 早操签到「记录」的入参/归一化单测（2026-09-21）
 *
 * 这条修复的判据来自厂商源码 `getMorningData`，所以单测重点钉住**与厂商一致的字段口径**：
 * `stuNumber`（不是 snCode）、`monthId`（两位字符串）、`termId`；以及"坏数据不许把页面搞崩"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMornSignArchParams,
  mornSignStatusText,
  normalizeMornSignArch,
  recentMonthOptions,
  twoDigitMonth,
} from '../../utils/mp/mornSignArch.ts'

test('buildMornSignArchParams：字段名/月份口径必须与厂商一致（stuNumber + 两位 monthId）', () => {
  const p = buildMornSignArchParams({ snCode: '2021001234', termId: 'term_2026F', month: '9' })
  assert.deepEqual(p, { termId: 'term_2026F', stuNumber: '2021001234', monthId: '09' }, '个位数月份要补零')
  assert.equal(buildMornSignArchParams({ snCode: ' 1 ', termId: ' t ', month: '12' }).monthId, '12')
  assert.equal(buildMornSignArchParams({ snCode: ' 1 ', termId: ' t ', month: '12' }).stuNumber, '1')
  assert.ok(!('snCode' in p), '请求体里不能出现 snCode（厂商用的是 stuNumber）')
})

test('twoDigitMonth / recentMonthOptions：跨年也正确（1 月的上一个月是去年 12 月）', () => {
  assert.equal(twoDigitMonth(new Date(2026, 8, 21)), '09')
  const opts = recentMonthOptions(new Date(2026, 0, 15), 3) // 2026-01
  assert.deepEqual(
    opts.map((o) => o.value),
    ['01', '12', '11'],
  )
  assert.equal(opts[1]!.label, '2025 年 12 月', '跨年标签要带正确年份')
})

test('normalizeMornSignArch：正常返回 —— 统计 + 记录（新的在前）+ 今天是否已签', () => {
  const res = normalizeMornSignArch({
    completedTimes: '3',
    incompleteTimes: 1,
    requireNumber: 5,
    ifDayHasComSign: '1',
    scoreList: [
      { date: '2026-09-01', status: 1, pointName: '东操场' },
      { date: '2026-09-03', status: 0 },
      { date: '2026-09-02', status: 2 },
    ],
  })
  assert.equal(res.completed, 3)
  assert.equal(res.incomplete, 1)
  assert.equal(res.required, 5)
  assert.equal(res.todaySigned, true)
  assert.deepEqual(
    res.records.map((r) => r.date),
    ['2026-09-03', '2026-09-02', '2026-09-01'],
    '记录应按日期倒序',
  )
  assert.equal(res.records[1]!.statusText, '已签到（异常/补签）')
  assert.equal(res.records[2]!.statusText, '已签到')
})

test('normalizeMornSignArch：缺字段 / 坏数据都不许抛（页面要能显示"暂无记录"）', () => {
  for (const bad of [undefined, null, {}, { scoreList: null }, { scoreList: 'x' }, { completedTimes: 'abc' }]) {
    const r = normalizeMornSignArch(bad)
    assert.equal(r.records.length, 0)
    assert.equal(r.completed, 0)
    assert.equal(r.todaySigned, false)
  }
  // 列表里混入非对象项要被丢掉，而不是让 .date 取值抛错
  const mixed = normalizeMornSignArch({ scoreList: [null, 42, { date: '2026-09-05', status: 1 }] })
  assert.equal(mixed.records.length, 1)
  assert.equal(mixed.records[0]!.date, '2026-09-05')
  // 没有 date 的项也算无效（无法展示）
  assert.equal(normalizeMornSignArch({ scoreList: [{ status: 1 }] }).records.length, 0)
})

test('mornSignStatusText：0/1/2 有文案，未知数值原样显示（不假装知道）', () => {
  assert.equal(mornSignStatusText(0), '未签到')
  assert.equal(mornSignStatusText(1), '已签到')
  assert.equal(mornSignStatusText(2), '已签到（异常/补签）')
  assert.equal(mornSignStatusText(7), '状态 7')
})
