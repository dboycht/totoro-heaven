/**
 * 跑道内外圈 → 车道线 的算法测试（2026-09-17）
 *
 * 夹具：两个同心圆当内外圈（外 r=100 m、内 r=90 m，环宽 10 m）——
 * 同心圆的好处是"到圆心的距离"就是判据，能精确验证插值是否落在两圈之间。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { laneLoop, laneRatioFor, laneRatioProfile, ringLengthM, ringWidthM, smoothClosedRing, pointInRing, validateRings, insetClosedRing, type TrackRings } from '../../utils/mp/trackEditor.ts'
import { normalizeLibrary, entrySummaryText } from '../../utils/mp/trackLibrary.ts'

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
/** 点到圆心的距离（米） */
const radiusOf = (p: { latitude: number; longitude: number }) =>
  Math.hypot((p.latitude - CENTER.latitude) * mLat, (p.longitude - CENTER.longitude) * mLng)

test('laneRatioFor：第 1 道贴内圈、第 N 道贴外圈、居中的道在中间', () => {
  assert.ok(Math.abs(laneRatioFor(1, 6) - 0.5 / 6) < 1e-9)
  assert.ok(Math.abs(laneRatioFor(6, 6) - 5.5 / 6) < 1e-9)
  assert.ok(Math.abs(laneRatioFor(3, 6) - 2.5 / 6) < 1e-9)
  // 越界要夹紧
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
    const rs = lane.map((p) => radiusOf(p as { latitude: number; longitude: number }))
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

test('smoothClosedRing：手工描的圈平滑后仍是同一个圈（圆→圆），点数按轮数翻倍', () => {
  const src = circle(100, 60)
  const out = smoothClosedRing(src, 2)
  assert.equal(out.length, src.length * 4)
  const rs = out.map((p) => radiusOf(p as { latitude: number; longitude: number }))
  const worst = Math.max(...rs.map((r) => Math.abs(r - 100)))
  assert.ok(worst < 1, `平滑后半径偏离 ${worst.toFixed(2)} m（应仍是同心圆）`)
  const perBefore = ringLengthM(src)
  const perAfter = ringLengthM(out)
  assert.ok(Math.abs(perAfter - perBefore) / perBefore < 0.02, `周长变化 ${(((perAfter - perBefore) / perBefore) * 100).toFixed(2)}%`)
  // 少于 3 个点时不动（避免把两点"平滑"成一条线）
  assert.deepEqual(smoothClosedRing(circle(100, 2), 2).length, 2)
})

test('★ laneLoop 支持"按弧长变道"的 ratio 函数：起点贴一道、终点贴另一道，中途平滑过渡', () => {
  // ⚠️ 注意：这里必须喂**平滑**的 ratio 函数（余弦过渡）。
  //    `laneLoop` 只忠实插值；"换道要平滑"是 `laneRatioProfile` 的职责 ——
  //    第一版测试喂了个阶跃函数，立刻被自己抓到"6 m 台阶"（0.6 道 × 10 m 环宽），属测试写错。
  const smoothRatio = (arc: number) => {
    if (arc <= 100) return 0.2
    if (arc >= 200) return 0.8
    const k = 0.5 - 0.5 * Math.cos((Math.PI * (arc - 100)) / 100) // 0→1
    return 0.2 + 0.6 * k
  }
  const lane = laneLoop(rings, smoothRatio, 240)
  const rs = lane.map((p) => radiusOf(p as { latitude: number; longitude: number }))
  const first = rs[0]!
  const last = rs[rs.length - 1]!
  assert.ok(Math.abs(first - (90 + 10 * 0.2)) < 1, `起点半径 ${first.toFixed(2)}（应≈92）`)
  assert.ok(Math.abs(last - (90 + 10 * 0.8)) < 1.6, `终点半径 ${last.toFixed(2)}（应≈98）`)
  // 平滑输入 ⇒ 平滑输出：相邻点半径差必须很小（同心圆夹具下 ≈ 0）
  const jumps = rs.slice(1).map((v, i) => Math.abs(v - rs[i]!))
  assert.ok(Math.max(...jumps) < 0.3, `出现台阶 ${Math.max(...jumps).toFixed(2)} m`)
})

test('normalizeLibrary：新格式原样、旧格式（{lineId:{outer,inner}}）自动迁移、垃圾数据丢弃', () => {
  const good = { lineId: 'L1', lineName: '西操场', outer: circle(100, 10), inner: circle(90, 10), createdAt: '2026-09-17T21:00:00.000Z', appVersion: '1.1.7' }
  const arr = normalizeLibrary([good, { lineId: 'bad' }])
  assert.equal(arr.length, 1)
  assert.equal(arr[0]!.lineId, 'L1')
  assert.equal(arr[0]!.appVersion, '1.1.7')

  const legacy = normalizeLibrary({ L2: { outer: circle(100, 8), inner: circle(90, 8) } }, '旧版')
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0]!.lineId, 'L2')
  assert.equal(legacy[0]!.appVersion, '旧版')
  assert.equal(legacy[0]!.createdAt, '')

  assert.deepEqual(normalizeLibrary(null), [])
  assert.deepEqual(normalizeLibrary('nonsense'), [])
  assert.deepEqual(normalizeLibrary({ L3: { outer: 'x', inner: 'y' } }), [])
})

