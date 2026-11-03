/**
 * **「真实路径【测试】」纯逻辑测试**（2026-11-03，1.3.6 需求③）
 *
 * 用户口径："可以使用相关内部功能来导出**某一天真实跑的路径信息**，并可以选择
 * 「导出到本地存为路径预设」或者「导出分享给好友」两种选择，用户在跑步界面可以选择这些路径并进行跑步，
 * 目前先做到直接原版数据提交（相关功能标注为「测试」）"；分享形态 = **压缩包**。
 *
 * 这里钉住六件事（全都是"改坏了不报错、只会静默骗人"的一类）：
 *   ① 归档/明细响应的解析**只认事实**（坏数据安全降级，缺轨迹就如实空）；
 *   ② **按天分组**与排序（日期倒序、"日期未知"排最后）；
 *   ③ **原样口径**（🆕 2026-11-04 用户口径"直接原样上传，而不是只保留几圈"）：
 *      草稿/分享包/导入都**整条原样**（不切圈不降采样）；切圈（`extractOneLap`）只为**报一圈长度**；
 *   ④ `downsamplePath`（已不在产品链路里）**首末必留**、不超上限（判据保留，以备体量保护）；
 *   ⑤ 预设草稿的字段口径与「研途健行路径编辑器」**同源**（freeShape 权威 + 占位几何 + start=null）；
 *   ⑥ 分享包**只带白名单字段**（隐私红线）+ **能被自己读回来**（真 zip 往返）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REAL_PATH_BUNDLE_FILE,
  REAL_PATH_BUNDLE_KIND,
  buildRealPathPresetDraft,
  buildShareBundle,
  defaultRealPathName,
  downsamplePath,
  extractOneLap,
  groupRecordsByDay,
  nearestLineByGeometry,
  parseArchDetailPoints,
  parseArchRecords,
  parseRealPathMeta,
  parseShareBundle,
  pathLengthM,
  pickBundleItem,
  readShareBundleFromZip,
  type RealPathMeta,
  type RealPathPoint,
} from '../../utils/mp/realPath.ts'
import { createZip } from '../../server/utils/zip.ts'

const mLat = 111320
const mLng = 111320 * Math.cos((31.99 * Math.PI) / 180)
/** 以 (31.99, 118.84) 为心的正圆（半径米，逆时针） */
const circle = (radiusM: number, n = 48, closed = false): RealPathPoint[] => {
  const out = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return {
      latitude: 31.99 + (radiusM * Math.sin(a)) / mLat,
      longitude: 118.84 + (radiusM * Math.cos(a)) / mLng,
    }
  })
  return closed ? [...out, out[0]!] : out
}
/** 模拟"跑了 laps 圈"的整场轨迹（每圈 48 点，末点与首点重合） */
const multiLap = (radiusM: number, laps: number): RealPathPoint[] => {
  const one = circle(radiusM, 48)
  const out: RealPathPoint[] = []
  for (let k = 0; k < laps; k++) for (const p of one) out.push(p)
  out.push(one[0]!)
  return out
}

// ---------------------------------------------------------------- ① 解析

test('parseArchRecords：只认事实 —— 缺 scoreId 丢掉、日期非 YYYY-MM-DD 当"日期未知"、数值坏掉给 null', () => {
  const payload = {
    data: [
      {
        scoreId: 'sunrunId202611011234',
        runTime: '2026-11-01',
        startTmie: '08:12:33',
        mileage: '3.21',
        usedTime: '00:20:25',
        trajectorySimilary: 0.97,
        scorePassType: 1,
      },
      // 缺 scoreId ⇒ 丢掉（没有场次号就没法取明细）
      { runTime: '2026-11-01', mileage: '3.0' },
      // 坏日期 ⇒ 空串（界面归到"日期未知"），但记录本身要留下
      { scoreId: 'sunrunId202610999999', runTime: '11月1日', mileage: 'abc' },
    ],
  }
  const out = parseArchRecords(payload)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], {
    scoreId: 'sunrunId202611011234',
    paperId: '',
    date: '2026-11-01',
    startTime: '08:12:33',
    km: 3.21,
    usedTime: '00:20:25',
    fitDegree: 0.97,
    passType: 1,
  })
  assert.equal(out[1]!.date, '', '非 YYYY-MM-DD 的日期不许硬猜')
  assert.equal(out[1]!.km, null, '读不出的数字给 null，不编 0')
  // 裸数组也认；垃圾输入不抛
  assert.equal(parseArchRecords([{ scoreId: 'a', runTime: '2026-11-02' }]).length, 1)
  assert.deepEqual(parseArchRecords(null), [])
  assert.deepEqual(parseArchRecords({ data: 'x' }), [])
})

