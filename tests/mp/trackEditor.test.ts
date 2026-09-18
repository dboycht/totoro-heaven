/**
 * 跑道内外圈 → 车道线 的算法测试（2026-09-17 重写：删除"换道/随机道次"后的版本）
 *
 * 夹具：两个同心圆当内外圈（外 r=100 m、内 r=90 m，环宽 10 m）——
 * 同心圆的好处是"到圆心的距离"就是判据，能精确验证插值是否落在两圈之间。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  laneLoop,
  laneRatioFor,
  ringLengthM,
  ringWidthM,
  smoothClosedRing,
  pointInRing,
  validateRings,
  insetClosedRing,
  distanceToRingM,
  type TrackRings,
} from '../../utils/mp/trackEditor.ts'
import { normalizeLibrary, entrySummaryText, sanitizeLineName, resolveEntryName, TRACK_NAME_MAX } from '../../utils/mp/trackLibrary.ts'

const CENTER = { latitude: 31.37, longitude: 119.48 }
const mLat = 111320
const mLng = 111320 * Math.cos((CENTER.latitude * Math.PI) / 180)

/** 造一个半径 r 米的圆（n 个点） */
const circle = (r: number, n = 120) =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return {
      latitude: CENTER.latitude + (r * Math.sin(a)) / mLat,
      longitude: CENTER.longitude + (r * Math.cos(a)) / mLng,
    }
  })

const rings: TrackRings = { outer: circle(100), inner: circle(90) }
const radiusOf = (p: { latitude: number | string; longitude: number | string }) =>
  Math.hypot((Number(p.latitude) - CENTER.latitude) * mLat, (Number(p.longitude) - CENTER.longitude) * mLng)

test('laneRatioFor：第 1 道贴内圈、第 N 道贴外圈、居中的道在中间', () => {
  assert.ok(Math.abs(laneRatioFor(1, 6) - 0.5 / 6) < 1e-9)
  assert.ok(Math.abs(laneRatioFor(6, 6) - 5.5 / 6) < 1e-9)
  assert.ok(Math.abs(laneRatioFor(3, 6) - 2.5 / 6) < 1e-9)
  assert.equal(laneRatioFor(0, 6), laneRatioFor(1, 6))
  assert.equal(laneRatioFor(99, 6), laneRatioFor(6, 6))
})

test('ringWidthM：同心圆夹具应量出 10 m 环宽', () => {
  const width = ringWidthM(rings)
  assert.ok(Math.abs(width - 10) < 0.6, `实测环宽 ${width.toFixed(2)} m`)
})

test('★ laneLoop：车道线必须严格落在内外圈之间（ratio=0.5 时半径≈95 m）', () => {
  for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
    const lane = laneLoop(rings, ratio)
    assert.ok(lane.length >= 24, `ratio=${ratio} 生成点数太少`)
    const rs = lane.map((p) => radiusOf(p))
    const expect = 90 + 10 * ratio
    const worst = Math.max(...rs.map((r) => Math.abs(r - expect)))
    assert.ok(worst < 0.8, `ratio=${ratio} 期望半径 ${expect} m，实测偏离最大 ${worst.toFixed(2)} m`)
  }
})

test('★ laneLoop：车道周长必须落在内外圈周长之间（不许穿墙）', () => {
  const lo = ringLengthM(rings.inner)
  const hi = ringLengthM(rings.outer)
  for (const ratio of [0, 0.3, 0.5, 0.8, 1]) {
    const per = ringLengthM(laneLoop(rings, ratio))
    assert.ok(per >= lo - 1 && per <= hi + 1, `ratio=${ratio} 周长 ${per.toFixed(1)} m 不在 [${lo.toFixed(1)}, ${hi.toFixed(1)}] 内`)
  }
})

