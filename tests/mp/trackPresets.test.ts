/**
 * **「一个地点多条预设」的纯逻辑测试**（2026-11-03，1.3.6）
 *
 * 用户原话："一个地点的预设只能创建一个，例如「东操场」点位只能创建一个预设；相关预设应该
 *   一个点位可以创建多个，然后在跑步选择路径的时候可以进行选择；用户选择相关路径，保存预设的时候
 *   可以输入相关名字进行存储，便于用户区分，**预设名称不可以相同**，且预设存储相关创建日期等等一系列信息"。
 *
 * 这里钉住四件事（都是"改坏了不会报错、只会静默骗人"的那一类）：
 *   ① **主键迁移**：旧数据（没有 `id`）读进来 `id === lineId` ⇒ 旧的本机路径选择照旧解析得到；
 *   ② **判重是全库的**，比的是**显示名**（`resolveEntryName` 的结果），不是 `customName` 原始值；
 *   ③ **自动命名不会撞名、也不会因为名称限长而死循环**；
 *   ④ **"这个地点这次用哪条"只有一个判据**（`resolvePresetForLine`），且跨地点绝不串味。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRESET_CHOICE_KEY,
  TRACK_NAME_MAX,
  autoPresetName,
  conflictOwnerText,
  duplicateNameGroups,
  entryDetailRows,
  entryIdOf,
  entrySummaryText,
  findEntryByRef,
  findNameConflict,
  nameKey,
  newTrackPresetId,
  normalizeLibrary,
  parseRefChoiceMap,
  presetsOfLine,
  resolvePresetForLine,
  sanitizeLineName,
  withRefChoice,
  type TrackRouteEntry,
} from '../../utils/mp/trackLibrary.ts'

const pt = (lat: number, lng: number) => ({ latitude: lat, longitude: lng })
const ring = (n = 6, lat = 31.9, lng = 118.7) =>
  Array.from({ length: n }, (_, i) => pt(lat + i * 0.0001, lng + i * 0.0001))

const mk = (over: Partial<TrackRouteEntry> & { id: string; lineId: string }): TrackRouteEntry => ({
  lineName: '东操场',
  outer: ring(6),
  inner: ring(6, 31.9, 118.7),
  createdAt: '2026-11-03T00:00:00.000Z',
  appVersion: '1.3.6',
  ...over,
})

// ---------------------------------------------------------------- ① 主键与迁移

test('newTrackPresetId：格式稳定、同一时刻不同随机数不重复、可注入种子复现', () => {
  const a = newTrackPresetId({ now: 1_760_000_000_000, rand: () => 0.5 })
  const b = newTrackPresetId({ now: 1_760_000_000_000, rand: () => 0.5 })
  assert.equal(a, b, '同一 (时间, 随机数) ⇒ 同一个 id（单测可复现）')
  assert.match(a, /^p-[0-9a-z]+-[0-9a-z]{7}$/, a)
  const c = newTrackPresetId({ now: 1_760_000_000_000, rand: () => 0.25 })
  assert.notEqual(a, c, '随机数不同 ⇒ id 不同')
  // 200 个真随机（不带种子）里不允许重复
  const ids = new Set(Array.from({ length: 200 }, () => newTrackPresetId()))
  assert.equal(ids.size, 200, 'id 必须唯一')
})

test('normalizeLibrary：旧数据（没有 id）迁移成 id = lineId —— 旧的本机路径选择零迁移', () => {
  const out = normalizeLibrary([
    { lineId: 'sunrunLine-east', lineName: '东操场', outer: ring(5), inner: ring(5) },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0]!.id, 'sunrunLine-east', '旧数据的 id 必须等于 lineId（否则旧选择/旧验证脚本全部失效）')
  assert.equal(entryIdOf(out[0]!), 'sunrunLine-east')
})

test('normalizeLibrary：已有 id 的原样保留；id 重复时加后缀，**绝不丢条目**', () => {
  const dup = { id: 'same', lineId: 'L1', lineName: '东操场', outer: ring(5), inner: ring(5) }
  const dup2 = { id: 'same', lineId: 'L2', lineName: '西操场', outer: ring(5), inner: ring(5) }
  const out = normalizeLibrary([dup, dup2])
  assert.equal(out.length, 2)
  assert.equal(out[0]!.id, 'same')
  assert.equal(out[1]!.id, 'same#2', '重复 id 加后缀，两条都保住')
  // 空串/空白 id 也当"没有"，退回 lineId
  const blank = normalizeLibrary([{ id: '  ', lineId: 'L3', lineName: 'x', outer: ring(5), inner: ring(5) }])
  assert.equal(blank[0]!.id, 'L3')
})

// ---------------------------------------------------------------- ② 判重

test('nameKey：折空白 + 去控制字符 + 忽略大小写（判重专用）', () => {
  // ⚠️ 连续空白**折成一个空格**（不是删掉）⇒「东 操场」与「东操场」算两个名字（沿用既有口径）
  assert.equal(nameKey('  东 操场 '), nameKey('东 操场'))
  assert.equal(nameKey('东  操场'), nameKey('东 操场'))
  assert.notEqual(nameKey('东 操场'), nameKey('东操场'))
  assert.equal(nameKey('Loop A'), nameKey('loop a'))
  assert.equal(nameKey('东\u200b操场'), nameKey('东操场'))
  assert.equal(nameKey(''), '')
  assert.equal(nameKey(undefined), '')
})

test('findNameConflict：**全库**判重（含别的地点），比的是显示名；exceptId 排除自己', () => {
  const entries = [
    mk({ id: 'p1', lineId: 'L-east', lineName: '东操场', customName: '内道' }),
    // 旧数据：没有自定义名 ⇒ 显示名就是厂商线路名，它同样**占住**这个名字
    mk({ id: 'L-west', lineId: 'L-west', lineName: '西操场' }),
  ]
  assert.equal(findNameConflict(entries, '内道')?.id, 'p1', '同名（同地点）要能查出来')
  assert.equal(findNameConflict(entries, '西操场')?.id, 'L-west', '旧条目的"厂商名"也是被占用的名字')
  assert.equal(findNameConflict(entries, '  西操场 ')?.id, 'L-west', '判重前要归一化（首尾空白/零宽字符）')
  assert.equal(findNameConflict(entries, '西\u200b操场')?.id, 'L-west', '零宽字符同样不算数')
  assert.equal(findNameConflict(entries, '不存在的名字'), undefined)
  assert.equal(findNameConflict(entries, ''), undefined, '空名字不参与判重（由自动命名兜底）')
  assert.equal(findNameConflict(entries, '内道', 'p1'), undefined, '排除自己 ⇒ 不算冲突')
})

test('conflictOwnerText：跨地点时补上"地点"，同地点/名字即地点名时不重复啰嗦', () => {
  const east = mk({ id: 'p1', lineId: 'L-east', lineName: '东操场', customName: '内道' })
  assert.equal(conflictOwnerText(east, 'L-west'), '内道（地点：东操场）', '别的地点占用时要报地点')
  assert.equal(conflictOwnerText(east, 'L-east'), '内道', '同一地点内不必重复地点')
  const plain = mk({ id: 'L-west', lineId: 'L-west', lineName: '西操场' })
  assert.equal(conflictOwnerText(plain, 'L-east'), '西操场', '名字就是地点名时不再写一遍地点')
})

// ---------------------------------------------------------------- ③ 自动命名

test('autoPresetName：第一个就取线路名；撞名改成「· 预设 2 / 3」；排除自己后可用原名', () => {
  const east = mk({ id: 'p1', lineId: 'L-east', lineName: '东操场', customName: '东操场' })
  assert.equal(autoPresetName([], '东操场', 'L-east'), '东操场', '库里没有同名 ⇒ 直接用线路名')
  assert.equal(autoPresetName([east], '东操场', 'L-east'), '东操场 · 预设 2')
  const two = [east, mk({ id: 'p2', lineId: 'L-east', lineName: '东操场', customName: '东操场 · 预设 2' })]
  assert.equal(autoPresetName(two, '东操场', 'L-east'), '东操场 · 预设 3')
  // 排除自己（`exceptId` = 正在保存的那条）⇒ 它占的名字不算被占 ⇒ 基名又空出来了
  assert.equal(autoPresetName(two, '东操场', 'L-east', 'p1'), '东操场')
  // 线路名与 id 都没有 ⇒ 兜底也要给个非空名字
  assert.equal(autoPresetName([], '', ''), '预设')
})

test('autoPresetName：**长线路名不会因限长而死循环**（截断后仍不重名）', () => {
  const long = '很长'.repeat(40) // 80 码点 > TRACK_NAME_MAX 上限
  const first = autoPresetName([], long, 'L-long')
  assert.ok(first.length > 0)
  const entries = [mk({ id: 'p1', lineId: 'L-long', lineName: long, customName: first })]
  const second = autoPresetName(entries, long, 'L-long')
  assert.notEqual(second, first, '第二条必须与第一条不同（截断后也要能区分）')
  assert.equal(findNameConflict(entries, second), undefined, '自动生成的名字本身不能撞名')
  assert.ok(Array.from(second).length <= TRACK_NAME_MAX, `不能超过 ${TRACK_NAME_MAX} 码点：${second}`)
})

test('TRACK_NAME_MAX=48：真实路径默认名（地点 · 真实路径 日期 · 时刻）**不再被截断**', () => {
  /** 24 码点时代，这个长度（26）会被削尾巴 ⇒ 两条不同日期的预设撞名 */
  const name = '天目湖-东操场 · 真实路径 2026-09-16 · 2122'
  assert.ok(Array.from(name).length > 24, `夹具要长于旧上限：${name}`)
  assert.equal(sanitizeLineName(name), name, '新上限下原样保留')
  const tooLong = '名'.repeat(TRACK_NAME_MAX + 10)
  assert.equal(Array.from(sanitizeLineName(tooLong)).length, TRACK_NAME_MAX, '超出上限仍按码点截断')
})

