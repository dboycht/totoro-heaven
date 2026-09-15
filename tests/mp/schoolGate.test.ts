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
  evaluateRunGate,
  findVerifiedSchool,
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
  ...overrides,
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
