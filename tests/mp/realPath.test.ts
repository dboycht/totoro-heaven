/**
 * **「真实路径」纯逻辑测试**（2026-11-03，1.3.6 需求③）
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
  batchImportCandidates,
  bundleJsonOf,
  pickBundleItem,
  pickMonthId,
  randomNameSuffix,
  readAllShareItemsFromZip,
  readShareBundleFromZip,
  resolvePlace,
  sanitizeZipEntryName,
  setSelection,
  summarizeBatch,
  toggleSelection,
  withRandomSuffix,
  planRealPathTrim,
  realPathTrimText,
  planRealPathGeometry,
  realPathPlanShortText,
  realPathPlanText,
  resampleRealPath,
  pointToSegmentM,
  REAL_PATH_TRIM_MIN_BUDGET_M,
  REAL_PATH_TRIM_OVERSHOOT,
  REAL_PATH_TRIM_RATIO,
  type RealPathMeta,
  type RealPathPoint,
} from '../../utils/mp/realPath.ts'
// 🆕 2026-11-18：归档用时→配速/时长的换算放在 runData（realPath.ts 必须保持零 import，见该函数注释）
import { resolveRealPathPace } from '../../utils/mp/runData.ts'
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

test('defaultRealPathName：🆕 2026-11-04 默认名**携带地点名**（用户口径）；空白地点 = 不带（与旧版一致）', () => {
  assert.equal(
    defaultRealPathName({ date: '2026-09-16', usedTime: '', startTime: '21:22:00' }, '天目湖-东操场'),
    '天目湖-东操场 · 真实路径 2026-09-16 · 2122',
  )
  assert.equal(defaultRealPathName({ date: '2026-11-01', usedTime: '' }, '东操场'), '东操场 · 真实路径 2026-11-01')
  assert.equal(defaultRealPathName({ date: '2026-11-01', usedTime: '' }, '   '), '真实路径 2026-11-01', '空白地点不算名字')
  assert.equal(defaultRealPathName({ date: '2026-11-01', usedTime: '' }, '本机跑道（还没读取任务）'), '本机跑道（还没读取任务） · 真实路径 2026-11-01')
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

// ---------------------------------------------------------------- ⑦ 月份高亮（读哪个月就亮哪个月）

const MONTHS = [
  { monthId: '202609', monthName: '2026年9月', isCurrent: false },
  { monthId: '202610', monthName: '2026年10月', isCurrent: false },
  { monthId: '202611', monthName: '2026年11月', isCurrent: true },
  { monthId: '202612', monthName: '2026年12月', isCurrent: false },
]

test('pickMonthId：点名哪个月就用哪个月（点 9 月读数据，界面不能还亮着本月）', () => {
  assert.equal(pickMonthId(MONTHS, '202609'), '202609')
  assert.equal(pickMonthId(MONTHS, ' 202612 '), '202612', '首尾空白不算另一个月份')
})

test('pickMonthId：没点名 ⇒ 用「当前月份」；服务端没标 ifCurrent ⇒ 按今天推出来对名字', () => {
  assert.equal(pickMonthId(MONTHS), '202611', '有唯一 ifCurrent 就用它')
  assert.equal(pickMonthId(MONTHS), '202611')
  const noFlag = MONTHS.map((m) => ({ ...m, isCurrent: false }))
  const at = new Date(2026, 9, 3)
  assert.equal(pickMonthId(noFlag, '', at), '202610', '十月（`2026年10月` 形态对得上）')
  const dashed = noFlag.map((m) => (m.monthId === '202611' ? { ...m, monthName: '2026-11' } : m))
  assert.equal(pickMonthId(dashed, '', new Date(2026, 10, 10)), '202611', '`2026-11` 形态也认')
})

test('pickMonthId：月份列表为空 / 对不上 ⇒ 空串（不猜，界面据此拦下并提示先读月份）', () => {
  assert.equal(pickMonthId([]), '', '列表为空又没点名 ⇒ 不猜')
  assert.equal(pickMonthId([], '202609'), '202609', '点名了就直接用（列表没读到也不影响指定月份）')
  /** 今天（2025 年）在列表里没有对应月份；而唯一那条 `ifCurrent` 就是服务端的"当前" ⇒ 按第 ① 条用它 */
  assert.equal(pickMonthId(MONTHS, '', new Date(2025, 0, 1)), '202611')
  assert.equal(pickMonthId(MONTHS.map((m) => ({ ...m, isCurrent: false })), '', new Date(2025, 0, 1)), '')
  const two = [...MONTHS, { monthId: '202611b', monthName: '2026年11月', isCurrent: true }]
  assert.equal(pickMonthId(two, '', new Date(2026, 10, 10)), '202611', '标了两条 ifCurrent 时按今天那一月挑')
})

// ---------------------------------------------------------------- ⑧ 批量选择与批量结果

test('toggleSelection：点一下加、再点一下拿掉；空 id 不进集合（也不影响已有勾选）', () => {
  const s0 = new Set(['a'])
  const s1 = toggleSelection(s0, 'b')
  assert.deepEqual([...s1].sort(), ['a', 'b'])
  assert.deepEqual([...s0], ['a'], '必须返回新集合，不改入参')
  const s2 = toggleSelection(s1, 'a')
  assert.deepEqual([...s2], ['b'], '再点一次 = 拿掉')
  assert.deepEqual([...toggleSelection(s2, '   ')], ['b'], '空白 id 不算一次勾选')
  assert.deepEqual([...toggleSelection(s2, '')], ['b'])
  /** 传进来的历史数据里混了空串/undefined ⇒ 顺手清掉（老状态可能是界面直接塞的） */
  assert.deepEqual([...toggleSelection(['a', '', '  '], 'c')].sort(), ['a', 'c'])
})