// ---------------------------------------------------------------- ④ 选哪一条

test('presetsOfLine：只取这个地点的，且保持库内顺序', () => {
  const entries = [
    mk({ id: 'p2', lineId: 'L-east' }),
    mk({ id: 'p1', lineId: 'L-east' }),
    mk({ id: 'L-west', lineId: 'L-west', lineName: '西操场' }),
  ]
  assert.deepEqual(presetsOfLine(entries, 'L-east').map((e) => e.id), ['p2', 'p1'])
  assert.deepEqual(presetsOfLine(entries, 'L-none'), [])
  assert.deepEqual(presetsOfLine(null, 'L-east'), [])
})

test('findEntryByRef：先按预设 id，再按 lineId 退回（旧引用兼容）', () => {
  const entries = [
    mk({ id: 'p2', lineId: 'L-east' }),
    mk({ id: 'p1', lineId: 'L-east' }),
    mk({ id: 'L-west', lineId: 'L-west', lineName: '西操场' }),
  ]
  assert.equal(findEntryByRef(entries, 'p1')?.id, 'p1', '精确 id 优先')
  assert.equal(findEntryByRef(entries, 'L-east')?.id, 'p2', '用 lineId 引用 ⇒ 退回该地点最新那条')
  assert.equal(findEntryByRef(entries, '不存在的'), undefined)
  assert.equal(findEntryByRef(entries, ''), undefined)
})

