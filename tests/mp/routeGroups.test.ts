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
import {
  FREE_PATH_PATH,
  drawModeFromQuery,
  freePathDrawLink,
  groupRoutesByCampus,
  warnForSelection,
  toSelectItems,
  trackEditorLink,
  lineIdFromQuery,
  TRACK_EDITOR_PATH,
  ROUTE_CLUSTER_THRESHOLD_M,
} from '../../utils/mp/routeGroups.ts'
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

test('无校区名匹配时：取线路最多的簇为 home 并置 inferred，且标签明确写"推断"', () => {
  const g = groupRoutesByCampus(REAL_LINES, '未知校区名')
  assert.equal(g.inferred, true)
  assert.equal(g.homeCluster!.count, 4) // A 簇 4 条最多
  assert.ok(g.note.includes('推断'))
  // 关键：**推断**时不许自称"本校区"（否则刷新后误导用户）
  assert.ok(g.homeCluster!.label.includes('推断'), `home 标签：${g.homeCluster!.label}`)
  assert.ok(!g.homeCluster!.label.startsWith('本校区'), `不得写成本校区：${g.homeCluster!.label}`)
})

test('有校区名匹配时：标签直接写"本校区（校区名）"', () => {
  const g = groupRoutesByCampus(REAL_LINES, '天目湖')
  assert.equal(g.inferred, false)
  assert.ok(g.homeCluster!.label.startsWith('本校区（天目湖）'), `home 标签：${g.homeCluster!.label}`)
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

test('toSelectItems：默认不加自定义名（行为逐字不变），传解析器时用用户起的名字', () => {
  const g = groupRoutesByCampus(REAL_LINES, '天目湖')
  // ① 不传解析器 ⇒ 标题里是厂商线路名，且不含自定义名
  const plain = toSelectItems(g)
  const plainTitles = plain.filter((i) => i.value).map((i) => i.title)
  assert.ok(plainTitles.some((t) => t.includes('天目湖-西操场')), plainTitles.join(' | '))
  assert.ok(!plainTitles.some((t) => t.includes('我的外道')), '不传解析器时不应冒出自定义名')

  // ② 传解析器 ⇒ 命中改过名的那条用自定义名，其余保持厂商名
  const withCustom = toSelectItems(g, (id) => (id === 'sunrunLine-20210918000001' ? '我的外道' : undefined))
  const titles = withCustom.filter((i) => i.value).map((i) => i.title)
  assert.ok(titles.some((t) => t.includes('我的外道')), titles.join(' | '))
  assert.ok(!titles.some((t) => t.includes('天目湖-西操场')), '改过名的那条不该再显示厂商名')
  assert.ok(titles.some((t) => t.includes('天目湖-东操场')), '没改名的仍显示厂商名')

  // ③ 解析器返回空白 ⇒ 视同"没改名"，回落厂商名（不能让选项标题变成空白）
  const blank = toSelectItems(g, () => '   ')
  assert.ok(
    blank.filter((i) => i.value).some((t) => t.title.includes('天目湖-西操场')),
    blank.filter((i) => i.value).map((i) => i.title).join(' | '),
  )
  // ④ value（提交用的 lineId）不受改名影响 —— 报文口径零变化
  assert.deepEqual(withCustom.filter((i) => i.value).map((i) => i.value), plain.filter((i) => i.value).map((i) => i.value))
})

// ---------- 🆕 2026-09-22（真实用户实测）：直达「跑道编辑」并**预选线路**的链接 ----------
/**
 * 为什么有这组：跑步页提示"去「跑道编辑」描一条"时，用户跳过去还得**自己在下拉里找那条线路**
 * —— 实测有人因此在别的页面兜了半天、画的东西根本用不上。带 `?line=<pointId>` 后编辑页会直接选中。
 * 写（`trackEditorLink`）与读（`lineIdFromQuery`）必须成对，故一起钉住。
 */
test('trackEditorLink：带 lineId ⇒ 分组后的真实路径 + `?line=`（并对特殊字符做 URL 编码）', () => {
  assert.equal(trackEditorLink('sunrunLine-20210918000001'), '/field/track-editor?line=sunrunLine-20210918000001')
  // 必须用 `/field/track-editor`：旧路径 `/track-editor` 会 redirect，**查询串会被丢掉** ⇒ 预选失效
  assert.equal(TRACK_EDITOR_PATH, '/field/track-editor')
  assert.ok(trackEditorLink('a b&c').startsWith('/field/track-editor?line='))
  assert.equal(trackEditorLink('a b&c'), `/field/track-editor?line=${encodeURIComponent('a b&c')}`, '特殊字符必须编码，否则 query 会被截断')
})

test('trackEditorLink：没有 lineId（空串/null/undefined/空白）⇒ 不带查询串（编辑页自己选线）', () => {
  for (const v of ['', null, undefined, '   ']) {
    assert.equal(trackEditorLink(v), '/field/track-editor', `lineId=${JSON.stringify(v)} 时不该带 ?line=`)
  }
})

test('lineIdFromQuery：与 trackEditorLink 成对（字符串照收；数组/对象/空白/非串 ⇒ 空串）', () => {
  assert.equal(lineIdFromQuery('sunrunLine-1'), 'sunrunLine-1')
  assert.equal(lineIdFromQuery('  sunrunLine-1  '), 'sunrunLine-1', '两端空白要折掉')
  assert.equal(lineIdFromQuery(['sunrunLine-1', 'other']), 'sunrunLine-1', '数组取第一个（路由 query 可能给数组）')
  assert.equal(lineIdFromQuery(undefined), '')
  assert.equal(lineIdFromQuery(null), '')
  assert.equal(lineIdFromQuery(''), '')
  assert.equal(lineIdFromQuery(42), '')
  assert.equal(lineIdFromQuery({ bad: true }), '')
  // 往返：写出来的链接，它的 query 值必须能被读回原值
  const id = 'sunrunLine-20210918000001'
  const q = trackEditorLink(id).split('?line=')[1]!
  assert.equal(lineIdFromQuery(decodeURIComponent(q)), id)
})

// ---------- 🆕 2026-09-23（pre3）：一键跳转去画本机路径 ----------
test('freePathDrawLink：指向「非官方路径【测试】」并带 `?draw=curve`（落地页据此自动进圈型模式）', () => {
  assert.equal(FREE_PATH_PATH, '/field/free-path')
  assert.equal(freePathDrawLink(), '/field/free-path?draw=curve')
  // 写/读成对：链接里的 query 必须能被 `drawModeFromQuery()` 读回 'curve'
  const q = freePathDrawLink().split('?draw=')[1]!
  assert.equal(drawModeFromQuery(q), 'curve')
})

test('drawModeFromQuery：只认 `curve`（数组取第一个；其它/非法 ⇒ 空串 = 不自动进绘制模式）', () => {
  assert.equal(drawModeFromQuery('curve'), 'curve')
  assert.equal(drawModeFromQuery('  curve  '), 'curve')
  assert.equal(drawModeFromQuery(['curve', 'polyline']), 'curve')
  assert.equal(drawModeFromQuery('polyline'), '', '折线型不自动进（用户要求的是圈型那一条）')
  assert.equal(drawModeFromQuery(undefined), '')
  assert.equal(drawModeFromQuery(''), '')
  assert.equal(drawModeFromQuery(42), '')
  assert.equal(drawModeFromQuery({ bad: true }), '')
})
