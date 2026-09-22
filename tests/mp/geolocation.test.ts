/**
 * 「定位 = 浏览器定位（含精度与降级链）」的纯逻辑单测（2026-09-22 用户澄清版）
 *
 * 用户原话："那个非官方路径绘制指的是**定位是定位我们在的位置**"
 * ⇒ 主行为是 `navigator.geolocation.getCurrentPosition`；旧的"逐级兜底链"降级为**失败后的退路**。
 *
 * 判据（可执行）：
 *   · **每个失败情形都有话说**（拒绝授权 / 位置不可用 / 超时 / 浏览器不支持 / 非安全上下文 / 未知码），
 *     且文案里**不许出现 markdown 标记**（成对星号、反引号）—— 这些字符串会原样显示给用户；
 *   · 降级链**按顺序取第一个可用**（≥2 个有限坐标），点不够或坐标不是数就跳过；都不行 ⇒ `null`；
 *   · 降级提示必须**同时**说清"为什么"和"退到了哪一级"；没有可退的级别时也要明说并给下一步。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GEO_PERMISSION_DENIED,
  GEO_POSITION_UNAVAILABLE,
  GEO_TIMEOUT,
  geoLocatedText,
  geolocationFailure,
  locateFallbackNotice,
  pickLocateFallback,
  type LocateFallbackCandidate,
} from '../../utils/mp/geolocation.ts'

const pt = (latitude: number, longitude: number) => ({ latitude, longitude })

test('geolocationFailure：五个情形各有各的人话（且不许出现 markdown 标记）', () => {
  const cases: { name: string; failure: ReturnType<typeof geolocationFailure>; kind: string; mustSay: RegExp }[] = [
    {
      name: '用户拒绝授权（code 1）',
      failure: geolocationFailure(GEO_PERMISSION_DENIED),
      kind: 'denied',
      mustSay: /拒绝/,
    },
    {
      name: '位置不可用（code 2）',
      failure: geolocationFailure(GEO_POSITION_UNAVAILABLE),
      kind: 'unavailable',
      mustSay: /拿不到位置|定位服务/,
    },
    {
      name: '超时（code 3）',
      failure: geolocationFailure(GEO_TIMEOUT),
      kind: 'timeout',
      mustSay: /超时/,
    },
    {
      name: '浏览器不支持',
      failure: geolocationFailure(undefined, { supported: false }),
      kind: 'unsupported',
      mustSay: /navigator\.geolocation/,
    },
    {
      name: '非安全上下文（换了域名）',
      failure: geolocationFailure(GEO_PERMISSION_DENIED, { secure: false }),
      kind: 'insecure',
      mustSay: /安全上下文|localhost/,
    },
    {
      name: '不认识的错误码：如实报出码值，不猜',
      failure: geolocationFailure(42),
      kind: 'unknown',
      mustSay: /42/,
    },
  ]
  for (const c of cases) {
    assert.equal(c.failure.kind, c.kind, `${c.name} 的种类`)
    assert.ok(c.failure.reason.length >= 6, `${c.name} 的 reason 不能是空的`)
    assert.ok(c.failure.hint.length >= 6, `${c.name} 的 hint 不能是空的`)
    assert.match(c.failure.reason, c.mustSay, `${c.name} 的 reason 要说清是什么情形`)
    for (const s of [c.failure.reason, c.failure.hint]) {
      assert.equal(s.includes('**'), false, `${c.name}：用户可见文案里不许出现成对星号：${s}`)
      assert.equal(s.includes('`'), false, `${c.name}：用户可见文案里不许出现反引号：${s}`)
    }
  }
})

test('geolocationFailure：**不支持 / 非安全上下文优先于错误码**（换域名时不该报"你拒绝了授权"）', () => {
  assert.equal(geolocationFailure(GEO_PERMISSION_DENIED, { supported: false }).kind, 'unsupported')
  assert.equal(geolocationFailure(GEO_PERMISSION_DENIED, { secure: false }).kind, 'insecure')
  assert.equal(geolocationFailure(GEO_TIMEOUT, { secure: false }).kind, 'insecure')
})

test('pickLocateFallback：按顺序取第一个可用（≥2 点且坐标都是有限数）', () => {
  const draft: LocateFallbackCandidate = { level: 'draft', label: '你正在画的非官方路径', pts: [pt(31.9, 118.8), pt(31.91, 118.81)] }
  const official: LocateFallbackCandidate = { level: 'official', label: '本任务下发的官方路线', pts: [pt(31.9, 118.8), pt(31.92, 118.82)] }
  const library: LocateFallbackCandidate = { level: 'library', label: '本机路线库里已保存的几何', pts: [pt(31.9, 118.8), pt(31.93, 118.83)] }

  assert.deepEqual(pickLocateFallback([draft, official, library])?.label, draft.label, '第一级可用就用第一级')
  assert.deepEqual(pickLocateFallback([official, library])?.level, 'official', '第一级不可用 ⇒ 退到第二级')
  assert.deepEqual(pickLocateFallback([library])?.level, 'library')
  assert.equal(pickLocateFallback([]), null, '一级都没有 ⇒ null（界面据此明说"没有可降级的几何"）')
})

test('pickLocateFallback：点不够 / 坐标不是有限数的候选必须被跳过（不许"居中了却乱跳"）', () => {
  const bad: LocateFallbackCandidate[] = [
    { level: 'draft', label: '只有一个点的草稿', pts: [pt(31.9, 118.8)] },
    { level: 'draft', label: '坐标是 NaN', pts: [pt(31.9, 118.8), pt(Number.NaN, 118.8)] },
    { level: 'draft', label: '坐标是字符串垃圾', pts: [pt(31.9, 118.8), { latitude: 'a' as unknown as number, longitude: 118.8 }] },
  ]
  assert.equal(pickLocateFallback(bad), null)
  /** 字符串数字是可以的（契约层坐标本来就允许字符串） */
  const okStrings: LocateFallbackCandidate = {
    level: 'official',
    label: '字符串坐标的官方路线',
    pts: [{ latitude: '31.9' as unknown as number, longitude: '118.8' as unknown as number }, pt(31.92, 118.82)],
  }
  assert.equal(pickLocateFallback([...bad, okStrings])?.label, okStrings.label)
})

test('locateFallbackNotice：必须同时说清"为什么"与"退到了哪一级"', () => {
  const failure = geolocationFailure(GEO_PERMISSION_DENIED)
  const withChoice = locateFallbackNotice(failure, { label: '你正在画的非官方路径' })
  assert.match(withChoice, /浏览器定位不可用/)
  assert.match(withChoice, /拒绝/)
  assert.match(withChoice, /已改为定位到你正在画的非官方路径/)

  const noChoice = locateFallbackNotice(failure, null)
  assert.match(noChoice, /浏览器定位不可用/)
  assert.match(noChoice, /还没有任何可定位的几何/)
  assert.match(noChoice, /先在地图上画出这条非官方路径/)
})

test('geoLocatedText：精度如实报出（不给精度就说"没给"，绝不编一个数）', () => {
  assert.equal(geoLocatedText(15), '已定位到你当前位置（精度 ±15 m）')
  assert.equal(geoLocatedText(15.4), '已定位到你当前位置（精度 ±15 m）')
  assert.equal(geoLocatedText(0), '已定位到你当前位置（浏览器这次没有给出精度）')
  assert.equal(geoLocatedText(Number.NaN), '已定位到你当前位置（浏览器这次没有给出精度）')
  assert.equal(geoLocatedText(undefined), '已定位到你当前位置（浏览器这次没有给出精度）')
})
