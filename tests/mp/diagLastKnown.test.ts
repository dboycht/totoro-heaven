/**
 * `utils/mp/diagLastKnown.ts`（「最近一次成功读取时的状态」）的单测 —— 2026-09-22 新增
 *
 * 用户原话："你刚刚说刷新后就丢了，我们直接丢之前记录下来不行吗"。
 *
 * 这里盯住三件事（缺一不可）：
 *  ① 写入/读取正确，且**只写掩码后的身份 + 布尔/指纹**（绝不含 token 明文与学号姓名原文）；
 *  ② 🔴 **它不影响门禁**：构造"lastKnown 说开关全关、但实时未知" ⇒ `evaluateRunGate()` **仍然**
 *     以 `switches_unknown` 拦下（这条最容易被后人改坏，所以用断言钉死）；
 *  ③ 快照/manifest 里能带上它（字段形状 + 读取时刻）。
 *
 * ⚠️ 时间一律用**本地时间构造**（`new Date(2026, 8, 22, 17, 10, 56)`）：门禁里有"夜间停用 22:30~06:00"，
 * 用 UTC 字面量会在不同时区/时刻跑出不同结论（第一版就被这条咬到——UTC 17:10 在本机是凌晨 01:10 ⇒ 判 `night`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LAST_KNOWN_KEY,
  buildLastKnown,
  clearLastKnown,
  lastKnownSummary,
  readLastKnown,
  saveLastKnown,
} from '../../utils/mp/diagLastKnown.ts'
import { assertNoCredentials } from '../../utils/mp/diagnostics.ts'
import { evaluateRunGate, RELAX_GATE_FOR_CAPTURE } from '../../utils/mp/schoolGate.ts'

/** 一个内存版 localStorage（不依赖浏览器） */
function memoryStorage(seed?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _dump: () => Object.fromEntries(map),
  }
}

/** 用户现场的那个时刻：**本地时间** 2026-09-22 17:10:56（白天，门禁不会因夜间停用而拦） */
const AT_1710 = new Date(2026, 8, 22, 17, 10, 56)
/** 导出时刻：本地 18:40（也是白天） */
const AT_1840 = new Date(2026, 8, 22, 18, 40, 0)

const TASK = { paperName: '研途健行', taskId: 't-1', runPointList: [{ pointId: 'L1' }] }

test('buildLastKnown：任务 + 开关 + 摄像头杆 ⇒ 形状完整、含当时的门禁终值', () => {
  const s = buildLastKnown({
    task: TASK,
    schoolCode: '1001',
    schoolName: '某大学',
    campusId: 'c-1',
    campusName: '东校区',
    snCode: '2021101234',
    studentName: '张小明',
    phone: '13812345678',
    hasToken: true,
    switches: { sunrunStartFace: '0', sunrunPointRandom: '0' },
    cameraFlag: false,
    cameraFlagLineId: 'L1',
    lineId: 'L1',
    now: AT_1710,
  })
  assert.ok(s, '有任务/开关时必须能造出记录')
  assert.equal(s!.at, AT_1710.toISOString())
  assert.equal(s!.atMs, AT_1710.getTime())
  assert.equal(s!.status, 'ready')
  assert.equal(s!.switches?.sunrunStartFace, '0', '开关**原值**要照记（判定依据就是"是不是 1"）')
  assert.equal(s!.cameraFlag, false)
  assert.equal(s!.task.runPointListCount, 1)
  assert.equal(s!.task.shapeLine, 'route=line(1) fit=none')
  assert.equal(s!.gateAllow, true, '当时的门禁终值由同一个 evaluateRunGate 算出')
  assert.equal(s!.gateBlockedBy, '')
  // 身份：只掩码
  assert.equal(s!.student.snCode, '20******34')
  assert.equal(s!.student.studentName, '张**', 'maskName 口径：只留姓，其余每位一个星号')
  assert.equal(s!.student.phone, '138****5678')
})

