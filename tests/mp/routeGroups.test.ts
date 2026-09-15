/**
 * 线路按校区分组（routeGroups）测试
 *
 * 夹具 = 9-14 实测真实数据（`_mp-analyze/capture/probe-2026-09-14.json` 的 8 条线路坐标），
 * 三个地理簇：A(教学楼/西操场/图书馆将军路/田径场将军路) ≈ 31.94,118.79；
 * B(田径场/图书馆) ≈ 32.03,118.82；C(天目湖-西/东操场) ≈ 31.37,119.48。
 * 关键语义：**分组看坐标，不靠名称**（实测数据里名称与坐标就有错位，见 ERROR.md/分析文档）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupRoutesByCampus, warnForSelection, ROUTE_CLUSTER_THRESHOLD_M } from '../../utils/mp/routeGroups.ts'
import type { MpRunLine } from '../../src/mp/types.ts'

/** 与探针数据逐字一致的 8 条线路（仅坐标，无 PII） */
const REAL_LINES: MpRunLine[] = [
  { pointId: 'sunrunLine-20210917000004', pointName: '教学楼', pointList: [{ latitude: 31.9392, longitude: 118.78938 }] },
  { pointId: 'sunrunLine-20210917000009', pointName: '田径场', pointList: [{ latitude: 32.03292, longitude: 118.81848 }] },
  { pointId: 'sunrunLine-20210917000010', pointName: '图书馆', pointList: [{ latitude: 32.03585, longitude: 118.81782 }] },
  { pointId: 'sunrunLine-20210918000001', pointName: '天目湖-西操场', pointList: [{ latitude: 31.3732, longitude: 119.4808 }] },
  { pointId: 'sunrunLine-20210918000002', pointName: '天目湖-东操场', pointList: [{ latitude: 31.36895, longitude: 119.489 }] },
  { pointId: 'sunrunLine-20221012000001', pointName: '图书馆 将军路', pointList: [{ latitude: 31.94087, longitude: 118.79451 }] },
  { pointId: 'sunrunLine-20221012000002', pointName: '田径场 将军路', pointList: [{ latitude: 31.93722, longitude: 118.79475 }] },
  { pointId: 'sunrunLine-20230208000001', pointName: '西操场', pointList: [{ latitude: 31.93976, longitude: 118.78699 }] },
]

test('聚类：8 条真实线路按坐标分成 3 簇（A=4 / B=2 / C=2）', () => {
  const g = groupRoutesByCampus(REAL_LINES, '天目湖')
  assert.equal(g.clusters.length, 3)
  const counts = g.clusters.map((c) => c.count).sort((a, b) => b - a)
  assert.deepEqual(counts, [4, 2, 2])
})

test('本校区：campusName=天目湖 → 天目湖两线归 home 簇且默认选天目湖-西操场', () => {
  const g = groupRoutesByCampus(REAL_LINES, '天目湖')
  assert.equal(g.inferred, false)
  const homeNames = g.homeCluster!.routes.map((r) => r.line.pointName).sort()
  assert.deepEqual(homeNames, ['天目湖-东操场', '天目湖-西操场'])
  assert.equal(g.defaultLineId, 'sunrunLine-20210918000001')
})

test('跨校区距离标注：其他簇与本校区距离 ≥ 10km（坐标判定，非名称）', () => {
  const g = groupRoutesByCampus(REAL_LINES, '天目湖')
  for (const c of g.clusters.filter((c) => c.kind === 'other')) {
    assert.ok(c.distanceFromHomeM >= 10000, `簇 ${c.label} 距离 ${c.distanceFromHomeM} 应 ≥ 10km`)
  }
  // 天目湖在地理上离另两个校区 90km 级（名称标"将军路"的线路反而在 31.94 那一簇 —— 名称不可靠的证据）
  const maxAway = Math.max(...g.clusters.filter((c) => c.kind === 'other').map((c) => c.distanceFromHomeM))
  assert.ok(maxAway >= 90000, `最远簇 ${maxAway}m 应 ≥ 90km`)
})

test('无校区名匹配时：取线路最多的簇为 home 并置 inferred', () => {
  const g = groupRoutesByCampus(REAL_LINES, '未知校区名')
  assert.equal(g.inferred, true)
  assert.equal(g.homeCluster!.count, 4) // A 簇 4 条最多
  assert.ok(g.note.includes('推断'))
})

test('无坐标线路被剔除；全空返回空结果', () => {
  const withBad = [...REAL_LINES, { pointId: 'bad', pointName: '坏线路', pointList: [{ latitude: Number.NaN, longitude: Number.NaN }] }]
  const g = groupRoutesByCampus(withBad, '天目湖')
  assert.equal(g.ordered.length, 8) // 坏线路不参与
  const empty = groupRoutesByCampus([], '天目湖')
  assert.equal(empty.clusters.length, 0)
  assert.equal(empty.defaultLineId, '')
})

test('选其他校区线路 → 给出跨校区警告；选本校区 → 无警告', () => {
  const g = groupRoutesByCampus(REAL_LINES, '天目湖')
  const other = g.ordered.find((r) => r.kind === 'other')!
  const home = g.ordered.find((r) => r.kind === 'home')!
  assert.ok(warnForSelection(g, other.line.pointId).includes('其他校区'))
  assert.equal(warnForSelection(g, home.line.pointId), '')
  assert.equal(warnForSelection(g, '不存在'), '')
})

test('阈值常量：3000m 能在"几百米级同簇 / 数公里级异簇"之间切开', () => {
  assert.equal(ROUTE_CLUSTER_THRESHOLD_M, 3000)
})