test('groupRecordsByDay：按天分组、日期倒序、"日期未知"排最后、同一天按开始时间倒序', () => {
  const days = groupRecordsByDay([
    { scoreId: 'a', paperId: 'P', date: '2026-10-31', startTime: '07:00:00', km: 3, usedTime: '', fitDegree: null, passType: 1 },
    { scoreId: 'b', paperId: 'P', date: '2026-11-01', startTime: '07:00:00', km: 3, usedTime: '', fitDegree: null, passType: 1 },
    { scoreId: 'c', paperId: 'P', date: '2026-11-01', startTime: '18:30:00', km: 3, usedTime: '', fitDegree: null, passType: 1 },
    { scoreId: 'd', paperId: 'P', date: '', startTime: '', km: 3, usedTime: '', fitDegree: null, passType: 1 },
  ])
  assert.deepEqual(days.map((d) => d.date), ['2026-11-01', '2026-10-31', ''])
  assert.deepEqual(days[0]!.records.map((r) => r.scoreId), ['c', 'b'], '同一天里晚间那条排前面')
  assert.deepEqual(groupRecordsByDay([]), [])
})

test('parseArchDetailPoints：逐点过滤非法坐标；空/缺 pointList ⇒ 空数组（不假装有轨迹）', () => {
  const pts = parseArchDetailPoints({
    pointList: [
      { latitude: 31.99, longitude: 118.84 },
      { latitude: '31.991', longitude: '118.841' },
      { latitude: null, longitude: 118.8 },
      { latitude: 91, longitude: 0 },
      { longitude: 1 },
      'nonsense',
    ],
  })
  assert.equal(pts.length, 2)
  assert.deepEqual(pts[1], { latitude: 31.991, longitude: 118.841 })
  assert.deepEqual(parseArchDetailPoints({ pointList: null }), [])
  assert.deepEqual(parseArchDetailPoints(null), [])
  assert.deepEqual(parseArchDetailPoints([{ latitude: 31.9, longitude: 118.8 }]).length, 1, '裸数组也认')
})

// ---------------------------------------------------------------- ③ 切一圈

test('extractOneLap：从多圈整场里切出**一圈**（首尾相接），长度接近真实一圈', () => {
  const whole = multiLap(100, 5)
  const lap = extractOneLap(whole, { tolM: 25, minM: 200 })
  assert.ok(lap.length >= 48 && lap.length <= 50, `应取回约一圈（48~50 点），实际 ${lap.length}`)
  const len = pathLengthM(lap)
  const expect = 2 * Math.PI * 100
  assert.ok(Math.abs(len - expect) < expect * 0.05, `一圈长度应约 ${expect.toFixed(0)} m，实际 ${len.toFixed(0)} m`)
  /** 整场 5 圈约 3140 m；切出来必须远小于它（这是本函数存在的唯一理由） */
  assert.ok(pathLengthM(whole) > len * 4.5, '整场明显比一圈长')
})

test('extractOneLap：不是闭环 ⇒ **原样返回**（绝不凭空造一个闭合环）；点数不足也不抛', () => {
  const straight = Array.from({ length: 20 }, (_, i) => ({ latitude: 31.99 + (i * 10) / mLat, longitude: 118.84 }))
  assert.deepEqual(extractOneLap(straight, { tolM: 10 }), straight)
  assert.deepEqual(extractOneLap([{ latitude: 1, longitude: 1 }]), [{ latitude: 1, longitude: 1 }])
  assert.deepEqual(extractOneLap([]), [])
  assert.deepEqual(extractOneLap(null as unknown as RealPathPoint[]), [])
})