test('★ laneLoop：**整圈恒定在所选道**（不再换道）—— 到内圈的距离沿全程基本不变', () => {
  // 用户 2026-09-17 确认：之前的"缓慢换道"是错误功能（车道线看着乱），已删除。
  for (const ratio of [0.25, 0.5, 0.9]) {
    const lane = laneLoop(rings, ratio, 240)
    const gaps = lane.map((p) => distanceToRingM(p, rings.inner))
    const lo = Math.min(...gaps)
    const hi = Math.max(...gaps)
    const want = ratio * 10
    assert.ok(hi - lo < 0.6, `ratio=${ratio}：到内圈的距离却在 ${lo.toFixed(2)}~${hi.toFixed(2)} m 之间跳`)
    assert.ok(Math.abs((lo + hi) / 2 - want) < 0.6, `ratio=${ratio}：应离内圈约 ${want} m，实测 ${((lo + hi) / 2).toFixed(2)} m`)
  }
})

test('★ laneLoop：内外圈**形状不一致**时，车道线也必须整条夹在两圈之间（"一头贴外、一头贴内"的守卫）', () => {
  const outer = circle(100, 24)
  const inner = Array.from({ length: 6 }, (_, i) => {
    const a = (2 * Math.PI * i) / 6
    return {
      latitude: CENTER.latitude + (78 * Math.sin(a)) / mLat + 8 / mLat,
      longitude: CENTER.longitude + (78 * Math.cos(a)) / mLng,
    }
  })
  for (const ratio of [0.15, 0.5, 0.85]) {
    const lane = laneLoop({ outer, inner }, ratio, 240)
    assert.equal(lane.length, 240)
    assert.equal(lane.filter((p) => !pointInRing(p, outer)).length, 0, `ratio=${ratio}：有点跑到外圈之外`)
    assert.equal(lane.filter((p) => pointInRing(p, inner)).length, 0, `ratio=${ratio}：有点落进内圈里`)
  }
})

test('★ validateRings：外圈必须包着内圈（不相交 / 内圈不许露到外面 / 环宽要合理）', () => {
  const good = validateRings(rings)
  assert.equal(good.ok, true, JSON.stringify(good.problems))
  assert.ok(Math.abs(good.widthM - 10) < 0.6)

  const shiftedInner = circle(90, 60).map((p) => ({ latitude: p.latitude + 40 / 111320, longitude: p.longitude }))
  const bad1 = validateRings({ outer: circle(100, 60), inner: shiftedInner })
  assert.equal(bad1.ok, false)
  assert.ok(bad1.problems.some((t) => t.includes('外圈之外')), JSON.stringify(bad1.problems))

  const bad2 = validateRings({ outer: circle(90, 60), inner: circle(100, 60) })
  assert.equal(bad2.ok, false)
  assert.ok(bad2.problems.length > 0, JSON.stringify(bad2.problems))

  const bad3 = validateRings({ outer: circle(100, 60), inner: circle(99, 60) })
  assert.equal(bad3.ok, false)
  assert.ok(bad3.problems.some((t) => t.includes('太窄')), JSON.stringify(bad3.problems))

  const wide = validateRings({ outer: circle(100, 60), inner: circle(78, 60) })
  assert.equal(wide.ok, false)
  assert.ok(wide.problems.some((t) => t.includes('太宽')), JSON.stringify(wide.problems))
})

test('insetClosedRing：按法向向内缩（圆缩完还是同心圆；方形的直边仍是直的）', () => {
  const c = insetClosedRing(circle(100, 120), 8)
  const rs = c.map((p) => radiusOf(p))
  assert.ok(Math.max(...rs.map((r) => Math.abs(r - 92))) < 0.5, `半径应为 92，实测 ${rs[0]!.toFixed(2)}`)

  const square = [
    { latitude: CENTER.latitude + 100 / 111320, longitude: CENTER.longitude - 100 / mLng },
    { latitude: CENTER.latitude + 100 / 111320, longitude: CENTER.longitude + 100 / mLng },
    { latitude: CENTER.latitude - 100 / 111320, longitude: CENTER.longitude + 100 / mLng },
    { latitude: CENTER.latitude - 100 / 111320, longitude: CENTER.longitude - 100 / mLng },
  ]
  const sq = insetClosedRing(square, 10)
  assert.ok(sq.every((p) => pointInRing(p, square)), '内缩后的点必须仍在原图之内')
  const northY = Math.max(...sq.map((p) => (Number(p.latitude) - CENTER.latitude) * 111320))
  assert.ok(Math.abs(northY - 90) < 0.6, `北边应向内缩 10 m（90 m），实测 ${northY.toFixed(1)} m`)
})

