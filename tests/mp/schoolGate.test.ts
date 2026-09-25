/**
 * 学校登记表 + 开跑前三合一否决门禁测试（1.1.3 新增 / 同日改为条件式支持）
 *
 * 锁住的核心语义：
 *   - **支持范围 = 条件式**：与南航共享同一 API 域 + 该校未开启三类风控校验 ⇒ 即可用；
 *     **不再有学校白名单**（登记表只用于"判分口径是否实测过"的软提示）；
 *   - 门禁「宁可挡住，不可放行」：三个开关任一开启、或**未知**（未读取/线路切了没重查）都拒绝，
 *     且拒绝必须发生在创建场次（getRunBegin）之前。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VERIFIED_SCHOOLS,
  SHARED_DOMAIN_HOST,
  LINE_NOT_REQUIRED_REASON,
  RELAX_GATE_FOR_CAPTURE,
  evaluateRunGate,
  findVerifiedSchool,
  isNightBlocked,
  isSchoolVerified,
  isSharedDomain,
  nonSharedDomainMessage,
  unverifiedSchoolNotice,
  type RunGateInput,
} from '../../utils/mp/schoolGate.ts'
import type { MpRunLine } from '../../src/mp/types.ts'

const line = (pointId = 'line-a'): MpRunLine => ({ pointId, pointName: '测试线路', pointList: [] })

const base = (overrides: Partial<RunGateInput> = {}): RunGateInput => ({
  schoolCode: '98765',
  switches: { sunrunStartFace: '0', sunrunPointRandom: '0' },
  line: line(),
  cameraFlag: false,
  cameraFlagLineId: 'line-a',
  // ⚠️ 必须给**白天时刻**：门禁新增了"22:30~06:00 夜间停用"，否则测试在晚上跑会因时段被拦
  now: new Date(2026, 8, 16, 15, 0, 0),
  /**
   * ⚠️ **显式跑"严格模式"**：本文件下面的既有断言全是"该拦就拦"的**严格语义** ⇒ 这里显式 `relaxGate: false`。
   *    **故意不依赖常量**（`RELAX_GATE_FOR_CAPTURE` 在 2026-09-23~24 采数据期为 `true`、**2026-09-25 起为 `false`**）：
   *    显式传值 ⇒ 以后临时再开回去采数据时，这一批断言不会假红。
   *    放宽那一边由本文件末尾的用例显式 `relaxGate: true` 覆盖（两边都测）。
   */
  relaxGate: false,
  ...overrides,
})

// ---------- 夜间停用时段（用户 2026-09-16 要求） ----------

test('夜间停用：22:30 起、次日 06:00 前一律拦住（含边界）', () => {
  const at = (h: number, m: number) => new Date(2026, 8, 16, h, m, 0)
  // 允许：06:00 ~ 22:29
  assert.equal(isNightBlocked(at(6, 0)), false, '06:00 应允许')
  assert.equal(isNightBlocked(at(15, 0)), false, '15:00 应允许')
  assert.equal(isNightBlocked(at(22, 29)), false, '22:29 应允许')
  // 停用：22:30 起
  assert.equal(isNightBlocked(at(22, 30)), true, '22:30 应停用（边界）')
  assert.equal(isNightBlocked(at(23, 59)), true, '23:59 应停用')
  assert.equal(isNightBlocked(at(0, 0)), true, '00:00 应停用（跨零点仍算夜里）')
  assert.equal(isNightBlocked(at(5, 59)), true, '05:59 应停用')
  assert.equal(isNightBlocked(at(6, 0)), false, '06:00 恢复可用')
})

