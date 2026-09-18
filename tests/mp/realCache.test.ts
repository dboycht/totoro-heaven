/**
 * 「上次读取的会话」缓存解析测试（2026-09-18）
 *
 * 缓存**只放任务 + 选线**（账号/开关不存：恢复语义是"用 token 重新读取"，存了也不会被读）。
 * 这里盯住三件事：老缓存兼容、垃圾数据安全降级、序列化只写最小集合。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCachePayload, serializeCachePayload } from '../../utils/mp/realCache.ts'
import type { MpSunrunTask } from '../../src/mp/types.ts'

const TASK: MpSunrunTask = {
  paperName: '阳光跑',
  taskId: 'task-1',
  mileage: 3.2,
  runPointList: [{ pointId: 'L1', pointName: '西操场', pointList: [] }],
}

test('realCache：正常缓存能解析出任务与选线', () => {
  const p = normalizeCachePayload({ at: 123, task: TASK, lineId: 'L1' })
  assert.ok(p)
  assert.equal(p!.at, 123)
  assert.equal(p!.lineId, 'L1')
  assert.equal(p!.task.paperName, '阳光跑')
})

test('realCache：老/未知缓存里多余字段（如曾存过的 profile/switches）被忽略、不报错', () => {
  const p = normalizeCachePayload({
    at: 1,
    task: TASK,
    lineId: 'L1',
    profile: { snCode: 'x', studentName: '旧字段' },
    switches: { sunrunStartFace: '0' },
    cameraFlag: false,
  })
  assert.ok(p, '多余字段不得导致解析失败（否则升级后用户缓存全废）')
  assert.deepEqual(Object.keys(p!).sort(), ['at', 'lineId', 'task'], '解析结果只保留最小集合')
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

test('realCache：字段类型不对时归默认值，不污染界面状态', () => {
  const p = normalizeCachePayload({ at: 'not-a-number', task: TASK, lineId: 42 })
  assert.ok(p)
  assert.equal(p!.at, 0, '非法时间戳归零')
  assert.equal(p!.lineId, '', '非字符串 lineId 归空')
})

test('realCache：序列化只写最小集合（任务/选线/时间），且往返一致', () => {
  const json = serializeCachePayload({ at: 789, task: TASK, lineId: 'L3' })
  assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ['at', 'lineId', 'task'], `实际写入：${json.slice(0, 120)}`)
  const back = normalizeCachePayload(JSON.parse(json))
  assert.equal(back!.at, 789)
  assert.equal(back!.lineId, 'L3')
  assert.equal(back!.task.taskId, 'task-1')
})