test('distanceToRingM：同心圆下"点到圈的距离"= 半径差', () => {
  const p = { latitude: CENTER.latitude + 95 / mLat, longitude: CENTER.longitude }
  assert.ok(Math.abs(distanceToRingM(p, circle(100, 60)) - 5) < 0.2)
  assert.ok(Math.abs(distanceToRingM(p, circle(90, 60)) - 5) < 0.2)
})

test('smoothClosedRing：手工描的圈平滑后仍是同一个圈（圆→圆），点数按轮数翻倍', () => {
  const src = circle(100, 60)
  const out = smoothClosedRing(src, 2)
  assert.equal(out.length, src.length * 4)
  const rs = out.map((p) => radiusOf(p))
  assert.ok(Math.max(...rs.map((r) => Math.abs(r - 100))) < 1, '平滑后应仍是同心圆')
  const perBefore = ringLengthM(src)
  const perAfter = ringLengthM(out)
  assert.ok(Math.abs(perAfter - perBefore) / perBefore < 0.02)
  assert.equal(smoothClosedRing(circle(100, 2), 2).length, 2)
})

test('normalizeLibrary：新格式原样、旧格式（{lineId:{outer,inner}}）自动迁移、垃圾数据丢弃', () => {
  const good = {
    lineId: 'L1',
    lineName: '西操场',
    outer: circle(100, 10),
    inner: circle(90, 10),
    createdAt: '2026-09-17T21:00:00.000Z',
    appVersion: '1.1.7',
    laneNo: 3,
    laneCount: 6,
  }
  const arr = normalizeLibrary([good, { lineId: 'bad' }])
  assert.equal(arr.length, 1)
  assert.equal(arr[0]!.lineId, 'L1')
  assert.equal(arr[0]!.appVersion, '1.1.7')
  assert.equal(arr[0]!.laneNo, 3)

  const legacy = normalizeLibrary({ L2: { outer: circle(100, 8), inner: circle(90, 8) } }, '旧版')
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0]!.appVersion, '旧版')
  assert.equal(legacy[0]!.createdAt, '')
  assert.equal(legacy[0]!.laneNo, undefined)

  assert.deepEqual(normalizeLibrary(null), [])
  assert.deepEqual(normalizeLibrary('nonsense'), [])
  assert.deepEqual(normalizeLibrary({ L3: { outer: 'x', inner: 'y' } }), [])
})

test('entrySummaryText：列表摘要必须带点位数、所选道次、创建日期与版本（用户要求）', () => {
  const text = entrySummaryText({
    lineId: 'L1',
    lineName: '西操场',
    outer: circle(100, 12),
    inner: circle(90, 10),
    createdAt: '2026-09-17T21:00:00.000Z',
    appVersion: '1.1.7',
    laneNo: 3,
    laneCount: 6,
  })
  assert.ok(text.includes('外圈 12 点'), text)
  assert.ok(text.includes('内圈 10 点'), text)
  assert.ok(text.includes('第 3 道/6'), text)
  assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, text)
  assert.ok(text.includes('v1.1.7'), text)

  const bare = entrySummaryText({ lineId: 'x', lineName: 'x', outer: [], inner: [], createdAt: '', appVersion: '' })
  assert.ok(bare.includes('创建日期未知') && bare.includes('版本未知') && bare.includes('道次未记录'), bare)
})