// ---------------------------------------------------------------- ④ 降采样

test('downsamplePath：不超上限、**首末必留**、已够短时原样返回（一个点都不动）', () => {
  const pts = multiLap(100, 2)
  assert.deepEqual(downsamplePath(pts, pts.length), pts, '不超上限就不许动')
  const small = downsamplePath(pts, 50)
  assert.equal(small.length, 50)
  assert.deepEqual(small[0], pts[0], '首点必须是原点')
  assert.deepEqual(small[small.length - 1], pts[pts.length - 1], '末点必须是原点')
  // 上限过小也要能给出个能用的东西（≥8）
  assert.ok(downsamplePath(pts, 1).length >= 8)
})

// ---------------------------------------------------------------- ⑤ 预设草稿

test('buildRealPathPresetDraft：形状权威 + 占位几何 ≥3 点 + start 显式 null + 元信息带上', () => {
  const pts = circle(100, 48, true)
  const meta: RealPathMeta = {
    date: '2026-11-01',
    scoreId: 'sunrunId202611011234',
    km: 3.21,
    usedTime: '00:20:25',
    fitDegree: 0.97,
    sourcePoints: 967,
    lapLengthM: 628.3,
    exportedAt: '2026-11-03T02:00:00.000Z',
  }
  const draft = buildRealPathPresetDraft({ meta, points: pts, lineId: 'L1', lineName: '东操场', presetName: '真实路径 A' })
  assert.equal(draft.freeShape.kind, 'curve')
  assert.equal(draft.freeShape.points.length, pts.length)
  assert.ok(draft.outer.length >= 3 && draft.inner.length >= 3, '占位几何至少各 3 点（旧版本才认这条记录）')
  assert.equal(draft.start, null, '形状换了就必须显式清掉起跑点（审计 B1 的口径）')
  assert.equal(draft.lineId, 'L1')
  assert.equal(draft.presetName, '真实路径 A')
  assert.deepEqual(draft.realPath, meta)
  /** 占位几何必须是"取自这条路径上的点"（不是凭空造的三角） */
  for (const p of draft.outer) {
    assert.ok(pts.some((q) => q.latitude === p.latitude && q.longitude === p.longitude), '占位点必须来自真实路径')
  }
})

test('★ buildRealPathPresetDraft：**原样口径** —— 多圈整场原样进草稿（不切圈不降采样，点数与顺序逐点不变）', () => {
  /**
   * 用户 2026-11-04 口径："相关的真实路径导出以及引用指的是将原版的路径直接导出然后直接原样上传，
   * 而不是只保留几圈"。判据：5 圈整场（240 点）进草稿 ⇒ `freeShape.points` 还是 240 点，
   * 首点/中间点/末点与输入逐点相等（顺序即跑向，一个点都不许动）。
   */
  const whole = multiLap(100, 5) // 5 圈 × 48 点 = 240 点
  const meta: RealPathMeta = {
    date: '2026-11-03',
    scoreId: 's-raw',
    km: 3.14,
    usedTime: '00:18:00',
    fitDegree: 0.98,
    sourcePoints: whole.length,
    lapLengthM: pathLengthM(multiLap(100, 1)),
    exportedAt: '2026-11-04T00:00:00.000Z',
  }
  const draft = buildRealPathPresetDraft({ meta, points: whole, lineId: 'L1', lineName: '东操场' })
  assert.equal(draft.freeShape.points.length, whole.length, `原样 ${whole.length} 点，一个不删`)
  assert.deepEqual(draft.freeShape.points[0], whole[0], '首点不变')
  assert.deepEqual(draft.freeShape.points[Math.floor(whole.length / 2)], whole[Math.floor(whole.length / 2)], '中段点不变')
  assert.deepEqual(draft.freeShape.points[whole.length - 1], whole[whole.length - 1], '末点不变')
  assert.equal(draft.realPath.lapLengthM, meta.lapLengthM, '一圈长度随元信息带上（预览按圈着色用）')
})