test('夜间停用：门禁 blockedBy=night、放行时不受影响，且**不改变其它判定**', () => {
  const night = evaluateRunGate(base({ now: new Date(2026, 8, 16, 22, 30, 0) }))
  assert.equal(night.allow, false)
  assert.equal(night.blockedBy, 'night')
  assert.match(night.reason, /22:30~06:00/)
  assert.match(night.reason, /06:00/)

  // 白天同一组输入必须放行（说明只多了时段这一层，没动别的判定）
  const day = evaluateRunGate(base({ now: new Date(2026, 8, 16, 22, 29, 0) }))
  assert.equal(day.allow, true)

  // 夜间优先级最高：即使开关/摄像头都没读到，也报 night（先拦住再说）
  const nightUnknown = evaluateRunGate(base({ switches: null, cameraFlag: null, now: new Date(2026, 8, 16, 23, 10, 0) }))
  assert.equal(nightUnknown.blockedBy, 'night')

  // 白天时，原有否决项判定完全不变（回归）
  assert.equal(evaluateRunGate(base({ switches: null })).blockedBy, 'switches_unknown')
  assert.equal(evaluateRunGate(base({ switches: { sunrunStartFace: '1', sunrunPointRandom: '0' } })).blockedBy, 'start_face')
  assert.equal(evaluateRunGate(base({ cameraFlag: true })).blockedBy, 'camera_on')
})

test('登记表：南航在表内且已验证判分口径', () => {
  const s = findVerifiedSchool('98765')
  assert.ok(s)
  assert.equal(s.schoolName, '南京航空航天大学')
  assert.equal(s.verified, true)
  assert.equal(s.verifiedAt, '2026-09-14')
  assert.equal(isSchoolVerified('98765'), true)
})

test('登记表：未登记学校 = 未验证（但仍可用，不再被拒绝）', () => {
  assert.equal(findVerifiedSchool('99999'), undefined)
  assert.equal(isSchoolVerified('99999'), false)
  assert.equal(isSchoolVerified(null), false)
})

test('共享域判定：同域通过；独立域/非法串不通过', () => {
  assert.equal(isSharedDomain(`https://${SHARED_DOMAIN_HOST}`), true)
  assert.equal(isSharedDomain(`https://${SHARED_DOMAIN_HOST}/wxxcx`), true)
  assert.equal(isSharedDomain(`https://${SHARED_DOMAIN_HOST.toUpperCase()}`), true)
  assert.equal(isSharedDomain('https://zhygp.just.edu.cn'), false) // 江苏科技大学专属域
  assert.equal(isSharedDomain('https://app.xtotoro.com'), false) // 另一个域
  assert.equal(isSharedDomain(''), false)
  assert.equal(isSharedDomain(null), false)
})

test('非共享域提示语点明"只支持共享域"', () => {
  const msg = nonSharedDomainMessage('https://zhygp.just.edu.cn')
  assert.match(msg, /独立域/)
  assert.match(msg, new RegExp(SHARED_DOMAIN_HOST.replace(/\./g, '\\.')))
})

test('未验证学校：给软提示（含已验证名单），已验证学校不给提示', () => {
  const notice = unverifiedSchoolNotice('99999', '某某大学')
  assert.match(notice, /不在我们实测验证过的名单内/)
  assert.match(notice, /判分口径未经实测/)
  assert.match(notice, /南京航空航天大学/)
  assert.equal(unverifiedSchoolNotice('98765', '南京航空航天大学'), '')
})

test('门禁：全关 + 已读 → 放行（且不再因学校未登记而拒绝）', () => {
  const r = evaluateRunGate(base())
  assert.equal(r.allow, true)
  assert.equal(r.reason, '')
  // 关键：未登记的学校代码也能放行（支持范围改条件式）
  const other = evaluateRunGate(base({ schoolCode: '88888' }))
  assert.equal(other.allow, true)
})

test('门禁：开关未读取（未知≠关闭）→ 拒绝', () => {
  const r = evaluateRunGate(base({ switches: null }))
  assert.equal(r.allow, false)
  assert.equal(r.blockedBy, 'switches_unknown')
})

test('门禁：开场人脸开启 → 拒绝且不创建场次', () => {
  const r = evaluateRunGate(base({ switches: { sunrunStartFace: '1', sunrunPointRandom: '0' } }))
  assert.equal(r.allow, false)
  assert.equal(r.blockedBy, 'start_face')
  assert.match(r.reason, /开场人脸/)
  assert.match(r.reason, /未创建场次/)
})

test('门禁：随机抽查开启 → 拒绝', () => {
  const r = evaluateRunGate(base({ switches: { sunrunStartFace: '0', sunrunPointRandom: '1' } }))
  assert.equal(r.allow, false)
  assert.equal(r.blockedBy, 'point_random')
})