test('🔴 绝不落 token 明文 / 学号姓名原文：写盘文本里只有布尔、指纹与掩码', () => {
  const TOKEN = `WXXCX${'Ab3kZ9_x-y.'.repeat(6)}`
  const s = buildLastKnown({
    task: TASK,
    snCode: '2021101234',
    studentName: '张小明',
    phone: '13812345678',
    hasToken: true,
    // 指纹是"长度 + 哈希"，不含本体
    tokenFingerprint: '101:abcdef123456',
    switches: { sunrunStartFace: '1', sunrunPointRandom: '0' },
    cameraFlag: true,
    cameraFlagLineId: 'L1',
    lineId: 'L1',
    now: AT_1710,
  })
  const text = JSON.stringify(s)
  assert.ok(!text.includes(TOKEN), 'token 本体绝不许出现（连指纹都只有长度+哈希）')
  assert.ok(!text.includes('2021101234'), '学号原文不得出现')
  assert.ok(!text.includes('张小明'), '姓名原文不得出现')
  assert.ok(!text.includes('13812345678'), '手机号原文不得出现')
  assert.equal(s!.auth.hasToken, true)
  assert.equal(s!.auth.tokenFingerprint, '101:abcdef123456')
  assert.deepEqual(assertNoCredentials([text]).hits, [], '这份文本不该命中诊断红线')
  // 开关是 1 ⇒ 当时的门禁终值应当是"被人脸拦住"（历史事实，与实时无关）
  /**
   * ⚠️ **跟着开关常量断言**（而不是写死一个值 —— 写死就会在"开/关闸"时假红）：
   * · 2026-09-23~24 采数据期 `RELAX_GATE_FOR_CAPTURE = true` ⇒ 门禁终值 `allow:true`（有命中项也只警告）；
   * · **2026-09-25 起已关闸（`false`）** ⇒ 命中「开场人脸」就是 `allow:false`（严格语义）。
   * 两种情形下 `blockedBy` 都如实记录**本该拦住的那一条**（`start_face`）。
   * 严格/放宽两条路径本身由 `schoolGate.test.ts` 显式传 `relaxGate` 各跑一遍钉住。
   */
  assert.equal(s!.gateAllow, RELAX_GATE_FOR_CAPTURE, '门禁终值跟随开关常量：严格=false（命中即拦）/ 放宽=true')
  assert.equal(s!.gateBlockedBy, 'start_face', 'blockedBy 仍记录"本该拦住的那条"（历史事实）')
})

test('buildLastKnown：什么都没有 ⇒ 返回 null（宁可不写，也不留一份"全空"的假证据）', () => {
  assert.equal(buildLastKnown({ task: null, hasToken: false, switches: null, cameraFlag: null, cameraFlagLineId: '' }), null)
  // 只读到开关（没任务）也算证据 ⇒ 要写（status=partial）
  const partial = buildLastKnown({ task: null, hasToken: false, switches: { sunrunStartFace: '0' }, cameraFlag: null, cameraFlagLineId: '', now: AT_1710 })
  assert.ok(partial)
  assert.equal(partial!.status, 'partial')
  // 演示模式：标记出来（演示态不该被当成本机真实读取的证据）
  const demo = buildLastKnown({ task: TASK, hasToken: false, switches: null, cameraFlag: null, cameraFlagLineId: '', demoMode: true, now: AT_1710 })
  assert.equal(demo!.status, 'demo')
})

test('save/read/clear：往返一致；坏数据与缺失 ⇒ null（绝不抛错）', () => {
  const st = memoryStorage()
  const s = buildLastKnown({ task: TASK, hasToken: false, switches: null, cameraFlag: null, cameraFlagLineId: '', now: AT_1710 })!
  assert.equal(saveLastKnown(s, st), true)
  assert.deepEqual(readLastKnown(st), s, '读回来必须逐字段一致')
  assert.equal(Object.keys(st._dump())[0], LAST_KNOWN_KEY, '键名是单一来源（别处不要再写字面量）')
  // 坏 JSON / 形状不对 ⇒ null
  const bad = memoryStorage({ [LAST_KNOWN_KEY]: '{不是 JSON' })
  assert.equal(readLastKnown(bad), null)
  const wrongShape = memoryStorage({ [LAST_KNOWN_KEY]: JSON.stringify({ at: 'x' }) })
  assert.equal(readLastKnown(wrongShape), null, '缺 atMs 的形状不认（宁可当没有）')
  // 清掉
  clearLastKnown(st)
  assert.equal(readLastKnown(st), null)
  // 没有任何 storage（SSR / 隐私模式）⇒ 安全降级
  assert.equal(saveLastKnown(s, undefined as unknown as Storage), false)
  assert.equal(readLastKnown(undefined as unknown as Storage), null)
})