test('defaultRealPathName：带日期（有时刻就带 HHMM）；日期缺失时如实写"日期未知"', () => {
  assert.equal(defaultRealPathName({ date: '2026-11-01', usedTime: '', startTime: '08:12:33' }), '真实路径 2026-11-01 · 0812')
  assert.equal(defaultRealPathName({ date: '2026-11-01', usedTime: '' }), '真实路径 2026-11-01')
  assert.equal(defaultRealPathName({ date: '', usedTime: '' }), '真实路径 日期未知')
})

test('parseRealPathMeta：看得出是哪一场才保留；残缺/垃圾 ⇒ undefined（老条目不会多出这个键）', () => {
  assert.deepEqual(parseRealPathMeta({ date: '2026-11-01', scoreId: 's1', km: '3.2', sourcePoints: '967' }), {
    date: '2026-11-01',
    scoreId: 's1',
    km: 3.2,
    usedTime: '',
    fitDegree: null,
    sourcePoints: 967,
    lapLengthM: null,
    exportedAt: '',
  })
  /** 🆕 2026-11-04：lapLengthM 宽松解析（数字/字符串都认；没有 ⇒ null，不猜） */
  assert.equal(parseRealPathMeta({ date: '2026-11-01', scoreId: 's1', lapLengthM: '628.3' })?.lapLengthM, 628.3)
  assert.equal(parseRealPathMeta({ date: '2026-11-01', scoreId: 's1', lapLengthM: 0 })?.lapLengthM, 0)
  assert.equal(parseRealPathMeta({ date: '2026-11-01', scoreId: 's1' })?.lapLengthM, null)
  assert.equal(parseRealPathMeta({ date: '2026-11-01', scoreId: 's1', lapLengthM: 'abc' })?.lapLengthM, null)
  assert.equal(parseRealPathMeta({ km: 3 }), undefined, '既没日期也没场次号 ⇒ 没有解释力，丢掉')
  assert.equal(parseRealPathMeta(null), undefined)
  assert.equal(parseRealPathMeta('x'), undefined)
})

// ---------------------------------------------------------------- ⑥ 分享包（白名单 + 往返）

test('buildShareBundle：**只带白名单字段**（token/学号/姓名一律不出现）', () => {
  const bundle = buildShareBundle(
    [
      {
        name: '真实路径 A',
        lineId: 'L1',
        lineName: '东操场',
        points: circle(100, 8),
        // @ts-expect-error 故意塞私货，验证白名单会把它丢掉
        token: 'SECRET_TOKEN',
        snCode: '20210001',
        studentName: '张三',
        meta: { date: '2026-11-01', scoreId: 's1', km: 3.2, usedTime: '', fitDegree: null, sourcePoints: 9, lapLengthM: null, exportedAt: 'x' },
      },
    ],
    '2026-11-03T02:00:00.000Z',
  )
  const text = JSON.stringify(bundle)
  assert.ok(!text.includes('SECRET_TOKEN'), 'token 绝不许进分享包')
  assert.ok(!text.includes('20210001'), '学号绝不许进分享包')
  assert.ok(!text.includes('张三'), '姓名绝不许进分享包')
  assert.equal(bundle.kind, REAL_PATH_BUNDLE_KIND)
  assert.equal(bundle.items.length, 1)
  assert.equal(bundle.items[0]!.points.length, 8)
})

