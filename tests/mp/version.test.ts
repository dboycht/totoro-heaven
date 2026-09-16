/**
 * 版本比较测试（"发现新版本"提示的依据）
 * 关键语义：**无法解析时一律返回 0（不提示）** —— 宁可漏提示，也不要误报"有新版本"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, isNewerVersion, parseVersion } from '../../utils/mp/version.ts'

test('parseVersion：解析数字段、容忍 v 前缀与后缀', () => {
  assert.deepEqual(parseVersion('1.1.5'), [1, 1, 5])
  assert.deepEqual(parseVersion('v1.2'), [1, 2])
  assert.deepEqual(parseVersion('1.1.5-beta.1'), [1, 1, 5])
  assert.deepEqual(parseVersion('1.1.5+build.9'), [1, 1, 5])
  assert.equal(parseVersion('dev'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(undefined), null)
  assert.equal(parseVersion(null), null)
})

test('compareVersions：逐段比较，段数不足补 0', () => {
  assert.equal(compareVersions('1.1.5', '1.1.4'), 1)
  assert.equal(compareVersions('1.1.4', '1.1.5'), -1)
  assert.equal(compareVersions('1.1.5', '1.1.5'), 0)
  assert.equal(compareVersions('v1.2', '1.2.0'), 0)
  assert.equal(compareVersions('1.2.0', '1.1.99'), 1, '按段比较而不是字符串比较')
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '两位数段不能被当成字符串比较')
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
})

test('compareVersions：无法解析 → 0（保守，不提示更新）', () => {
  assert.equal(compareVersions('dev', '1.1.5'), 0)
  assert.equal(compareVersions('1.1.5', 'dev'), 0)
  assert.equal(compareVersions(undefined, undefined), 0)
})

test('isNewerVersion：只在确实更新时为 true', () => {
  assert.equal(isNewerVersion('1.1.6', '1.1.5'), true)
  assert.equal(isNewerVersion('1.1.5', '1.1.5'), false)
  assert.equal(isNewerVersion('1.1.4', '1.1.5'), false)
  assert.equal(isNewerVersion('v1.2.0', '1.1.5'), true)
  assert.equal(isNewerVersion('dev', '1.1.5'), false)
  assert.equal(isNewerVersion(null, '1.1.5'), false)
})
