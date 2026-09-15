/**
 * 学校登记表 + 开跑前三合一否决门禁测试（1.1.3 新增）
 *
 * 锁住的核心语义：
 *   - 支持范围由「已验证学校登记表」驱动，不再写死单校；
 *   - 门禁「宁可挡住，不可放行」：三个开关任一开启、或**未知**（未读取/线路切了没重查）都拒绝，
 *     且拒绝必须发生在创建场次（getRunBegin）之前。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VERIFIED_SCHOOLS,
  evaluateRunGate,
  findVerifiedSchool,
  isSchoolSupported,
  unsupportedSchoolMessage,
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

test('登记表：南航在表内且已验证', () => {
  const s = findVerifiedSchool('98765')
  assert.ok(s)
  assert.equal(s.schoolName, '南京航空航天大学')
  assert.equal(s.verified, true)
  assert.equal(s.verifiedAt, '2026-09-14')
  assert.equal(isSchoolSupported('98765'), true)
})

test('登记表：未登记学校不支持', () => {
  assert.equal(findVerifiedSchool('99999'), undefined)
  assert.equal(isSchoolSupported('99999'), false)
  assert.equal(isSchoolSupported(null), false)
  assert.equal(isSchoolSupported(''), false)
})

test('未支持学校的提示语包含支持名单（防文案漂移）', () => {
  const msg = unsupportedSchoolMessage('99999')
  assert.match(msg, /不在已验证学校名单内/)
  assert.match(msg, /南京航空航天大学/)
})

test('门禁：全关 + 已读 → 放行', () => {
  const r = evaluateRunGate(base())
  assert.equal(r.allow, true)
  assert.equal(r.reason, '')
})

test('门禁：学校未登记 → 拒绝（school_unverified）', () => {
  const r = evaluateRunGate(base({ schoolCode: '99999' }))
  assert.equal(r.allow, false)
  assert.equal(r.blockedBy, 'school_unverified')
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
