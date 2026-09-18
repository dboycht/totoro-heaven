/**
 * 「上次读取的会话」缓存解析测试（2026-09-18）
 *
 * 背景：用户实测反馈"点恢复上次任务后，账号面板与一票否决项仍是未读取" ——
 * 因为缓存里**只存了任务**（老格式 `{at, task, lineId}`），`profile` / `switches` 从来没被恢复过。
 * 现在缓存补存账号与开关，且**必须向后兼容**：老缓存 / 缺字段 / 类型不对都要安全降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCachePayload, serializeCachePayload } from '../../utils/mp/realCache.ts'
import type { MpRealProfile, MpSunrunTask } from '../../src/mp/types.ts'

const TASK: MpSunrunTask = {
  paperName: '阳光跑',
  taskId: 'task-1',
  mileage: 3.2,
  runPointList: [{ pointId: 'L1', pointName: '西操场', pointList: [] }],
}
const PROFILE: MpRealProfile = {
  snCode: '98765',
  studentName: '某某',
  schoolCode: '98765',
  schoolName: '南京航空航天大学',
  campusId: '天目湖',
  campusName: '天目湖',
  className: '某班',
}

test('realCache：老格式（只有 at/task/lineId）能解析，账号与开关留空', () => {
  const p = normalizeCachePayload({ at: 123, task: TASK, lineId: 'L1' })
  assert.ok(p, '老缓存必须仍可解析（否则升级后用户的任务缓存全废）')
  assert.equal(p!.at, 123)
  assert.equal(p!.lineId, 'L1')
  assert.equal(p!.task.paperName, '阳光跑')
  assert.equal(p!.profile, undefined)
  assert.equal(p!.switches, undefined)
  assert.equal(p!.cameraFlag, undefined)
})

test('realCache：新格式能取到账号 / 开关 / 摄像头杆', () => {
  const p = normalizeCachePayload({
    at: 456,
    task: TASK,
    lineId: 'L2',
    profile: PROFILE,
    switches: { sunrunStartFace: '0', sunrunPointRandom: '1' },
    cameraFlag: false,
  })
  assert.equal(p!.profile?.campusName, '天目湖')
  assert.equal(p!.switches?.sunrunPointRandom, '1')
  assert.equal(p!.cameraFlag, false)
})

test('realCache：垃圾数据安全降级（没有 task / 不是对象 → null）', () => {
  assert.equal(normalizeCachePayload(null), null)
  assert.equal(normalizeCachePayload(undefined), null)
  assert.equal(normalizeCachePayload('nonsense'), null)
  assert.equal(normalizeCachePayload([]), null)
  assert.equal(normalizeCachePayload({}), null)
  assert.equal(normalizeCachePayload({ at: 1, lineId: 'L1' }), null, '没有 task 就不算可用缓存')
  assert.equal(normalizeCachePayload({ task: 'not-an-object' }), null)
})

test('realCache：字段类型不对时**逐项丢掉**，不污染界面状态', () => {
  const p = normalizeCachePayload({
    at: 'not-a-number',
    task: TASK,
    lineId: 42,
    profile: { snCode: '' }, // 空 snCode ⇒ 不算有效档案
    switches: { ok: '1', bad: { nested: true }, num: 0 },
    cameraFlag: 'false', // 字符串不算布尔
  })
  assert.ok(p)
  assert.equal(p!.at, 0, '非法时间戳归零')
  assert.equal(p!.lineId, '', '非字符串 lineId 归空')
  assert.equal(p!.profile, undefined, '空 snCode 的档案要丢掉')
  assert.deepEqual(p!.switches, { ok: '1', num: '0' }, '只收字符串/数字值，嵌套对象丢掉、数字转字符串')
  assert.equal(p!.cameraFlag, undefined, '字符串 "false" 不能当成布尔')
})

test('realCache：序列化只写需要的字段，且能被自己解析回来（往返一致）', () => {
  const json = serializeCachePayload({ at: 789, task: TASK, lineId: 'L3', profile: PROFILE, switches: { a: '1' }, cameraFlag: true })
  const back = normalizeCachePayload(JSON.parse(json))
  assert.equal(back!.at, 789)
  assert.equal(back!.lineId, 'L3')
  assert.equal(back!.profile?.snCode, '98765')
  assert.deepEqual(back!.switches, { a: '1' })
  assert.equal(back!.cameraFlag, true)
  // 空值不写入 JSON（避免存一堆 null）
  const sparse = JSON.parse(serializeCachePayload({ at: 1, task: TASK, lineId: '', profile: null, switches: null, cameraFlag: null }))
  assert.ok(!('profile' in sparse) && !('switches' in sparse) && !('cameraFlag' in sparse), JSON.stringify(sparse))
})