test('门禁：摄像头杆开启 → 拒绝', () => {
  const r = evaluateRunGate(base({ cameraFlag: true }))
  assert.equal(r.allow, false)
  assert.equal(r.blockedBy, 'camera_on')
})

test('门禁：摄像头 flag 未读取 → 拒绝（未知≠关闭）', () => {
  const r = evaluateRunGate(base({ cameraFlag: null }))
  assert.equal(r.allow, false)
  assert.equal(r.blockedBy, 'camera_unknown')
})

test('门禁：切了线路但 flag 还是旧线路的 → 拒绝（防误用旧值）', () => {
  const r = evaluateRunGate(base({ line: line('line-b'), cameraFlagLineId: 'line-a', cameraFlag: false }))
  assert.equal(r.allow, false)
  assert.equal(r.blockedBy, 'camera_unknown')
  assert.match(r.reason, /切换线路后需重新读取/)
})

test('门禁：未选线路 → 拒绝', () => {
  const r = evaluateRunGate(base({ line: null, cameraFlagLineId: '' }))
  assert.equal(r.allow, false)
  assert.equal(r.blockedBy, 'camera_unknown')
})

// ---------- 🆕 2026-09-22（issue #12）：任务未下发线路（lineRequired=false）----------
/**
 * 背景：有的任务**服务端未下发线路**（`runPointList` 缺失/为空，实测"研途健行"/研究生院）。
 * 那种情况下 `line` 必然是空的 —— 这是任务的属性，不是用户的疏忽。原先门禁会判 `camera_unknown`
 * （"尚未选择跑步线路。"）把开跑永远挡住，等于**自己造出一个服务端没提的要求**。
 *
 * 判据：调用方传 `lineRequired: false`（`routeRequirementOf(task).kind === 'line'` 取反）时，
 * **④「未选线路」那一条不拦**，其余四层（夜间/开关/人脸/抽查）一律照旧。
 */
test('门禁：任务未下发线路（lineRequired=false）⇒ 未选线路**不再**拒绝（并给出依据）', () => {
  const r = evaluateRunGate(base({ line: null, cameraFlag: null, cameraFlagLineId: '', lineRequired: false }))
  assert.equal(r.allow, true, '任务未下发线路时不得因"未选线路"拦住')
  assert.equal(r.blockedBy, undefined)
  assert.equal(r.reason, LINE_NOT_REQUIRED_REASON)
  assert.match(r.reason, /本任务未下发线路/)
  // ⚠️ 措辞纪律：只说"未下发"这个客观事实，不许写成"服务端不判路线"（我们证明不了）
  assert.doesNotMatch(r.reason, /不判路线/)
})

test('门禁：lineRequired=false **只**放宽"线路"这一条 —— 夜间/开关/人脸/抽查照旧拦', () => {
  const noLine = { line: null, cameraFlag: null, cameraFlagLineId: '', lineRequired: false } as const
  assert.equal(evaluateRunGate(base({ ...noLine, switches: null })).blockedBy, 'switches_unknown', '开关未读照旧拦')
  assert.equal(
    evaluateRunGate(base({ ...noLine, switches: { sunrunStartFace: '1', sunrunPointRandom: '0' } })).blockedBy,
    'start_face',
  )
  assert.equal(
    evaluateRunGate(base({ ...noLine, switches: { sunrunStartFace: '0', sunrunPointRandom: '1' } })).blockedBy,
    'point_random',
  )
  assert.equal(
    evaluateRunGate(base({ ...noLine, now: new Date(2026, 8, 16, 22, 30, 0) })).blockedBy,
    'night',
    '夜间停用优先级最高',
  )
  // 反过来：默认（不传 lineRequired）**必须逐字保持老行为**
  assert.equal(evaluateRunGate(base({ line: null, cameraFlagLineId: '' })).blockedBy, 'camera_unknown')
  assert.equal(evaluateRunGate(base({ line: null, cameraFlagLineId: '', lineRequired: true })).blockedBy, 'camera_unknown')
})