test('resolvePresetForLine：用户选的（可用）优先 ⇒ 否则本地点第一条可用 ⇒ 否则第一条', () => {
  const broken = mk({ id: 'p-bad', lineId: 'L-east', customName: '坏的', outer: ring(2), inner: [] })
  const good = mk({ id: 'p-good', lineId: 'L-east', customName: '好的' })
  const entries = [broken, good]

  assert.equal(resolvePresetForLine(entries, 'L-east', 'p-good').entry?.id, 'p-good')
  assert.equal(resolvePresetForLine(entries, 'L-east', 'p-good').preferredUnavailable, false)

  // 用户选的那条几何坏了 ⇒ 落回可用的那条，并**如实标记**
  const r = resolvePresetForLine(entries, 'L-east', 'p-bad')
  assert.equal(r.entry?.id, 'p-good')
  assert.equal(r.preferredUnavailable, true)

  // 没选过 ⇒ 第一条可用的（跳过几何坏的）
  assert.equal(resolvePresetForLine(entries, 'L-east').entry?.id, 'p-good')
  // 全坏 ⇒ 如实返回第一条（调用方按"没有几何"处理，这里不假装有）
  assert.equal(resolvePresetForLine([broken], 'L-east').entry?.id, 'p-bad')

  // 🔴 跨地点绝不串味：选的是别的地点/已删除的 id ⇒ 一律落回本地点
  const cross = resolvePresetForLine(entries, 'L-east', 'L-west')
  assert.equal(cross.entry?.id, 'p-good')
  assert.equal(cross.preferredUnavailable, true)

  // 这个地点一条都没有 ⇒ undefined
  assert.equal(resolvePresetForLine(entries, 'L-none').entry, undefined)
  assert.equal(resolvePresetForLine([], 'L-east').entry, undefined)
})