/**
 * 🔴🔴 这一条是本模块存在的**边界**：`lastKnown` **绝不能**影响门禁。
 * 构造"记录里说开关全关、摄像头杆未启用"（看起来一切正常），但**实时状态是空的**（刷新后的现场）
 * ⇒ `evaluateRunGate()` 必须仍然以 `switches_unknown` 拦下。
 */
test('🔴 门禁只认实时状态：lastKnown 说开关全关，但实时未知 ⇒ 仍然 switches_unknown 拦下', () => {
  const saved = buildLastKnown({
    task: TASK,
    hasToken: true,
    switches: { sunrunStartFace: '0', sunrunPointRandom: '0' },
    cameraFlag: false,
    cameraFlagLineId: 'L1',
    lineId: 'L1',
    now: AT_1710,
  })
  assert.equal(saved!.gateAllow, true, '那时确实是"可提交"（历史事实）')
  // 刷新之后：实时态全丢（这正是用户的现场）
  const live = { switches: null as Record<string, string> | null, cameraFlag: null as boolean | null, cameraFlagLineId: '' }
  const LINE = { pointId: 'L1', pointName: '西操场', pointList: [] }
  const verdict = evaluateRunGate({
    schoolCode: '1001',
    switches: live.switches,
    cameraFlag: live.cameraFlag,
    cameraFlagLineId: live.cameraFlagLineId,
    line: LINE,
    runType: 0,
    now: AT_1840, // 白天，排除"夜间停用"这条干扰
    /**
     * ⚠️ 显式跑**严格模式**：pre3 期门禁默认放宽（只警告不拦），而本条要验的是
     * "**陈旧数据不得诱使门禁放行**"这个安全属性 —— 它只对严格语义成立。
     */
    relaxGate: false,
  })
  assert.equal(verdict.allow, false, '实时未知 ⇒ 绝不许因为有一份"全关"的历史记录就放行')
  assert.equal(verdict.blockedBy, 'switches_unknown')

  // 即便把 lastKnown 硬塞进门禁入参（结构上不该发生），门禁也只读 switches/cameraFlag ⇒ 仍然拦
  const withExtra = evaluateRunGate({
    schoolCode: '1001',
    switches: null,
    cameraFlag: live.cameraFlag,
    cameraFlagLineId: live.cameraFlagLineId,
    line: null,
    runType: 0,
    lastKnown: saved,
    now: AT_1840,
    relaxGate: false,
  } as unknown as Parameters<typeof evaluateRunGate>[0])
  assert.equal(withExtra.allow, false, '门禁的判据只有实时状态；多传的字段不参与判定')
})

test('lastKnownSummary：人话摘要必须写明"那是历史值、不用于放行"', () => {
  const s = buildLastKnown({
    task: TASK,
    hasToken: true,
    switches: { sunrunStartFace: '0', sunrunPointRandom: '0' },
    cameraFlag: false,
    cameraFlagLineId: 'L1',
    lineId: 'L1',
    now: AT_1710,
  })
  const text = lastKnownSummary(s)
  assert.match(text, /最近一次读到开关是/)
  assert.match(text, /2026-09-22 17:10:56/, `摘要里要有本地时刻（实际：${text}）`)
  assert.match(text, /开场人脸=0/)
  assert.match(text, /摄像头杆=未启用/)
  assert.match(text, /不用于放行/, '必须写出边界，否则会被误当成"当前能不能提交"的依据')
  assert.equal(lastKnownSummary(null), '')
  assert.equal(lastKnownSummary(undefined), '')
})

