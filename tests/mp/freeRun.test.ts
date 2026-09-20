/**
 * 自由跑「自设距离」纯逻辑测试（2026-09-20，1.1.12 需求①）
 *
 * 为什么这些判据值得钉住：距离是**跨三个地方**使用的同一个数
 * （界面输入框 / 跑步引擎的 targetKm / 落盘记忆值），
 * 一旦"哪一处自己夹紧/自己兜底"，就会出现"框里 7.5、实际跑 5"这类对不上的 bug。
 * 所以这里把**唯一的归一化出口** `clampFreeRunKm` 的边界逐条钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FREE_RUN_KM_DEFAULT,
  FREE_RUN_KM_MAX,
  FREE_RUN_KM_MIN,
  FREE_RUN_KM_PRESETS,
  clampFreeRunKm,
  estimateFreeRunSeconds,
  estimateLaps,
  formatFreeRunKm,
  parseStoredFreeRunKm,
} from '../../utils/mp/freeRun.ts'

test('clampFreeRunKm：空/坏输入回落**默认值**（不是 0、也不是下限）', () => {
  for (const bad of [null, undefined, '', '   ', 'abc', NaN, Infinity, -Infinity, {}, []]) {
    assert.equal(clampFreeRunKm(bad), FREE_RUN_KM_DEFAULT, `输入 ${JSON.stringify(bad)} 应回落默认值`)
  }
})

test('clampFreeRunKm：数值夹紧到 [0.5, 42.2] 并保留一位小数', () => {
  assert.equal(clampFreeRunKm(0), FREE_RUN_KM_MIN)
  assert.equal(clampFreeRunKm(-3), FREE_RUN_KM_MIN)
  assert.equal(clampFreeRunKm(0.4), FREE_RUN_KM_MIN)
  assert.equal(clampFreeRunKm(999), FREE_RUN_KM_MAX)
  assert.equal(clampFreeRunKm(42.2), FREE_RUN_KM_MAX)
  // 一位小数（四舍五入）
  assert.equal(clampFreeRunKm(5.04), 5)
  assert.equal(clampFreeRunKm(21.19), 21.2)
  assert.equal(clampFreeRunKm(7.35), 7.4)
  // 字符串输入（输入框给的就是字符串）
  assert.equal(clampFreeRunKm('7.3'), 7.3)
  assert.equal(clampFreeRunKm(' 12.5 '), 12.5)
})

test('parseStoredFreeRunKm：localStorage 原始值 → 合法距离，坏数据不抛', () => {
  assert.equal(parseStoredFreeRunKm('7.5'), 7.5)
  assert.equal(parseStoredFreeRunKm('100'), FREE_RUN_KM_MAX)
  assert.equal(parseStoredFreeRunKm('0'), FREE_RUN_KM_MIN)
  assert.equal(parseStoredFreeRunKm(''), FREE_RUN_KM_DEFAULT)
  assert.equal(parseStoredFreeRunKm('   '), FREE_RUN_KM_DEFAULT)
  assert.equal(parseStoredFreeRunKm(null), FREE_RUN_KM_DEFAULT)
  assert.equal(parseStoredFreeRunKm(undefined), FREE_RUN_KM_DEFAULT)
  assert.equal(parseStoredFreeRunKm('junk'), FREE_RUN_KM_DEFAULT)
})

test('formatFreeRunKm：统一一位小数（5 → "5.0"）', () => {
  assert.equal(formatFreeRunKm(5), '5.0')
  assert.equal(formatFreeRunKm(21.1), '21.1')
  assert.equal(formatFreeRunKm(3), '3.0')
  // 传入非法值也不出现 NaN（回落默认值）
  assert.equal(formatFreeRunKm(Number.NaN), FREE_RUN_KM_DEFAULT.toFixed(1))
})

test('档位：都在合法区间内，且包含操场常用跑量与半马', () => {
  assert.deepEqual([...FREE_RUN_KM_PRESETS], [3, 5, 10, 21.1])
  for (const p of FREE_RUN_KM_PRESETS) {
    assert.equal(clampFreeRunKm(p), p, `档位 ${p} 不该被夹紧`)
    assert.ok(p >= FREE_RUN_KM_MIN && p <= FREE_RUN_KM_MAX)
  }
})

test('estimateLaps：按车道周长估算圈数；数据不足返回 null（界面据此不显示）', () => {
  // 标准 400 m 跑道：5 km ≈ 12.5 圈
  assert.equal(estimateLaps(5, 400), 12.5)
  assert.equal(estimateLaps(42.2, 400), 105.5)
  assert.equal(estimateLaps(3, 250), 12)
  // 周长非法/缺失 ⇒ null（不是 0 圈，也不是 NaN）
  assert.equal(estimateLaps(5, 0), null)
  assert.equal(estimateLaps(5, -400), null)
  assert.equal(estimateLaps(5, Number.NaN), null)
  assert.equal(estimateLaps(5, Number.POSITIVE_INFINITY), null)
})

test('estimateFreeRunSeconds：按配速估算时长；配速非法返回 null', () => {
  assert.equal(estimateFreeRunSeconds(5, 360), 1800)
  assert.equal(estimateFreeRunSeconds(21.1, 360), 7596)
  assert.equal(estimateFreeRunSeconds(5, 0), null)
  assert.equal(estimateFreeRunSeconds(5, -1), null)
  assert.equal(estimateFreeRunSeconds(5, Number.NaN), null)
  assert.equal(estimateFreeRunSeconds(5, Number.POSITIVE_INFINITY), null)
})