// ---------------------------------------------------------------- ⑤ 选择持久化契约

test('预设选择的键名与解析：与"本机路径选择"同一实现（形状都是 {键: 条目引用}）', () => {
  assert.equal(PRESET_CHOICE_KEY, 'mp_preset_choice_v1', '键名是持久化契约，改它等于让所有人的选择失效')
  assert.deepEqual(parseRefChoiceMap({ 'L-east': 'p2', '  ': 'x', 'L-none': '' }), { 'L-east': 'p2' })
  assert.deepEqual(parseRefChoiceMap(null), {})
  assert.deepEqual(withRefChoice({ 'L-east': 'p2' }, 'L-west', 'L-west'), { 'L-east': 'p2', 'L-west': 'L-west' })
  assert.deepEqual(withRefChoice({ 'L-east': 'p2' }, 'L-east', ''), {}, '空串 = 清掉该地点的选择')
})

// ---------------------------------------------------------------- ⑥ 展示与检测

test('entryDetailRows：多出「预设名称 / 预设编号」两行（一个地点多条时"哪一条"要有据可查）', () => {
  const rows = entryDetailRows(mk({ id: 'p-abc', lineId: 'L-east', customName: '内侧道' }))
  const get = (label: string) => rows.find((r) => r.label === label)?.value
  assert.equal(get('预设名称'), '内侧道')
  assert.equal(get('预设编号'), 'p-abc')
  assert.equal(get('官方线路名'), '东操场')
})

test('entrySummaryText：显示名与厂商名相同时**不再重复标注**官方名；不同时照旧标注', () => {
  const same = entrySummaryText(mk({ id: 'p1', lineId: 'L-east', lineName: '东操场', customName: '东操场' }))
  assert.ok(!same.includes('官方名'), `自动命名取的就是线路名，不该再加一句：${same}`)
  const renamed = entrySummaryText(mk({ id: 'p1', lineId: 'L-east', lineName: '东操场', customName: '内侧道' }))
  assert.ok(renamed.includes('官方名：东操场'), renamed)
  // 旧数据（没有自定义名）逐字保持老口径：本来就不带这一句
  const legacy = entrySummaryText(mk({ id: 'L-east', lineId: 'L-east', lineName: '东操场' }))
  assert.ok(!legacy.includes('官方名'), legacy)
})

test('duplicateNameGroups：只报不改 —— 旧数据可能本来就有同名（我们绝不自动改名）', () => {
  const groups = duplicateNameGroups([
    mk({ id: 'p1', lineId: 'L-east', customName: '内道' }),
    mk({ id: 'p2', lineId: 'L-west', lineName: '西操场', customName: ' 内道 ' }),
    mk({ id: 'p3', lineId: 'L-east', customName: '外道' }),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.name, '内道')
  assert.deepEqual(groups[0]!.ids, ['p1', 'p2'])
  assert.deepEqual(duplicateNameGroups([]), [])
  assert.deepEqual(duplicateNameGroups(null), [])
})