test('快照形状：任务摘要三件套与 lastKnown 一起进快照（形状断言，防止字段漏接）', () => {
  const s = buildLastKnown({
    task: TASK,
    hasToken: false,
    switches: { sunrunStartFace: '0', sunrunPointRandom: '0' },
    cameraFlag: false,
    cameraFlagLineId: 'L1',
    lineId: 'L1',
    now: AT_1710,
  })!
  // 模拟客户端快照里那两个字段（形状与 `DiagSnapshot` 对齐）
  const snap = {
    collectedAt: AT_1840.toISOString(),
    timelineStats: { input: 1, inWindow: 1, outOfWindow: 0, unparsable: 0, droppedToCap: 0 },
    lastKnown: s,
  }
  assert.equal(snap.lastKnown.atMs, AT_1710.getTime(), '读取时刻必须在快照里（manifest 要写明它）')
  assert.equal(snap.lastKnown.task.shapeLine, 'route=line(1) fit=none', '任务摘要三件套要一起带上')
  assert.equal(snap.lastKnown.task.runPointListCount, 1)
  assert.match(lastKnownSummary(snap.lastKnown), /均无阻碍|不用于放行/)
})

/**
 * 🔴 2026-09-22 审计 B8：**换账号/清空本机数据时必须清掉「最近已知状态」**。
 *
 * 为什么用"源码级断言"而不是行为测试：真正的调用点在 `composables/real/data.ts`
 * （`logoutAndClearSession()` / `clearAllLocalData()`），而 composable 需要 Nuxt 上下文才能跑
 * （`test:mp` 是纯离线环境，没有 `#app`）。所以按本仓既有先例（`check-wiring.mjs` / `uiText.test.ts`
 * 都是源码级守卫）把**调用点**钉住：这两个函数体里必须各出现一次 `clearLastKnown()`。
 * 不清的后果：换账号后上一个账号的掩码身份/开关/任务名仍留在 localStorage，
 * 新账号读取失败时会被当"最近已知状态"打进诊断包 ⇒ **跨账号证据污染**。
 */
test('🔴 审计 B8：「最近已知状态」在退出登录与清空本机数据时都被清掉（源码级守卫）', async (t) => {
  const { readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  /**
   * 测试可能跑在 `.mp-test-build/tests/mp/`，要向上找到真正的项目根。
   * 🔴 判据**只能用"仓库内一定有的文件"**：`package.json`（仓库根必有）+ 本次要读的目标文件。
   * **不许**用 `DEVELOPMENT.md` / `HANDOVER.md` / `ERROR.md` —— 它们按纪律只留开发副本、**不上 GitHub**，
   * 在 CI 里不存在（2026-09-23 就是这么把 CI 弄红的）。找不到时**明确 skip 并打印原因**，不在 CI 里失败。
   */
  let dir = join(fileURLToPath(import.meta.url), '..')
  let root = ''
  for (let i = 0; i < 6; i++) {
    const parent = join(dir, '..')
    if (existsSync(join(parent, 'package.json')) && existsSync(join(parent, 'composables', 'real', 'data.ts'))) {
      root = parent
      break
    }
    dir = parent
  }
  if (!root) {
    t.skip('找不到项目根（package.json + composables/real/data.ts）—— 可能不在仓库内运行；本守卫跳过')
    return
  }
  const src = readFileSync(join(root, 'composables', 'real', 'data.ts'), 'utf8')

  /** 取某个函数体（从 `function xxx(` 到下一个顶层 `function` / 注释块） */
  const bodyOf = (marker: string): string => {
    const at = src.indexOf(marker)
    assert.ok(at >= 0, `data.ts 里找不到 ${marker}（守卫需同步更新）`)
    const rest = src.slice(at + marker.length)
    const next = rest.search(/\n {2}(?:async )?function |\n {2}\/\*\* /)
    return next < 0 ? rest : rest.slice(0, next)
  }
  for (const fn of ['function logoutAndClearSession(', 'function clearAllLocalData(']) {
    const body = bodyOf(fn)
    assert.match(body, /clearLastKnown\(\)/, `${fn} 里没有清「最近已知状态」—— 换账号/清空后会留下上一份证据（审计 B8）`)
  }
  // 反向：不能只 import 不用（"看起来接好了其实没调"最容易漏）
  assert.match(src, /import \{[^}]*clearLastKnown[^}]*\} from '~\/utils\/mp\/diagLastKnown'/, 'data.ts 要从 diagLastKnown 引入 clearLastKnown')
})