test('setSelection：全选 / 清空只动传进来的那批 id（跨天勾选不会被"清空"误伤别天）', () => {
  const all = setSelection(new Set<string>(), ['a', 'b', 'c'], true)
  assert.deepEqual([...all].sort(), ['a', 'b', 'c'])
  const partial = setSelection(all, ['a', 'c'], false)
  assert.deepEqual([...partial], ['b'], '只拿掉 a/c，b 保留')
  /** 清空时传空数组 ⇒ 什么都不动（不是"清空全部"，那是另一个语义） */
  assert.deepEqual([...setSelection(partial, [], false)], ['b'])
})

test('🔴 summarizeBatch：成功 + 失败必须等于总数，且失败项都带人话原因（"导入失败要有提示"的机械保证）', () => {
  const s = summarizeBatch([
    { name: 'A.zip', ok: true, message: '已导入 12 点' },
    { name: 'B.zip', ok: false, message: '这不是「龙猫天堂」导出的路径包（缺少 kind 标记）' },
    { name: 'C.zip', ok: true, message: '已导入 30 点' },
    { name: 'D.zip', ok: false, message: '已有一个预设叫「东操场」' },
  ])
  assert.equal(s.total, 4)
  assert.equal(s.okCount + s.failCount, s.total, '一条都不许被吞掉')
  assert.equal(s.ok.length, 2)
  assert.equal(s.failed.length, 2)
  assert.ok(s.failed.every((f) => f.message.trim()), '失败项必须写明原因')
  assert.match(s.text, /成功 2 条/)
  assert.match(s.text, /失败 2 条/)

  const allOk = summarizeBatch([{ name: 'A.zip', ok: true, message: 'ok' }])
  assert.match(allOk.text, /全部成功/)
  assert.doesNotMatch(allOk.text, /失败/)

  const allBad = summarizeBatch([{ name: 'A.zip', ok: false, message: '坏包' }])
  assert.match(allBad.text, /全部失败/)
  assert.equal(allBad.okCount, 0)

  const empty = summarizeBatch([])
  assert.equal(empty.total, 0)
  assert.match(empty.text, /没有可处理/)
})

test('batchImportCandidates：不传 index = 包里几条就全要；传了就只挑那几条（越界/非数字都安全）', () => {
  const items = [
    { name: 'a', lineId: '', lineName: '', points: [{ latitude: 1, longitude: 2 }], meta: {} as never },
    { name: 'b', lineId: '', lineName: '', points: [], meta: {} as never },
    { name: 'c', lineId: '', lineName: '', points: [], meta: {} as never },
  ]
  assert.equal(batchImportCandidates(items).length, 3, '不传 = 全导（批量口径）')
  assert.deepEqual(batchImportCandidates(items, [0, 2]).map((x) => x.name), ['a', 'c'])
  assert.deepEqual(batchImportCandidates(items, [9, -1]).map((x) => x.name), [], '越界一律不要')
  assert.deepEqual(batchImportCandidates(items, [0, 0]).map((x) => x.name), ['a'], '去重')
})

test('🔴 批量分享包：多条装一个包、能整包读回来（每条的点数与场次号都不串）', async () => {
  const bundle = buildShareBundle([
    { name: '第一天', lineId: '', lineName: '', points: circle(100, 8), meta: { date: '2026-11-01', scoreId: 's1', km: 3.1, usedTime: '00:20:00', fitDegree: 0.9, sourcePoints: 8, lapLengthM: 600, exportedAt: '2026-11-10T00:00:00.000Z' } },
    { name: '第二天', lineId: '', lineName: '', points: circle(120, 12), meta: { date: '2026-11-02', scoreId: 's2', km: 4.2, usedTime: '00:25:00', fitDegree: 0.95, sourcePoints: 12, lapLengthM: 700, exportedAt: '2026-11-10T00:00:00.000Z' } },
  ])
  assert.equal(bundle.items.length, 2)
  const zip = createZip([{ name: REAL_PATH_BUNDLE_FILE, data: Buffer.from(JSON.stringify(bundle), 'utf8') }])
  const back = await readShareBundleFromZip(new Uint8Array(zip))
  assert.equal(back.ok, true, back.error)
  assert.equal(back.items.length, 2, '两条都要在')
  assert.deepEqual(back.items.map((x) => x.name), ['第一天', '第二天'])
  assert.deepEqual(back.items.map((x) => x.points.length), [8, 12])
  assert.deepEqual(back.items.map((x) => x.meta.scoreId), ['s1', 's2'])
  /** 逐条落库的候选 = 整包（批量导入默认全收） */
  assert.equal(batchImportCandidates(back.items).length, 2)
})

// ---------------------------------------------------------------- ⑨ 随机后缀 / 包内多文件（2026-11-10 二次改版）

test('randomNameSuffix：定长、只用小写字母数字、注入随机源可复现', () => {
  const s = randomNameSuffix(4, () => 0)
  assert.equal(s.length, 4, '默认 4 位')
  assert.equal(s, 'aaaa', 'rand()=0 ⇒ 全落在字符集第一位')
  assert.match(randomNameSuffix(6), /^[a-z0-9]{6}$/, '默认随机源也只出小写字母数字')
  /** 长度夹在 1~12：传 0 / 负数 / 巨大值都不会炸，也不会造出超长名字 */
  assert.equal(randomNameSuffix(0).length, 4, '0 视为非法 ⇒ 回默认 4')
  assert.equal(randomNameSuffix(-3).length, 4)
  assert.equal(randomNameSuffix(999).length, 12, '上限 12')
})