test('sanitizeLineName：折空白 / 去控制字符 / 按码点限长，空结果含义是"恢复原名"', () => {
  assert.equal(sanitizeLineName('  西 操场 '), '西 操场')
  // 连续空格折成一个（判据：`西  操场` → `西 操场`）
  assert.equal(sanitizeLineName('西  操场'), '西 操场')
  // ⚠️ 制表/换行属于控制字符 ⇒ 被**删除**（不是换成空格）：`西\t操\n场` → `西操场`
  assert.equal(sanitizeLineName('西\t操\n场'), '西操场')
  // 控制字符与零宽字符被删掉（粘贴来的名字常带这些，肉眼看不出）
  assert.equal(sanitizeLineName('西\u200b操场\u0007'), '西操场')
  assert.equal(sanitizeLineName('西\ufeff操场'), '西操场')
  // 空/非字符串 → ''（调用方据此"恢复厂商原名"，不能把它当成合法名字）
  assert.equal(sanitizeLineName('   '), '')
  assert.equal(sanitizeLineName(''), '')
  assert.equal(sanitizeLineName(undefined), '')
  assert.equal(sanitizeLineName(123), '')
  // 限长：中文按码点截断
  assert.equal(Array.from(sanitizeLineName('跑'.repeat(80))).length, TRACK_NAME_MAX)
  // emoji 是代理对，不能被截成半个（否则界面出现乱码方块）
  const emoji = sanitizeLineName('🏃'.repeat(40))
  assert.equal(Array.from(emoji).length, TRACK_NAME_MAX)
  assert.ok(!emoji.includes('\ufffd'), emoji)
  assert.equal(emoji, '🏃'.repeat(TRACK_NAME_MAX))
})

test('resolveEntryName：自定义名优先 → 厂商名 → lineId，**绝不返回空串**', () => {
  assert.equal(resolveEntryName({ lineId: 'L1', lineName: '西操场', customName: '我的外道' }), '我的外道')
  assert.equal(resolveEntryName({ lineId: 'L1', lineName: '西操场' }), '西操场')
  // 自定义名是空白 ⇒ 不算"改过名"，回落厂商名
  assert.equal(resolveEntryName({ lineId: 'L1', lineName: '西操场', customName: '   ' }), '西操场')
  // 厂商名也空 ⇒ 回落 lineId（列表里不能出现空行）
  assert.equal(resolveEntryName({ lineId: 'sunrunLine-2021', lineName: '  ', customName: '' }), 'sunrunLine-2021')
  assert.equal(resolveEntryName({ lineId: 'L9', lineName: '' }), 'L9')
})

test('normalizeLibrary：customName 被归一化保存；空白自定义名归一成 undefined', () => {
  const base = { outer: circle(100, 8), inner: circle(90, 8), createdAt: '', appVersion: '1.1.9' }
  const [renamed] = normalizeLibrary([{ ...base, lineId: 'L1', lineName: '官方名', customName: ' 我 的跑道 ' }])
  assert.equal(renamed!.customName, '我 的跑道')
  assert.equal(resolveEntryName(renamed!), '我 的跑道')

  const [blank] = normalizeLibrary([{ ...base, lineId: 'L2', lineName: '官方名', customName: '   ' }])
  assert.equal(blank!.customName, undefined)
  assert.equal(resolveEntryName(blank!), '官方名')

  // 旧数据完全没有这个字段 ⇒ 不凭空造出来（保持 undefined）
  const [legacyShape] = normalizeLibrary([{ ...base, lineId: 'L3', lineName: '官方名' }])
  assert.equal('customName' in legacyShape!, false)
})

test('entrySummaryText：改过名时摘要要标出**官方原名**（避免"改完就不知道对应哪条线路"）', () => {
  const entry = {
    lineId: 'L1',
    lineName: '西操场',
    customName: '我的外道',
    outer: circle(100, 12),
    inner: circle(90, 10),
    createdAt: '2026-09-17T21:00:00.000Z',
    appVersion: '1.1.9',
    laneNo: 3,
    laneCount: 6,
  }
  const text = entrySummaryText(entry)
  assert.ok(text.includes('官方名：西操场'), text)
  // 没改过名就不该出现这个标注（否则每条都挂一句废话）
  assert.ok(!entrySummaryText({ ...entry, customName: undefined }).includes('官方名'), '未改名不应标注官方名')
})