// ---------- 🔴 「放宽」开关（2026-09-23 采数据期开、**2026-09-25 已关闸**） ----------
/**
 * 用户原话（开闸那次）：「用户相关提交的判定松一点，之前那种都是**你自己终止了**导致用户提交不了，
 * 导致我们根本无法采集数据！这个 pre3 相当于就是专门来收集数据的」。
 *
 * 判据（两个方向都钉住，防"开/关闸"时坏掉）：
 *   · 开关 `true` ⇒ **命中项只警告不拦**：`allow:true` + `warnings` 完整 + `relaxed:true`；
 *   · 开关 `false`（**= 2026-09-25 起的当前值**）⇒ 逐字恢复"第一条命中就拦"：`allow:false` + `reason = warnings[0]`。
 * 关闸依据（可复算）：诊断包里 **0 条 `warn-relaxed`** ⇒ 提交那一刻命中项 = 0 ⇒ 见 `DEVELOPMENT.md` §39.5。
 */
test('🔴 放宽开关：默认（不传 relaxGate）跟随开关常量 —— 开=true 只警告不拦 / 关=false 第一条命中就拦', () => {
  // 最坏输入：夜间 + 开关没读 + 没选线路 + 摄像头杆没读 ⇒ 严格模式会拦三条
  const worst = evaluateRunGate({
    schoolCode: '98765',
    switches: null,
    line: null,
    cameraFlag: null,
    cameraFlagLineId: '',
    now: new Date(2026, 8, 16, 23, 10, 0),
  })
  /**
   * ⚠️ 这里**按常量分叉**（而不是写死"必须 allow=true"）：这样把 `RELAX_GATE_FOR_CAPTURE` 临时改值
   * 跑一遍单测时**整个文件仍然全绿** —— 那就是"临时改值"的验收方式（见 DEVELOPMENT.md §37 续5）。
   */
  assert.equal(worst.allow, RELAX_GATE_FOR_CAPTURE ? true : false, 'allow 必须跟随开关（当前 = false ⇒ 拦）')
  assert.equal(worst.relaxed, RELAX_GATE_FOR_CAPTURE, 'relaxed 标记必须与开关一致（提交时据此上报诊断）')
  assert.equal(worst.blockedBy, 'night', 'blockedBy 仍给"第一条命中项"（界面夜间提示等要用）')
  assert.equal(worst.reason, worst.warnings[0], 'reason = 第一条命中项的文案')
  assert.deepEqual(worst.warningCodes, ['night', 'switches_unknown', 'camera_unknown'], '命中项代号按判定顺序列全')
  assert.equal(worst.warnings.length, 3, '每条"本该拦住的理由"都要在 warnings 里如实给出（与是否放宽无关）')
  for (const w of worst.warnings) assert.ok(w.length > 8, `warning 要是完整人话：${w}`)
})

test('🔴 pre3 放宽：同一条输入在严格模式下 allow=false、放宽模式下 allow=true（两边一起钉）', () => {
  const cases: { name: string; input: Partial<RunGateInput>; code: string }[] = [
    { name: '夜间停用', input: { now: new Date(2026, 8, 16, 23, 0, 0) }, code: 'night' },
    { name: '开关未读', input: { switches: null }, code: 'switches_unknown' },
    { name: '开场人脸', input: { switches: { sunrunStartFace: '1', sunrunPointRandom: '0' } }, code: 'start_face' },
    { name: '随机抽查', input: { switches: { sunrunStartFace: '0', sunrunPointRandom: '1' } }, code: 'point_random' },
    { name: '未选线路', input: { line: null, cameraFlagLineId: '' }, code: 'camera_unknown' },
    { name: '摄像头杆未读', input: { cameraFlag: null }, code: 'camera_unknown' },
    { name: '摄像头杆已开', input: { cameraFlag: true }, code: 'camera_on' },
    {
      name: '未选本机路径（服务端未下发线路 + 本机没有可用几何）',
      input: { line: null, cameraFlagLineId: '', lineRequired: false, localGeometryReady: false },
      code: 'no_local_geometry',
    },
  ]
  for (const c of cases) {
    const strict = evaluateRunGate(base({ ...c.input, relaxGate: false }))
    const relaxed = evaluateRunGate(base({ ...c.input, relaxGate: true }))
    assert.equal(strict.allow, false, `严格模式：${c.name} 必须拦住`)
    assert.equal(strict.blockedBy, c.code, `严格模式：${c.name} 的 blockedBy`)
    assert.ok(strict.warnings.length >= 1, `严格模式也要带上 warnings（界面统一展示）`)
    assert.equal(relaxed.allow, true, `pre3 放宽：${c.name} 仍要能提交`)
    assert.equal(relaxed.relaxed, true, `pre3 放宽：${c.name} 要标 relaxed`)
    assert.ok(
      relaxed.warningCodes.includes(c.code as never),
      `pre3 放宽：${c.name} 的理由必须在 warnings 里（实际 ${relaxed.warningCodes.join(',')}）`,
    )
  }
})