test('withRandomSuffix：自动名末尾追加 -xxxx；已经带过后缀的不再叠一层', () => {
  const base = '天目湖-西操场 · 真实路径 2026-09-17 · 1910'
  const once = withRandomSuffix(base, () => 0)
  assert.equal(once, `${base}-aaaa`)
  assert.equal(withRandomSuffix(once, () => 0), once, '已经有 -xxxx 形状 ⇒ 原样返回（不叠第二层）')
  assert.equal(withRandomSuffix('   ', () => 0), '', '空白输入 ⇒ 空白（不造出光秃秃的后缀）')
  /** 用户手打的名字**不该**被这个函数碰到 —— 界面只对自动名调它（见 RealPathView 的 rebuildAutoName） */
  assert.match(withRandomSuffix('我的外道', () => 0), /^我的外道-[a-z0-9]{4}$/)
})

test('sanitizeZipEntryName：去掉路径分隔符与控制字符、补 .json、按码点限长', () => {
  assert.equal(sanitizeZipEntryName('东操场 2026-09-17'), '东操场 2026-09-17.json')
  assert.equal(sanitizeZipEntryName('a/b\\c'), 'abc.json', '分隔符一律删掉（ZIP 不许以 / 开头的绝对路径）')
  assert.equal(sanitizeZipEntryName('a:b*c?d"e<f>g|h'), 'abcdefgh.json')
  assert.equal(sanitizeZipEntryName('  多   空白  '), '多 空白.json', '折叠连续空白')
  assert.equal(sanitizeZipEntryName('已带.json'), '已带.json', '已有 .json 不再补')
  assert.equal(sanitizeZipEntryName(''), '真实路径.json', '空白 ⇒ 兜底名（绝不产生空条目名）')
  assert.equal(Array.from(sanitizeZipEntryName('名'.repeat(200))).length, 80 + '.json'.length, '按码点限长 80 再补后缀')
})

test('🔴 批量包：**每条路径一个独立 JSON**，逐个能读回来、条数与内容都不串（用户口径）', async () => {
  const items = [
    { name: '路径甲-aaaa', lineId: '', lineName: '', points: circle(100, 8), meta: { date: '2026-11-01', scoreId: 's1', km: 3.1, usedTime: '00:20:00', fitDegree: 0.9, sourcePoints: 8, lapLengthM: 600, exportedAt: '2026-11-10T00:00:00.000Z' } },
    { name: '路径乙-bbbb', lineId: '', lineName: '', points: circle(120, 12), meta: { date: '2026-11-02', scoreId: 's2', km: 4.2, usedTime: '00:25:00', fitDegree: 0.95, sourcePoints: 12, lapLengthM: 700, exportedAt: '2026-11-10T00:00:00.000Z' } },
    { name: '路径丙-cccc', lineId: '', lineName: '', points: circle(90, 20), meta: { date: '2026-11-03', scoreId: 's3', km: 5.0, usedTime: '00:30:00', fitDegree: 0.99, sourcePoints: 20, lapLengthM: 800, exportedAt: '2026-11-10T00:00:00.000Z' } },
  ]
  /** 客户端就是这么装的：每条一个文件，条目名 = 清洗过的路径名 */
  const zip = createZip(items.map((it) => ({ name: sanitizeZipEntryName(it.name), data: Buffer.from(bundleJsonOf(it), 'utf8') })))
  const back = await readAllShareItemsFromZip(new Uint8Array(zip))
  assert.equal(back.ok, true, back.error)
  assert.equal(back.items.length, 3, '包内 3 条路径都要读出来')
  assert.deepEqual(back.items.map((x) => x.item.name), ['路径甲-aaaa', '路径乙-bbbb', '路径丙-cccc'])
  assert.deepEqual(back.items.map((x) => x.item.meta.scoreId), ['s1', 's2', 's3'])
  assert.deepEqual(back.items.map((x) => x.item.points.length), [8, 12, 20])
  assert.deepEqual(back.items.map((x) => x.entryName), ['路径甲-aaaa.json', '路径乙-bbbb.json', '路径丙-cccc.json'])
  assert.equal(back.skipped.length, 0, '没有坏条目')
})

test('🔴 多包遍历：包 A 装 1 条 + 包 B 装 2 条 ⇒ 合计 3 条（用户举例）', async () => {
  const mk = (name, scoreId, n) => ({
    name,
    lineId: '',
    lineName: '',
    points: circle(100, n),
    meta: { date: '2026-11-01', scoreId, km: 3, usedTime: '00:20:00', fitDegree: 0.9, sourcePoints: n, lapLengthM: 600, exportedAt: '2026-11-10T00:00:00.000Z' },
  })
  const zipA = createZip([{ name: sanitizeZipEntryName('包A唯一一条'), data: Buffer.from(bundleJsonOf(mk('包A唯一一条', 'a1', 10)), 'utf8') }])
  const zipB = createZip([
    { name: sanitizeZipEntryName('包B第一条'), data: Buffer.from(bundleJsonOf(mk('包B第一条', 'b1', 11)), 'utf8') },
    { name: sanitizeZipEntryName('包B第二条'), data: Buffer.from(bundleJsonOf(mk('包B第二条', 'b2', 12)), 'utf8') },
  ])
  /** 显式标注元素类型：空数组字面量会被推断成 `never[]`（TS 会因此拦下 push） */
  const all: { entryName: string; item: { meta: { scoreId: string } } }[] = []
  for (const buf of [zipA, zipB]) {
    const parsed = await readAllShareItemsFromZip(new Uint8Array(buf))
    assert.equal(parsed.ok, true, parsed.error)
    all.push(...parsed.items)
  }
  assert.equal(all.length, 3, '1 + 2 = 3')
  assert.deepEqual(all.map((x) => x.item.meta.scoreId), ['a1', 'b1', 'b2'])
})