test('entrySummaryText：列表摘要必须带点位数、创建日期与版本（用户要求）', () => {
  const text = entrySummaryText({
    lineId: 'L1',
    lineName: '西操场',
    outer: circle(100, 12),
    inner: circle(90, 10),
    createdAt: '2026-09-17T21:00:00.000Z',
    appVersion: '1.1.7',
  })
  assert.ok(text.includes('外圈 12 点'), text)
  assert.ok(text.includes('内圈 10 点'), text)
  // ⚠️ 日期必须转**本机时间**（存的是 UTC ISO）—— 所以这里只断言"格式"，不断言具体钟点，
  //    否则测试会随运行环境的时区而挂。
  assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, text)
  assert.ok(text.includes('v1.1.7'), text)
  const bare = entrySummaryText({ lineId: 'x', lineName: 'x', outer: [], inner: [], createdAt: '', appVersion: '' })
  assert.ok(bare.includes('创建日期未知') && bare.includes('版本未知'), bare)
})

test('★ laneRatioProfile：指定 baseLane 时必须真的用那道（用户报过"选第几道没变化"）', () => {
  const mkRng = (seed: number) => {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  // 不换道：整圈恒等于"第 N 道"的比例
  for (const lane of [1, 2, 4, 6]) {
    const f = laneRatioProfile(mkRng(7), 6, 400, { maxChanges: 0, baseLane: lane })
    const vals = Array.from({ length: 40 }, (_, i) => f(i * 10))
    const want = laneRatioFor(lane, 6)
    assert.ok(vals.every((v) => Math.abs(v - want) < 1e-9), `第 ${lane} 道应恒为 ${want}，实际 ${JSON.stringify(vals.slice(0, 4))}`)
  }
  // **换道开启时起点仍应是你选的那道**（否则用户改了道次看不到变化 —— 这正是本次修的 bug）
  const f2 = laneRatioProfile(mkRng(7), 6, 400, { maxChanges: 2, changeLenM: 30, baseLane: 5 })
  assert.ok(Math.abs(f2(0) - laneRatioFor(5, 6)) < 0.02, `起点应是第 5 道，实际 ${f2(0)}`)
  // 不同道次必须给出**不同**的车道比例（用中点采样比对，避免换道干扰）
  const a1 = laneRatioProfile(mkRng(7), 6, 400, { maxChanges: 0, baseLane: 1 })(200)
  const a6 = laneRatioProfile(mkRng(7), 6, 400, { maxChanges: 0, baseLane: 6 })(200)
  assert.ok(Math.abs(a1 - a6) > 0.5, `第 1 道(${a1}) 与第 6 道(${a6}) 必须明显不同`)
})

test('★ laneLoop：内外圈**形状不一致**时，车道线也必须整条夹在两圈之间（用户报的"一头贴外、一头贴内"）', () => {
  // 复现用户情形：外圈是"圆角方"、内圈是"六边形且整体偏移" —— 两圈的拐角完全对不上。
  const outer = circle(100, 24)
  const inner = Array.from({ length: 6 }, (_, i) => {
    const a = (2 * Math.PI * i) / 6
    return {
      latitude: CENTER.latitude + (78 * Math.sin(a)) / mLat + 8 / mLat, // 整体向北偏 8 m
      longitude: CENTER.longitude + (78 * Math.cos(a)) / mLng,
    }
  })
  for (const ratio of [0.15, 0.5, 0.85]) {
    const lane = laneLoop({ outer, inner }, ratio, 240)
    assert.equal(lane.length, 240)
    // ① 每个点都必须在外圈**之内**
    const outsideOuter = lane.filter((p) => !pointInRing(p, outer)).length
    assert.equal(outsideOuter, 0, `ratio=${ratio}：有 ${outsideOuter} 个点跑到外圈之外`)
    // ② 每个点都必须在**内圈之外**（否则就是压到内圈上/里面了）
    const insideInner = lane.filter((p) => pointInRing(p, inner)).length
    assert.equal(insideInner, 0, `ratio=${ratio}：有 ${insideInner} 个点落进内圈里`)
  }
})

test('★ validateRings：外圈必须包着内圈（不相交 / 内圈不许露到外面）', () => {
  // 合法：同心圆
  const good = validateRings(rings)
  assert.equal(good.ok, true, JSON.stringify(good.problems))
  assert.ok(Math.abs(good.widthM - 10) < 0.6)

  // 非法：内圈整体偏出去（部分点在外圈之外）
  const shiftedInner = circle(90, 60).map((p) => ({ latitude: p.latitude + 40 / 111320, longitude: p.longitude }))
  const bad1 = validateRings({ outer: circle(100, 60), inner: shiftedInner })
  assert.equal(bad1.ok, false)
  assert.ok(bad1.innerOutside > 0, '应报"内圈有点在外圈之外"')
  assert.ok(bad1.problems.some((t) => t.includes('外圈之外')), JSON.stringify(bad1.problems))

  // 非法：两圈相交（内圈比外圈大）
  const bad2 = validateRings({ outer: circle(90, 60), inner: circle(100, 60) })
  assert.equal(bad2.ok, false)
  assert.ok(bad2.problems.length > 0, JSON.stringify(bad2.problems))

  // 非法：环宽太窄
  const bad3 = validateRings({ outer: circle(100, 60), inner: circle(99, 60) })
  assert.equal(bad3.ok, false)
  assert.ok(bad3.problems.some((t) => t.includes('太窄')), JSON.stringify(bad3.problems))
})

test('insetClosedRing：按法向向内缩（圆缩完还是同心圆；方形的直边仍是直的）', () => {
  // 圆：半径 100 → 缩 8 m ⇒ 半径 ≈ 92
  const c = insetClosedRing(circle(100, 120), 8)
  const rs = c.map((p) => radiusOf(p as { latitude: number; longitude: number }))
  assert.ok(Math.max(...rs.map((r) => Math.abs(r - 92))) < 0.5, `半径应为 92，实测 ${rs[0]!.toFixed(2)}`)
  // 方形：缩完所有点仍在原方形内，且直边中点只向内缩约 8 m
  const square = [
    { latitude: CENTER.latitude + 100 / 111320, longitude: CENTER.longitude - 100 / mLng },
    { latitude: CENTER.latitude + 100 / 111320, longitude: CENTER.longitude + 100 / mLng },
    { latitude: CENTER.latitude - 100 / 111320, longitude: CENTER.longitude + 100 / mLng },
    { latitude: CENTER.latitude - 100 / 111320, longitude: CENTER.longitude - 100 / mLng },
  ]
  const sq = insetClosedRing(square, 10)
  assert.ok(sq.every((p) => pointInRing(p, square)), '内缩后的点必须仍在原图之内')
  const northY = Math.max(...sq.map((p) => (p.latitude - CENTER.latitude) * 111320))
  assert.ok(Math.abs(northY - 90) < 0.6, `北边应向内缩 10 m（90 m），实测 ${northY.toFixed(1)} m`)
})

test('laneRatioProfile：随机道次 + 偶尔换道，比例恒在 [0,1] 且能复现', () => {
  const mkRng = (seed: number) => {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  for (const seed of [1, 7, 42, 20260917]) {
    const f = laneRatioProfile(mkRng(seed), 6, 400, { maxChanges: 2, changeLenM: 30 })
    const vals = Array.from({ length: 400 }, (_, i) => f(i))
    assert.ok(vals.every((v) => v >= 0 && v <= 1), `seed=${seed} 出现越界比例`)
    // 相邻 1 m 的变化必须很小（换道是"缓慢"的，不是跳变）
    const jumps = vals.slice(1).map((v, i) => Math.abs(v - vals[i]!))
    assert.ok(Math.max(...jumps) < 0.05, `seed=${seed} 出现突变 ${Math.max(...jumps).toFixed(3)}（换道应平滑）`)
    // 同种子可复现
    const g = laneRatioProfile(mkRng(seed), 6, 400, { maxChanges: 2, changeLenM: 30 })
    assert.deepEqual(Array.from({ length: 20 }, (_, i) => g(i)), vals.slice(0, 20))
  }
})