test('parseShareBundle：拒绝非本应用的包 / 更高版本 / 空包；坏点丢掉非法坐标', () => {
  const good = buildShareBundle([
    { name: 'A', lineId: 'L1', lineName: '东操场', points: circle(100, 6), meta: { date: '2026-11-01', scoreId: 's1', km: 3, usedTime: '', fitDegree: null, sourcePoints: 6, lapLengthM: null, exportedAt: '' } },
  ])
  const ok = parseShareBundle(good)
  assert.equal(ok.ok, true)
  assert.equal(ok.items.length, 1)

  assert.equal(parseShareBundle({ kind: 'other' }).ok, false)
  assert.match(parseShareBundle({ kind: 'other' }).error, /不是「龙猫天堂」导出的路径包/)
  assert.equal(parseShareBundle({ ...good, version: 99 }).ok, false)
  assert.match(parseShareBundle({ ...good, version: 99 }).error, /更新软件/)
  assert.equal(parseShareBundle({ ...good, items: [] }).ok, false)
  assert.match(parseShareBundle({ ...good, items: [] }).error, /没有可用的路径/)
  assert.equal(parseShareBundle('{ bad json').ok, false)

  /** 非法坐标在导入时被丢掉；剩不足 3 点的那一条整条丢掉 */
  const messy = {
    ...good,
    items: [
      { ...good.items[0], points: [{ latitude: 31.9, longitude: 118.8 }, { latitude: 31.91, longitude: 118.81 }, { latitude: 31.92, longitude: 118.82 }] },
      { ...good.items[0], name: 'B', points: [{ latitude: 1, longitude: 1 }] },
    ],
  }
  const parsed = parseShareBundle(messy)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.items.length, 1, '只剩那条点够的')
  assert.equal(parsed.items[0]!.name, 'A')
  // 字符串形式（好友直接把文本发过来的情况）也认
  assert.equal(parseShareBundle(JSON.stringify(good)).ok, true)
})

test('pickBundleItem：索引越界/非数 ⇒ undefined（界面据此说"没选中"）', () => {
  const items = parseShareBundle(
    buildShareBundle([
      { name: 'A', lineId: 'L1', lineName: '东操场', points: circle(100, 6), meta: { date: '2026-11-01', scoreId: 's1', km: 3, usedTime: '', fitDegree: null, sourcePoints: 6, lapLengthM: null, exportedAt: '' } },
    ]),
  ).items
  assert.equal(pickBundleItem(items, 0)?.name, 'A')
  assert.equal(pickBundleItem(items, 1), undefined)
  assert.equal(pickBundleItem(items, -1), undefined)
  assert.equal(pickBundleItem(items, Number.NaN), undefined)
})

test('extractOneLap：**从场外走进来再开跑**也能切出一圈（2026-11-03 用户实测踩到的那种轨迹）', () => {
  /**
   * 现场：真人开跑前从跑道外走进来/站在跑道边调表 ⇒ `p[0]` 根本不在跑道上。
   * 旧实现只认"回到 `p[0]` 25 m 内"⇒ **永远不命中** ⇒ 退回整条（用户看到"1121 点 → 600 点，只降了采样"）。
   * 现在从**任意一点**起算 ⇒ 只要跑道上任意一处之后又回到附近，就能切出那一圈。
   */
  const walkIn = Array.from({ length: 15 }, (_, i) => ({ latitude: 31.99 - 0.0012 + (i * 1.2) / mLat, longitude: 118.84 - 0.0009 }))
  const track = multiLap(100, 4) // 4 圈，每圈 48 点
  const whole = [...walkIn, ...track]
  const lap = extractOneLap(whole, { tolM: 25, minM: 200 })
  assert.ok(lap.length < whole.length, `必须切出比整条更短的一段（实际 ${lap.length} / ${whole.length}）`)
  assert.ok(lap.length >= 40 && lap.length <= 60, `应取回约一圈（40~60 点），实际 ${lap.length}`)
  const len = pathLengthM(lap)
  const expect = 2 * Math.PI * 100
  assert.ok(Math.abs(len - expect) < expect * 0.08, `一圈长度应约 ${expect.toFixed(0)} m，实际 ${len.toFixed(0)} m`)
  /** 切出来的那一段必须**已经离开**进场段（起点不在入场那 15 个点里） */
  assert.ok(lap[0]!.latitude > 31.99 - 0.0005, '起点应已经走到跑道上，而不是进场段那几步')
})