test('多文件包：坏条目只跳它自己（不拖垮同包里的好条目），原因如实回报', async () => {
  const good = {
    name: '好的那条',
    lineId: '',
    lineName: '',
    points: circle(100, 10),
    meta: { date: '2026-11-01', scoreId: 'g1', km: 3, usedTime: '00:20:00', fitDegree: 0.9, sourcePoints: 10, lapLengthM: 600, exportedAt: '2026-11-10T00:00:00.000Z' },
  }
  const zip = createZip([
    { name: '好的.json', data: Buffer.from(bundleJsonOf(good), 'utf8') },
    { name: '不是路径包.json', data: Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8') },
    /** 坐标全坏 ⇒ parseShareBundle 会拒它 */
    { name: '坐标全坏.json', data: Buffer.from(JSON.stringify({ kind: 'totoro-real-path', version: 1, items: [{ name: 'x', points: [{ latitude: 1, longitude: 2 }], meta: {} }] }), 'utf8') },
  ])
  const back = await readAllShareItemsFromZip(new Uint8Array(zip))
  assert.equal(back.ok, true, '有好的就整体 ok')
  assert.equal(back.items.length, 1, '只收下好的那条')
  assert.equal(back.items[0]!.item.meta.scoreId, 'g1')
  assert.equal(back.skipped.length, 2, '两个坏条目都要被记下（不许静默丢）')
  assert.ok(back.skipped.every((s) => s.reason.trim()), '每个跳过项都要有原因')
  assert.ok(back.skipped.some((s) => /缺少 kind 标记/.test(s.reason)), JSON.stringify(back.skipped))
})

test('多文件包：全部条目都坏 ⇒ 包级失败并说明原因（不假装成功）', async () => {
  const zip = createZip([{ name: 'x.json', data: Buffer.from(JSON.stringify({ nope: 1 }), 'utf8') }])
  const back = await readAllShareItemsFromZip(new Uint8Array(zip))
  assert.equal(back.ok, false)
  assert.equal(back.items.length, 0)
  assert.ok(back.error.length > 0, '必须给出人话原因')
  assert.match(back.error, /缺少 kind 标记|没有可用/)
})

// ---------------------------------------------------------------- ⑩ 地点归属判定（2026-11-10）

/** 造一个"东操场"级别的线路：以 (31.99, 118.84) 为心的方框 */
const squareLine = (lat: number, lng: number, halfM = 60) => [
  { latitude: lat + halfM / mLat, longitude: lng - halfM / mLng },
  { latitude: lat + halfM / mLat, longitude: lng + halfM / mLng },
  { latitude: lat - halfM / mLat, longitude: lng + halfM / mLng },
  { latitude: lat - halfM / mLat, longitude: lng - halfM / mLng },
  { latitude: lat + halfM / mLat, longitude: lng - halfM / mLng },
]

const EAST = { value: "line-east", title: "东操场", pointList: squareLine(31.99, 118.84) }
const WEST = { value: "line-west", title: "西操场", pointList: squareLine(32.01, 118.87) }
const LOCAL = { value: "local:free", title: "本机跑道（不属于任何官方线路）" }
const PLACES = [EAST, WEST, LOCAL]

test("resolvePlace ①：包里写了 lineId 且本机有 ⇒ 直接用它（最可靠）", () => {
  const r = resolvePlace({ lineId: "line-west", lineName: "东操场", points: circle(100, 20) }, PLACES)
  assert.equal(r.via, "bundle-id")
  assert.equal(r.place?.value, "line-west", "ID 命中优先于名字（名字可能对不上）")
  assert.match(r.reason, /包里写明/)
})

test("resolvePlace ②：包里 lineId 本机没有，但**名字**唯一对上 ⇒ 按名字归位", () => {
  const r = resolvePlace({ lineId: "someone-else-id", lineName: "东操场", points: circle(100, 20) }, PLACES)
  assert.equal(r.via, "bundle-name")
  assert.equal(r.place?.value, "line-east")
  assert.match(r.reason, /按地点名/)
})

test("resolvePlace ②：名字**重复**时不猜（两个校区都有「东操场」）⇒ 交给几何", () => {
  const dup = [EAST, { ...WEST, title: "东操场" }, LOCAL]
  const onEast = circle(100, 24, false)
  const r = resolvePlace({ lineId: "", lineName: "东操场", points: onEast }, dup)
  assert.notEqual(r.via, "bundle-name", "同名多条时不许按名字硬猜")
})

test("resolvePlace ③：旧包没有地点信息 ⇒ 按**轨迹位置**归位（这是旧包唯一的自动办法）", () => {
  /** 轨迹贴着东操场那个方框 */
  const eastTrail = squareLine(31.99, 118.84, 50)
  const r = resolvePlace({ lineId: "", lineName: "", points: eastTrail }, PLACES)
  assert.equal(r.via, "geometry")
  assert.equal(r.place?.value, "line-east")
  assert.ok(typeof r.distM === "number" && r.distM < 150, "最近距离要报出来")
  assert.match(r.reason, /按轨迹位置匹配/)
})

test("🔴 resolvePlace ④：哪一条都不成立 ⇒ none（界面据此弹「选择存档地点」）", () => {
  /** 离两条线路都很远（>150 m） */
  const far = circle(100, 20).map((p) => ({ latitude: p.latitude + 0.02, longitude: p.longitude + 0.02 }))
  const r = resolvePlace({ lineId: "nobody", lineName: "不存在的操场", points: far }, PLACES)
  assert.equal(r.via, "none")
  assert.equal(r.place, null, "认不出来就必须是 null，**不许硬塞一个地点**")
  assert.match(r.reason, /不存在|匹配不上/)
})

test("resolvePlace：空选项表 ⇒ 一律 none（不崩、不猜）", () => {
  const r = resolvePlace({ lineId: "line-east", lineName: "东操场", points: circle(100, 20) }, [])
  assert.equal(r.via, "none")
  assert.equal(r.place, null)
})

test("🔴 分享包里**必须带着地点**（导出时写值，读回来还在）—— 这是「导入东操场路径却没进东操场」的根因", () => {
  const pts = circle(100, 24)
  const item = {
    name: "东操场那条",
    lineId: "line-east",
    lineName: "东操场",
    points: pts,
    meta: { date: "2026-09-17", scoreId: "s1", km: 3.2, usedTime: "00:19:28", fitDegree: 0.98, sourcePoints: pts.length, lapLengthM: 620, exportedAt: "2026-11-10T00:00:00.000Z" },
  }
  const bundle = buildShareBundle([item])
  assert.equal(bundle.items[0]!.lineId, "line-east", "lineId 必须进包")
  assert.equal(bundle.items[0]!.lineName, "东操场", "lineName 必须进包")
  /** 读回来之后仍能据此归位 */
  const back = parseShareBundle(JSON.parse(JSON.stringify(bundle)))
  assert.equal(back.ok, true)
  const r = resolvePlace(back.items[0]!, PLACES)
  assert.equal(r.place?.value, "line-east", "读回来要能直接归到东操场")
})

// ── 🆕 2026-11-18：真实路径的配速/用时改用**归档里的真实用时**（用户问"为什么配速是固定数值"）──

test("🔴 resolveRealPathPace：用归档真实用时反算配速（不再是固定的「配速策略」值）", () => {
  // 3.2 km 用了 19 分 28 秒 = 1168 s ⇒ 365 s/km = 6'05"
  const r = resolveRealPathPace("00:19:28", 3.2)!
  assert.ok(r, "读得出就必须有值")
  assert.equal(r.usedTimeSeconds, 1168)
  assert.equal(r.paceSecPerKm, 365)
})

test("resolveRealPathPace：配速不是整分钟、且随记录变化（每次跑的用时不同 ⇒ 配速不同）", () => {
  const a = resolveRealPathPace("00:20:13", 3.21)!
  const b = resolveRealPathPace("00:23:41", 3.21)!
  assert.equal(a.usedTimeSeconds, 1213)
  assert.equal(a.paceSecPerKm, Math.round(1213 / 3.21))
  assert.notEqual(a.paceSecPerKm, b.paceSecPerKm, "两次真实跑必须给出不同配速")
})

test("resolveRealPathPace：HH:mm 形态也认（服务端原文可能是两种写法）", () => {
  assert.equal(resolveRealPathPace("19:28", 3.2)?.usedTimeSeconds, 1168)
})

test("resolveRealPathPace：读不出 ⇒ null（老数据没有 usedTime，回落到旧行为）", () => {
  assert.equal(resolveRealPathPace("", 3.2), null)
  assert.equal(resolveRealPathPace("abc", 3.2), null)
  assert.equal(resolveRealPathPace("00:00:00", 3.2), null, "0 秒不算有效用时")
  assert.equal(resolveRealPathPace(null as unknown as string, 3.2), null)
  assert.equal(resolveRealPathPace(undefined as unknown as string, 3.2), null)
})

test("resolveRealPathPace：里程无效 ⇒ null（不许拿 0 去除）", () => {
  assert.equal(resolveRealPathPace("00:19:28", 0), null)
  assert.equal(resolveRealPathPace("00:19:28", Number.NaN), null)
  assert.equal(resolveRealPathPace("00:19:28", -1), null)
})

test("resolveRealPathPace：配速超出常见范围 ⇒ null（坏数据当没有，与 buildRunStats 同口径）", () => {
  // 3600 s 跑 100 km = 36 s/km，比 2'00" 快得多 ⇒ 坏数据
  assert.equal(resolveRealPathPace("01:00:00", 100), null)
  // 60 s 跑 0.1 km = 600 s/km？不超；改用 60 s 跑 0.01 km = 6000 s/km > 20'00"
  assert.equal(resolveRealPathPace("00:01:00", 0.01), null)
  // 边界：2'00"=120 与 20'00"=1200 都收；119 / 1201 都不收
  assert.ok(resolveRealPathPace("00:02:00", 1))
  assert.ok(resolveRealPathPace("00:20:00", 1))
  assert.equal(resolveRealPathPace("00:01:59", 1), null)
  assert.equal(resolveRealPathPace("00:20:01", 1), null)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 🆕 2026-11-27（用户口径）：**真实路径的首尾修剪**（`planRealPathTrim`）
 *
 * 用户原话要点（2026-11-27）："在跑步界面…可以将相关的数据点进行修剪，也就是[删掉]起点和终点
 *  左右的数据点，并确保最终形成的长度是大于课程要求的，然后再进入后面的计算，这样的话可以减少重复度；
 *  这类计算是在计算配速之前发生的。"
 * 🔄 2026-11-28 用户更正：**只截断末尾、不截断开始**（起点保持原点列第 0 点 ⇒ 轨迹开头与那场真跑一致）。
 * 口径：① 只裁末尾、保留原点列的连续前缀；② 数量随机（余量的 10%~95%）；
 *  ③ 下限 = 要求 × (1 + 0.3%~4%)；④ 每次载入重随机。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 沿纬线向东的一条直线点列（每点约 `stepM` 米，总长约 `totalM` 米） */
const straight = (totalM: number, stepM = 3): RealPathPoint[] => {
  const n = Math.max(2, Math.round(totalM / stepM) + 1)
  return Array.from({ length: n }, (_, i) => ({ latitude: 31.99, longitude: 118.84 + (i * stepM) / mLng }))
}

test('planRealPathTrim：只裁末尾（起点原样），裁后里程 ≥ 要求×(1+0.3%~4%) 且严格小于原始', () => {
  const points = straight(3270)
  const plan = planRealPathTrim(points, { entryId: 'e1', requiredKm: 2 })
  assert.equal(plan.skipped, '')
  assert.equal(plan.entryId, 'e1')
  assert.equal(plan.sourcePoints, points.length)
  assert.equal(plan.trimStartM, 0, '2026-11-28 口径：起点不许动')
  assert.ok(plan.trimEndM > 0, '末尾必须真的裁掉一段')
  assert.ok(plan.keptPoints < plan.sourcePoints, '点数必须变少')
  assert.ok(plan.trimmedKm < plan.originalKm, '修剪后必须更短')
  // ① 下限：≥ 要求 × (1 + 本次抽到的超跑系数)
  assert.ok(plan.trimmedKm * 1000 + 0.5 >= 2000 * (1 + plan.overshootRatio), `裁后 ${plan.trimmedKm} km 越过了下限`)
  // ② 幅度：余量里只吃掉 10%~95% ⇒ 裁后落在 [原始 − 95% 余量, 原始 − 10% 余量]
  const floorM = 2000 * (1 + plan.overshootRatio)
  const budgetM = plan.originalKm * 1000 - floorM
  assert.ok(plan.trimmedKm * 1000 >= plan.originalKm * 1000 - 0.95 * budgetM - 3)
  assert.ok(plan.trimmedKm * 1000 <= plan.originalKm * 1000 - 0.1 * budgetM + 3)
  // 裁掉的量 = 原始 − 修剪后（末尾按点取整 ⇒ 最多差一个采样点）
  const cutM = plan.originalKm * 1000 - plan.trimmedKm * 1000
  assert.ok(Math.abs(cutM - plan.trimEndM) <= 3.5, `理论裁 ${plan.trimEndM} m、实测裁 ${cutM} m`)
})

test('planRealPathTrim：随机源固定 ⇒ 比例可复现（rng=0 ⇒ 余量吃 10%，全在末尾）', () => {
  const points = straight(3270)
  const plan = planRealPathTrim(points, { requiredKm: 2, rng: () => 0 })
  assert.ok(Math.abs(plan.overshootRatio - REAL_PATH_TRIM_OVERSHOOT[0]) < 1e-9)
  const budgetM = plan.originalKm * 1000 - 2000 * (1 + REAL_PATH_TRIM_OVERSHOOT[0])
  const expectTrimM = budgetM * REAL_PATH_TRIM_RATIO[0]
  assert.ok(Math.abs(plan.trimEndM - expectTrimM) <= 0.3, '裁量 = 余量 × 10%')
  assert.equal(plan.trimStartM, 0, '起点不动')
})

test('planRealPathTrim：每次重抽 ⇒ 同一输入多次结果不同（不会每次都是同一个修剪量）', () => {
  const points = straight(3270)
  const seen = new Set<number>()
  for (let i = 0; i < 20; i++) seen.add(planRealPathTrim(points, { requiredKm: 2 }).trimmedKm)
  assert.ok(seen.size >= 15, `20 次里应至少 15 个不同值，实际 ${seen.size}`)
})

test('planRealPathTrim：随机 100 次都不越下限（"确保最终长度大于课程要求"）', () => {
  const points = straight(3270)
  for (let i = 0; i < 100; i++) {
    const plan = planRealPathTrim(points, { requiredKm: 2 })
    assert.equal(plan.skipped, '')
    assert.ok(plan.trimmedKm * 1000 + 0.5 >= 2000 * (1 + plan.overshootRatio), `第 ${i} 次越线：${plan.trimmedKm} km`)
    assert.ok(plan.trimmedKm > 2, `第 ${i} 次裁到不满足课程要求：${plan.trimmedKm} km`)
    assert.equal(plan.trimStartM, 0, `第 ${i} 次动了起点`)
  }
})

test('planRealPathTrim：余量不足（原始只比要求多几米）⇒ 不修剪并给出原因', () => {
  const points = straight(2003)
  const plan = planRealPathTrim(points, { requiredKm: 2 })
  assert.ok(plan.skipped.length > 0)
  assert.match(plan.skipped, /不够修剪|已低于下限/)
  assert.equal(plan.keptPoints, plan.sourcePoints, '不修剪 ⇒ 点列原样')
  assert.equal(plan.trimmedKm, plan.originalKm)
  assert.equal(plan.trimStartM, 0)
  assert.equal(plan.trimEndM, 0)
  // 判据的边界也钉一下：余量刚好等于阈值（5 m）时仍不裁（用 `>` 而不是 `>=`）
  const edge = straight(2000 * (1 + REAL_PATH_TRIM_OVERSHOOT[1]) + REAL_PATH_TRIM_MIN_BUDGET_M, 1)
  assert.ok(planRealPathTrim(edge, { requiredKm: 2, rng: () => 1 }).skipped.length > 0)
})

test('planRealPathTrim：没有要求里程 / 点太少 ⇒ 不修剪（绝不硬造一段）', () => {
  const points = straight(3270)
  assert.match(planRealPathTrim(points, { requiredKm: 0 }).skipped, /要求里程/)
  assert.match(planRealPathTrim(points, { requiredKm: Number.NaN }).skipped, /要求里程/)
  assert.match(planRealPathTrim(points.slice(0, 3), { requiredKm: 2 }).skipped, /点太少/)
})

test('planRealPathTrim：保留的是原点列的前缀（起点不动、不重排、不插值、不改坐标）', () => {
  const points = straight(3270)
  const plan = planRealPathTrim(points, { requiredKm: 2 })
  const first = plan.points[0]!
  const startIndex = points.findIndex((p) => p.latitude === first.latitude && p.longitude === first.longitude)
  assert.equal(startIndex, 0, '2026-11-28 口径：首点必须还是原点列第 0 点')
  const last = plan.points[plan.points.length - 1]!
  const endIndex = points.findIndex((p) => p.latitude === last.latitude && p.longitude === last.longitude)
  assert.ok(endIndex < points.length - 1, '尾点必须前移（终点真的挪开了）')
  assert.equal(endIndex - startIndex + 1, plan.keptPoints, '保留点数必须是这一段连续子段')
  for (let k = 0; k < plan.points.length; k++) {
    assert.equal(plan.points[k]!.longitude, points[startIndex + k]!.longitude, `第 ${k} 点必须是原点列的同一点`)
  }
})

test('realPathTrimText：裁了报数量、没裁如实说原因（不粉饰）', () => {
  const points = straight(3270)
  const trimmed = realPathTrimText(planRealPathTrim(points, { requiredKm: 2 }))
  assert.match(trimmed, /km → /)
  assert.match(trimmed, /点/)
  assert.match(realPathTrimText(planRealPathTrim(points, { requiredKm: 0 })), /不修剪/)
  assert.equal(realPathTrimText(null), '')
  assert.equal(realPathTrimText(undefined), '')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 🆕 2026-11-28（用户口径）：**重采样**（`resampleRealPath`）＋ 完整几何计划（`planRealPathGeometry`）
 *
 * 用户原话："添加插值算法，在保证原版的前提下，对数据点进行重插值处理；也就是整体为连续的线，
 *  你写个算法让最终的轨迹和原版差不多，但是数据点发生变化。"
 * 确认过的参数：点距按本机 22 条真实路径实测（均值 3.42 m、逐段 ±30%）；复现 0~2 处 10~30 m 断点；
 *  点严格落在原折线上（不加横向噪声）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 点到整条折线的最短距离（米）——"新点是不是还在原来那条线上"的判据 */
const distToPolyline = (p: RealPathPoint, line: RealPathPoint[]): number => {
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const d = pointToSegmentM(p, line[i - 1]!, line[i]!)
    if (d < best) best = d
  }
  return best
}

test('resampleRealPath：首尾原样、总长不变、点数 ≈ 总长 ÷ 3.42 m', () => {
  const points = straight(3270)
  const before = pathLengthM(points)
  const plan = resampleRealPath(points, { rng: () => 0.5 })
  assert.equal(plan.skipped, '')
  assert.equal(plan.sampledPoints, plan.points.length)
  assert.deepEqual(plan.points[0], points[0], '首点必须与原版完全一致')
  assert.deepEqual(plan.points[plan.points.length - 1], points[points.length - 1], '尾点必须与原版完全一致')
  const after = pathLengthM(plan.points)
  assert.ok(Math.abs(after - before) < 1, `总长必须不变：${before.toFixed(2)} → ${after.toFixed(2)}`)
  assert.ok(Math.abs(plan.sampledPoints - Math.round(before / 3.42)) <= 3, `点数 ${plan.sampledPoints} 应≈ ${Math.round(before / 3.42)}`)
})

test('resampleRealPath：新点全部落在原折线上（"线还是那条线，只是点换了一批"）', () => {
  const points = straight(3270)
  const plan = resampleRealPath(points, { rng: () => 0.7 })
  let worst = 0
  for (const p of plan.points) worst = Math.max(worst, distToPolyline(p, points))
  assert.ok(worst < 0.5, `最大离线距离 ${worst.toFixed(3)} m（应 < 0.5 m）`)
})

test('resampleRealPath：步长按实测密度（均值≈3.42、逐段 ±30%）', () => {
  const points = straight(3270)
  const plan = resampleRealPath(points, { rng: () => 0.5, gapMaxCount: 0 })
  const steps: number[] = []
  for (let i = 1; i < plan.points.length; i++) steps.push(pathLengthM([plan.points[i - 1]!, plan.points[i]!]))
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length
  const min = Math.min(...steps)
  const max = Math.max(...steps)
  assert.ok(Math.abs(mean - 3.42) < 0.05, `均值 ${mean.toFixed(3)} 应≈ 3.42`)
  assert.ok(min >= 3.42 * 0.7 - 0.05 && max <= 3.42 * 1.3 + 0.05, `步长范围 ${min.toFixed(2)}~${max.toFixed(2)} 越界`)
})

test('resampleRealPath：断点 0~2 处、10~30 m；gapMaxCount=0 时一处都没有', () => {
  const points = straight(3270)
  const counts = new Set<number>()
  for (let i = 0; i < 20; i++) counts.add(resampleRealPath(points, {}).gapCount)
  assert.deepEqual([...counts].sort(), [0, 1, 2], `20 次里断点数应覆盖 0/1/2，实际 ${[...counts].join(',')}`)
  const none = resampleRealPath(points, { gapMaxCount: 0 })
  assert.equal(none.gapCount, 0)
  // 有断点时一定出现 ≥10 m 的跳点
  let sawGap = false
  for (let i = 0; i < 20 && !sawGap; i++) {
    const plan = resampleRealPath(points, { rng: Math.random, gapMaxCount: 2 })
    for (let k = 1; k < plan.points.length; k++) {
      if (pathLengthM([plan.points[k - 1]!, plan.points[k]!]) >= 10) {
        sawGap = true
        break
      }
    }
  }
  assert.ok(sawGap, '20 次里应至少出现一次 ≥10 m 的断点')
})

test('resampleRealPath：随机源相同 ⇒ 结果完全可复现；点太少/路径太短 ⇒ 不重采样', () => {
  const points = straight(3270)
  const seed = () => {
    let x = 12345
    return () => {
      x = (x * 1103515245 + 12345) % 2147483648
      return x / 2147483648
    }
  }
  const a = resampleRealPath(points, { rng: seed() })
  const b = resampleRealPath(points, { rng: seed() })
  assert.deepEqual(a.points, b.points)
  assert.deepEqual(resampleRealPath(points.slice(0, 2), {}).points.length, 2)
  assert.match(resampleRealPath(points.slice(0, 2), {}).skipped, /点太少/)
  /** 点不少但总长只有 3 m ⇒ 走「太短」那条分支（点数判据在它前面，所以这里要造多条短边） */
  assert.match(resampleRealPath(straight(3, 0.5), {}).skipped, /太短/)
})

test('planRealPathGeometry：4 km 路径 / 要求 3.2 km ⇒ 先裁末尾再重采样，里程落在 3.25~3.93 km', () => {
  const points = straight(4000)
  const plan = planRealPathGeometry(points, { entryId: 'e9', requiredKm: 3.2 })
  assert.equal(plan.entryId, 'e9')
  assert.equal(plan.skipped, '')
  assert.equal(plan.trimStartM, 0, '只裁末尾：起点不动')
  assert.ok(plan.trimEndM > 0, '末尾必须裁')
  assert.ok(plan.finalKm > 3.2, `结算里程 ${plan.finalKm} 必须大于课程要求 3.2`)
  assert.ok(plan.finalKm >= 3.2 * 1.003 - 0.001, `必须 ≥ 要求 × 1.003（实际 ${plan.finalKm}）`)
  assert.ok(plan.finalKm <= 4.0, '不许比原版还长')
  assert.ok(plan.sampledPoints > 100, `重采样点数 ${plan.sampledPoints}`)
  assert.deepEqual(plan.points[0], points[0], '起点仍是原点列第 0 点')
})

test('planRealPathGeometry：200 次抽样都不越下限，且每次点数/里程都在合理范围', () => {
  const points = straight(4000)
  for (let i = 0; i < 200; i++) {
    const plan = planRealPathGeometry(points, { requiredKm: 3.2 })
    assert.ok(plan.finalKm > 3.2, `第 ${i} 次越线：${plan.finalKm}`)
    assert.ok(plan.finalKm * 1000 + 0.5 >= 3200 * (1 + plan.overshootRatio), `第 ${i} 次低于下限：${plan.finalKm}`)
    /** ⚠️ 采样发生在**修剪之前**（先重采样再裁尾）：点数要跟 resampledKm 对得上，不是 finalKm */
    assert.ok(Math.abs(plan.sampledPoints - Math.round((plan.resampledKm * 1000) / 3.42)) <= 6, `第 ${i} 次点数异常：${plan.sampledPoints}（resampledKm=${plan.resampledKm}）`)
    assert.ok(plan.keptPoints < plan.sampledPoints || plan.skipped !== '', `第 ${i} 次裁尾后点数没变少：${plan.keptPoints}/${plan.sampledPoints}`)
  }
})

test('realPathPlanShortText：一行报完（界面只放这句，完整原因在悬停里）', () => {
  const plan = planRealPathGeometry(straight(4000), { requiredKm: 3.2 })
  const short = realPathPlanShortText(plan)
  assert.match(short, /重采样 \d+ → \d+ 点/)
  assert.match(short, /(尾部裁 \d+ m|未修剪（余量不足）)/)
  assert.match(short, /结算 \d+\.\d\d km/)
  assert.ok(!short.includes('下限'), '短行里不放下限这类细节')
  assert.ok(short.length < 80, `短行要短（实际 ${short.length} 字符）`)
  assert.equal(realPathPlanShortText(null), '')
})

test('realPathPlanText：两段都报数，没做就如实说原因', () => {
  const text = realPathPlanText(planRealPathGeometry(straight(4000), { requiredKm: 3.2 }))
  assert.match(text, /尾部修剪：4\.00 → [\d.]+ km/)
  assert.match(text, /重采样：\d+ → \d+ 点/)
  assert.match(text, /结算里程 [\d.]+ km/)
  const noReq = realPathPlanText(planRealPathGeometry(straight(4000), { requiredKm: 0 }))
  assert.match(noReq, /不修剪/)
  assert.equal(realPathPlanText(null), '')
})
