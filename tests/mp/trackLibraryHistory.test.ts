/**
 * 路线库「编辑留痕」与「起跑点字段」的纯逻辑测试（2026-09-20，1.1.12 需求②③）
 *
 * 用户原话："路径记录相关管理界面做好一点，记录编辑保存时间以及编辑使用的版本等一系列数据"。
 * 这里钉住三件事：
 *   ① **旧数据不能被凭空改写**（没存过 `start` / `history` / `editCount` 的老条目，
 *      归一化后仍然"没有这些字段"，界面显示"未记录（旧数据）"而不是编一个值出来）；
 *   ② 编辑历史**有上限**（localStorage 有配额，条目里有几百个点，历史不能无限长）；
 *   ③ 摘要/详情的措辞是**纯函数的输出**（界面不再自己拼字符串，避免两处口径漂移）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TRACK_HISTORY_MAX,
  entryDetailRows,
  entrySummaryText,
  historyLogText,
  normalizeHistory,
  normalizeLibrary,
  normalizeTrackStart,
  prependHistory,
  saveSummaryText,
  startSummaryText,
  versionText,
  type TrackEditLog,
  type TrackRouteEntry,
} from '../../utils/mp/trackLibrary.ts'

const CENTER = { latitude: 31.37, longitude: 119.48 }
const mLat = 111320
const mLng = 111320 * Math.cos((CENTER.latitude * Math.PI) / 180)
const circle = (r: number, n = 12) =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return {
      latitude: CENTER.latitude + (r * Math.sin(a)) / mLat,
      longitude: CENTER.longitude + (r * Math.cos(a)) / mLng,
    }
  })

const base: TrackRouteEntry = {
  lineId: 'L1',
  lineName: '西操场',
  outer: circle(100),
  inner: circle(90),
  createdAt: '2026-09-17T13:00:00.000Z',
  appVersion: '1.1.7',
  laneNo: 3,
  laneCount: 6,
}

test('normalizeTrackStart：偏移必须是非负有限数；direction 只认 reverse；坐标统一成数字', () => {
  const ok = normalizeTrackStart({ offsetM: 12.34, direction: 'reverse', point: { latitude: '31.5', longitude: 119.5 } })
  assert.deepEqual(ok, { offsetM: 12.3, direction: 'reverse', point: { latitude: 31.5, longitude: 119.5 } })
  // 缺坐标也合法（只有偏移）
  assert.deepEqual(normalizeTrackStart({ offsetM: 0 }), { offsetM: 0, direction: 'forward' })
  // 非法：负偏移 / 非数 / 垃圾 / 缺 offsetM
  assert.equal(normalizeTrackStart({ offsetM: -1 }), undefined)
  assert.equal(normalizeTrackStart({ offsetM: 'abc' }), undefined)
  assert.equal(normalizeTrackStart({ offsetM: Number.NaN }), undefined)
  assert.equal(normalizeTrackStart({ direction: 'forward' }), undefined)
  assert.equal(normalizeTrackStart(null), undefined)
  assert.equal(normalizeTrackStart('nonsense'), undefined)
  // 坐标坏掉时**只丢坐标**，偏移与绕向保住（不能因为一个坐标把整条起跑点设置丢掉）
  const noPoint = normalizeTrackStart({ offsetM: 5, direction: 'reverse', point: { latitude: 'x' } })
  assert.deepEqual(noPoint, { offsetM: 5, direction: 'reverse' })
})

test('normalizeHistory：丢垃圾、丢空条目、只留最近上限条', () => {
  assert.deepEqual(normalizeHistory(null), [])
  assert.deepEqual(normalizeHistory('x'), [])
  assert.deepEqual(normalizeHistory([null, 1, 'a']), [])
  assert.deepEqual(normalizeHistory([{ at: '', summary: '' }]), [])
  const many = Array.from({ length: 9 }, (_, i) => ({ at: `2026-09-2${i}T00:00:00.000Z`, appVersion: '1.1.12', summary: `第 ${i} 次` }))
  const capped = normalizeHistory(many)
  assert.equal(capped.length, TRACK_HISTORY_MAX)
  assert.equal(capped[0]!.summary, '第 0 次', '顺序必须保持（最新在前由写入方负责）')
  // 字段缺失时补空串（界面显示"时间未知/版本未知"），不抛
  assert.deepEqual(normalizeHistory([{ summary: '只写了摘要' }]), [{ at: '', appVersion: '', summary: '只写了摘要' }])
})

test('prependHistory：新条目压到最前，并按上限裁剪', () => {
  const log = (i: number): TrackEditLog => ({ at: `2026-09-20T0${i}:00:00.000Z`, appVersion: '1.1.12', summary: `s${i}` })
  let hist: TrackEditLog[] = []
  for (let i = 0; i < TRACK_HISTORY_MAX + 3; i++) hist = prependHistory(hist, log(i % 10))
  assert.equal(hist.length, TRACK_HISTORY_MAX)
  assert.equal(hist[0]!.summary, `s${(TRACK_HISTORY_MAX + 2) % 10}`)
  // 传入 undefined 也能用（新条目第一次保存）
  assert.equal(prependHistory(undefined, log(1)).length, 1)
})

test('versionText：唯一版本文案出口（空 ⇒ 未记录，不出现 "v"）', () => {
  assert.equal(versionText('1.1.12'), 'v1.1.12')
  assert.equal(versionText('v1.1.12'), 'v1.1.12')
  assert.equal(versionText(''), '未记录')
  assert.equal(versionText(undefined), '未记录')
  assert.equal(versionText(null), '未记录')
})

test('startSummaryText：未设置说"未设置"；设置后带绕向与偏移', () => {
  assert.equal(startSummaryText({ outer: base.outer, start: undefined }), '未设置')
  // 夹具是逆时针 ⇒ forward 显示"逆时针"
  const text = startSummaryText({ outer: base.outer, start: { offsetM: 12, direction: 'forward' } })
  assert.ok(text.includes('逆时针'), text)
  assert.ok(text.includes('12 m'), text)
  const rev = startSummaryText({ outer: base.outer, start: { offsetM: 0, direction: 'reverse' } })
  assert.ok(rev.includes('顺时针'), rev)
})

test('saveSummaryText：说清"存成了什么样"（点数 / 道次 / 起跑点）', () => {
  const withStart = saveSummaryText({ outer: base.outer, inner: base.inner, laneNo: 3, laneCount: 6, start: { offsetM: 12, direction: 'forward' } })
  assert.ok(withStart.includes('外圈 12 点'), withStart)
  assert.ok(withStart.includes('内圈 12 点'), withStart)
  assert.ok(withStart.includes('第 3 道/6'), withStart)
  assert.ok(withStart.includes('起跑点 逆时针'), withStart)
  // 没有起跑点时明确写"未设置"（而不是悄悄少一段）
  const noStart = saveSummaryText({ outer: base.outer, inner: base.inner })
  assert.ok(noStart.includes('起跑点未设置'), noStart)
  assert.ok(!noStart.includes('第 undefined 道'), noStart)
})

test('historyLogText：时间 · 版本 · 摘要；缺字段时用中性措辞', () => {
  const t = historyLogText({ at: '2026-09-20T09:12:00.000Z', appVersion: '1.1.12', summary: '外圈 32 点 · 内圈 24 点' })
  assert.ok(t.includes('外圈 32 点'), t)
  assert.ok(t.includes('v1.1.12'), t)
  assert.match(t, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, t) // 本机时间格式
  assert.ok(historyLogText({ at: '', appVersion: '', summary: '' }).includes('时间未知'))
  assert.ok(historyLogText({ at: '', appVersion: '', summary: '' }).includes('版本未知'))
  assert.ok(historyLogText({ at: '', appVersion: '', summary: '' }).includes('未记录改动内容'))
})

test('entrySummaryText：新增"最近保存 / 编辑次数 / 起跑点"，且**旧字段一个都不许丢**', () => {
  const full: TrackRouteEntry = {
    ...base,
    updatedAt: '2026-09-20T09:12:00.000Z',
    updatedAppVersion: '1.1.12',
    editCount: 4,
    start: { offsetM: 12, direction: 'forward' },
  }
  const text = entrySummaryText(full)
  // 老口径（既有单测与本项目验证脚本都按它们断言）
  assert.ok(text.includes('外圈 12 点') && text.includes('内圈 12 点'), text)
  assert.ok(text.includes('第 3 道/6'), text)
  assert.ok(text.includes('v1.1.7'), text)
  // 新增口径
  assert.ok(text.includes('最近保存'), text)
  assert.ok(text.includes('v1.1.12'), text)
  assert.ok(text.includes('编辑 4 次'), text)
  assert.ok(text.includes('起跑点'), text)

  // 旧数据（没有新字段）⇒ 一个字都不加，不出现"未记录"噪音
  const legacy = entrySummaryText(base)
  assert.ok(!legacy.includes('最近保存'), legacy)
  assert.ok(!legacy.includes('编辑'), legacy)
  assert.ok(!legacy.includes('起跑点'), legacy)
})

test('entryDetailRows：旧数据显示"未记录（旧数据）"，新数据带时间/版本/次数/起跑点坐标', () => {
  const legacy = entryDetailRows(base)
  const get = (rows: { label: string; value: string }[], label: string) => rows.find((r) => r.label === label)?.value
  assert.equal(get(legacy, '创建时间')?.includes('2026-09'), true)
  assert.equal(get(legacy, '最近保存时间'), '未记录（旧数据）')
  assert.equal(get(legacy, '最近保存版本'), '未记录')
  assert.equal(get(legacy, '编辑次数'), '未记录（旧数据）')
  assert.equal(get(legacy, '起跑点'), '未设置')
  assert.ok(!legacy.some((r) => r.label === '起跑点坐标'), '没设起跑点就不该有坐标行')
  assert.equal(get(legacy, '外圈周长')?.endsWith(' m'), true)

  const fresh: TrackRouteEntry = {
    ...base,
    updatedAt: '2026-09-20T09:12:00.000Z',
    updatedAppVersion: '1.1.12',
    editCount: 2,
    start: { offsetM: 12, direction: 'reverse', point: { latitude: 31.5, longitude: 119.5 } },
  }
  const rows = entryDetailRows(fresh)
  assert.equal(get(rows, '最近保存版本'), 'v1.1.12')
  assert.equal(get(rows, '编辑次数'), '2 次')
  assert.equal(get(rows, '起跑点坐标'), '31.500000, 119.500000')
  assert.ok(get(rows, '起跑点')?.includes('顺时针'), get(rows, '起跑点'))
  assert.equal(get(rows, '道次'), '第 3 道（共 6 道）')
})

test('normalizeLibrary：新字段被保留；旧条目不会被凭空补出 start/history/editCount', () => {
  const raw = [
    {
      ...base,
      start: { offsetM: 12.3, direction: 'reverse', point: { latitude: 31.5, longitude: 119.5 } },
      updatedAt: '2026-09-20T09:12:00.000Z',
      updatedAppVersion: '1.1.12',
      editCount: 3.7,
      history: [{ at: '2026-09-20T09:12:00.000Z', appVersion: '1.1.12', summary: '外圈 12 点' }],
    },
    // 旧格式条目（只有最基本的字段）
    { lineId: 'L2', lineName: '旧跑道', outer: circle(100), inner: circle(90), createdAt: '', appVersion: '旧版' },
  ]
  const [fresh, legacy] = normalizeLibrary(raw)
  assert.deepEqual(fresh!.start, { offsetM: 12.3, direction: 'reverse', point: { latitude: 31.5, longitude: 119.5 } })
  assert.equal(fresh!.updatedAt, '2026-09-20T09:12:00.000Z')
  assert.equal(fresh!.updatedAppVersion, '1.1.12')
  assert.equal(fresh!.editCount, 4, 'editCount 取整')
  assert.equal(fresh!.history?.length, 1)
  assert.equal(legacy!.updatedAt, '', '老条目没有 updatedAt ⇒ 空串（界面显示未记录）')
  assert.equal(legacy!.editCount, undefined)
  assert.equal('start' in legacy!, false, '不得凭空造出 start')
  assert.equal('history' in legacy!, false, '不得凭空造出 history')
  assert.ok(legacy!.outer.length >= 3)
})