test('nearestLineByGeometry：按轨迹位置认出是哪条线路；差太远 ⇒ null（不硬塞）', () => {
  /** 东操场（圆心 31.99/118.84，半径 100 m）与西操场（东北 2 km 外，半径 80 m） */
  const east = { pointId: 'L-east', pointName: '东操场', pointList: circle(100, 24) }
  const west = { pointId: 'L-west', pointName: '西操场', pointList: circle(80, 24).map((p) => ({ latitude: p.latitude + 0.018, longitude: p.longitude })) }
  const runOnEast = circle(102, 48)
  const m = nearestLineByGeometry(runOnEast, [east, west])
  assert.equal(m?.pointId, 'L-east', JSON.stringify(m))
  assert.equal(m?.pointName, '东操场')
  assert.ok((m?.distM ?? 99) < 5, `距离应很小，实际 ${m?.distM}`)

  const runOnWest = circle(78, 48).map((p) => ({ latitude: p.latitude + 0.018, longitude: p.longitude }))
  assert.equal(nearestLineByGeometry(runOnWest, [east, west])?.pointId, 'L-west')

  /** 离两条线都很远（>150 m）⇒ 返回 null，让用户自己选，绝不硬塞一条错的 */
  const farAway = circle(100, 24).map((p) => ({ latitude: p.latitude + 0.05, longitude: p.longitude + 0.05 }))
  assert.equal(nearestLineByGeometry(farAway, [east, west]), null)

  // 退化输入：没点 / 线路没点列 / 空数组 ⇒ null（不抛）
  assert.equal(nearestLineByGeometry([], [east]), null)
  assert.equal(nearestLineByGeometry(runOnEast, [{ pointId: 'x', pointList: [] }]), null)
  assert.equal(nearestLineByGeometry(runOnEast, []), null)
  // 相同距离时取传入顺序的第一条（稳定可测）
  const twin = { pointId: 'L-east-2', pointName: '东操场（重复）', pointList: circle(100, 24) }
  assert.equal(nearestLineByGeometry(runOnEast, [east, twin])?.pointId, 'L-east')
})

test('parseArchRecords：**保留 paperId**（记录里唯一能指向任务的字，线路只能靠几何匹配）', () => {
  const [r] = parseArchRecords({ data: [{ scoreId: 's1', paperId: 'sunrunTaskPaper-1', runTime: '2026-11-01' }] })
  assert.equal(r!.paperId, 'sunrunTaskPaper-1')
  assert.equal(parseArchRecords({ data: [{ scoreId: 's2', runTime: '2026-11-01' }] })[0]!.paperId, '', '缺 paperId 时给空串，不编')
})

test('🔄 真 zip 往返：自己写的包能被自己读回来（store 模式，含中文文件名）', async () => {
  const bundle = buildShareBundle([
    {
      name: '真实路径 A',
      lineId: 'L1',
      lineName: '东操场',
      points: circle(100, 12),
      meta: { date: '2026-11-01', scoreId: 's1', km: 3.2, usedTime: '00:20:25', fitDegree: 0.97, sourcePoints: 967, lapLengthM: 628.3, exportedAt: '2026-11-03T02:00:00.000Z' },
    },
  ])
  const zip = createZip([{ name: REAL_PATH_BUNDLE_FILE, data: Buffer.from(JSON.stringify(bundle), 'utf8') }])
  const back = await readShareBundleFromZip(new Uint8Array(zip))
  assert.equal(back.ok, true, back.error)
  assert.equal(back.items.length, 1)
  assert.equal(back.items[0]!.name, '真实路径 A')
  assert.equal(back.items[0]!.points.length, 12)
  assert.equal(back.items[0]!.meta.scoreId, 's1')
  /** 🆕 2026-11-04：一圈长度随包往返（预览按圈着色靠它） */
  assert.equal(back.items[0]!.meta.lapLengthM, 628.3)

  // 不是 zip ⇒ 明确报错（不静默当空包）
  const bad = await readShareBundleFromZip(new Uint8Array([1, 2, 3, 4, 5]))
  assert.equal(bad.ok, false)
  assert.match(bad.error, /读不了这个压缩包/)
})
