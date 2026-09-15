/**
 * 「一键获取 token」纯逻辑测试（候选清洗 / 形状判定 / 掩码）
 *
 * 语义边界：
 *   - 只认 `WXXCX` + base64、长度 ≥80（实测真实 token 101 字符）；
 *   - 清洗**不去重判有效**（验活在服务端做）；去重、限量、丢弃非串/畸形串；
 *   - 展示一律用掩码，**永不回显完整 token**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN_MAX_CANDIDATES,
  TOKEN_MIN_LEN,
  TOKEN_PREFIX,
  isTokenShape,
  maskToken,
  sanitizeCandidates,
} from '../../utils/mp/tokenScan.ts'

/** 造一个形似真实 token 的串（WXXCX + base64，长度可控） */
const makeToken = (len = 101) => `${TOKEN_PREFIX}${'A'.repeat(Math.max(0, len - TOKEN_PREFIX.length))}`

test('常量：前缀与最小长度与扫描器一致', () => {
  assert.equal(TOKEN_PREFIX, 'WXXCX')
  assert.equal(TOKEN_MIN_LEN, 80)
  assert.ok(TOKEN_MAX_CANDIDATES >= 1)
})

test('isTokenShape：合法形态通过（含前后空白）', () => {
  assert.equal(isTokenShape(makeToken(101)), true)
  assert.equal(isTokenShape(`  ${makeToken(80)}  `), true)
  assert.equal(isTokenShape(makeToken(80)), true)
  // base64 的全字符集都要能通过
  assert.equal(isTokenShape(`${TOKEN_PREFIX}${'aZ0+/='.repeat(14)}`), true)
})

test('isTokenShape：长度不足 / 前缀不对 / 非法字符 / 非串 都拒绝', () => {
  assert.equal(isTokenShape(makeToken(79)), false, '79 < 80 应拒绝')
  assert.equal(isTokenShape(`XXXXX${'A'.repeat(100)}`), false, '前缀不对')
  assert.equal(isTokenShape(`${TOKEN_PREFIX}${'A'.repeat(90)}-bad`), false, '含非 base64 字符')
  assert.equal(isTokenShape(`${TOKEN_PREFIX}${'A'.repeat(90)} B`), false, '含空格')
  assert.equal(isTokenShape(undefined), false)
  assert.equal(isTokenShape(null), false)
  assert.equal(isTokenShape(12345), false)
  assert.equal(isTokenShape(`${TOKEN_PREFIX}中文${'A'.repeat(90)}`), false)
})

test('sanitizeCandidates：过滤畸形、去重、保持出现顺序', () => {
  const a = makeToken(101)
  const b = makeToken(95)
  const out = sanitizeCandidates([a, b, a, 'garbage', `${TOKEN_PREFIX}short`, 42, null, b])
  assert.deepEqual(out, [a, b])
})

test('sanitizeCandidates：非数组 / 空输入 → 空数组（不抛）', () => {
  assert.deepEqual(sanitizeCandidates(undefined), [])
  assert.deepEqual(sanitizeCandidates(null), [])
  assert.deepEqual(sanitizeCandidates('not-an-array'), [])
  assert.deepEqual(sanitizeCandidates([]), [])
  assert.deepEqual(sanitizeCandidates([{}]), [])
})

test('sanitizeCandidates：超过上限时截断（防内存里大量伪串拖慢验活）', () => {
  const many = Array.from({ length: TOKEN_MAX_CANDIDATES + 5 }, (_, i) => `${TOKEN_PREFIX}${'A'.repeat(90)}${i}`)
  const out = sanitizeCandidates(many)
  assert.equal(out.length, TOKEN_MAX_CANDIDATES)
  assert.equal(out[0], many[0])
})

test('maskToken：只暴露前 8 位与长度，绝不回显完整 token', () => {
  const t = makeToken(101)
  const masked = maskToken(t)
  assert.ok(masked.startsWith(t.slice(0, 8)))
  assert.ok(masked.includes('101'))
  assert.equal(masked.includes(t.slice(8)), false, '不应包含第 9 位之后的任何内容')
  assert.equal(maskToken(''), '')
})