test('pre3 放宽：本地几何齐备/自由跑/一切正常时**不该**多出 warning', () => {
  // 正常阳光跑任务
  const ok = evaluateRunGate(base())
  assert.deepEqual(ok.warnings, [])
  assert.equal(ok.relaxed, false)
  // 自由路线任务 + 本机有可用几何 ⇒ 只有"无需选择线路"的说明，不是 warning
  const free = evaluateRunGate(base({ line: null, cameraFlagLineId: '', lineRequired: false, localGeometryReady: true }))
  assert.deepEqual(free.warnings, [], '有可用几何 ⇒ 不该报 no_local_geometry')
  assert.equal(free.reason, LINE_NOT_REQUIRED_REASON)
  assert.equal(free.allow, true)
  // 自由跑（runType=1）：厂商不打卡不取线路 ⇒ 开关未读也不算问题（与放宽与否无关）
  const freeRun = evaluateRunGate(base({ runType: 1, switches: null, line: null, cameraFlagLineId: '' }))
  assert.deepEqual(freeRun.warnings, [])
  assert.equal(freeRun.allow, true)
})

/**
 * 🔴🔴 2026-09-25 修复（诊断包实测事故）：**"本机库还没装载" ≠ "本机没有几何"**。
 *
 * 现场：他库里明明有 1 条 `local:free`，但工作台"读真实数据"那一刻 `useTrackLibrary().load()` **还没被调用**
 * （只有跑步页 / 跑道编辑页 / 非官方路径页会调）⇒ `entries` 还是初值 `[]` ⇒ 老写法 `Boolean(...)` 得出 `false`
 * ⇒ 记一条 `no_local_geometry`（`RELAX_GATE_FOR_CAPTURE=true` 时只是误提示，**关闸后就是误拦**）。
 * 修法：**三态** —— 调用方在"还没装载"时传 `undefined`（未知 ⇒ 不记也不拦），只有**确认没有**才传 `false`。
 * 判据来源 = `useTrackLibrary()` 新暴露的 `loaded`；证据链见 `DEVELOPMENT.md` §39.3 第 2 条。
 */
test('🔴 未装载 ≠ 没有：localGeometryReady 省略/undefined ⇒ 不记 no_local_geometry（严格模式也放行）', () => {
  const unknown = evaluateRunGate(
    base({ line: null, cameraFlagLineId: '', lineRequired: false, localGeometryReady: undefined, relaxGate: false }),
  )
  assert.deepEqual(unknown.warningCodes, [], '未知 ⇒ 一条也不许记（老写法会记 no_local_geometry）')
  assert.equal(unknown.allow, true, '未知 ⇒ 严格模式下也必须放行（否则就是拿"没装载"当"没有"误拦）')
  assert.equal(unknown.blockedBy, undefined, '没有命中项 ⇒ blockedBy 不填')
  assert.equal(unknown.reason, LINE_NOT_REQUIRED_REASON, '仍要说明"本任务未下发线路、无需选择线路"')

  // 对照：**确认没有**（已装载且为空）⇒ 严格模式下照旧拦（这条判据不能因为修 bug 而被削弱）
  const empty = evaluateRunGate(
    base({ line: null, cameraFlagLineId: '', lineRequired: false, localGeometryReady: false, relaxGate: false }),
  )
  assert.equal(empty.allow, false, '确认没有几何 ⇒ 严格模式必须拦')
  assert.equal(empty.blockedBy, 'no_local_geometry')
  assert.ok(empty.warnings[0]?.includes('非官方路径'), '提示要指路（去哪儿画一条）')
})
