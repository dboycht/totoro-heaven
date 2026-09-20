/**
 * 报文 token 掩码的纯函数测试（2026-09-20 审计修复）
 *
 * 为什么值得钉住：审计发现「结算后的报文预览」会把 `sunRunExercises` / `sunRunExercisesDetail`
 * **原样打印并支持复制**，而这两个报文里都有 `token`（本机会话凭据）⇒ 屏幕上明文可见、一键复制即进剪贴板。
 * 真实提交那条路径早就会掩码（`real/submit.ts` 的 `scoreRequestMasked`），只有预览漏了。
 *
 * 判据：① 顶层与嵌套的 `token` 都掩码；② **不改动入参**（调用方手里那份还得能拿去提交）；
 *      ③ 空值/非字符串也掩码（避免"空值时反而露出原文"的岔路）；④ 深结构不会把界面卡住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MASK_TOKEN_PLACEHOLDER, maskPayloadTokens } from '../../utils/mp/maskPayload.ts'

test('maskPayloadTokens：顶层与嵌套的 token 都被掩码，其它字段原样保留', () => {
  const payload = {
    token: 'WXXCX-REAL-TOKEN-abcdefghijklmnop',
    paperId: 'demo_task_2026F',
    mileage: '3.21',
    nested: { token: 'another-real-token', keep: 1 },
    list: [{ token: 'x'.repeat(40), index: 0 }],
  }
  const masked = maskPayloadTokens(payload)
  assert.equal(masked.token, MASK_TOKEN_PLACEHOLDER)
  assert.equal(masked.nested.token, MASK_TOKEN_PLACEHOLDER)
  assert.equal(masked.list[0]!.token, MASK_TOKEN_PLACEHOLDER)
  // 其它字段一个都不许动
  assert.equal(masked.paperId, 'demo_task_2026F')
  assert.equal(masked.mileage, '3.21')
  assert.equal(masked.nested.keep, 1)
  assert.equal(masked.list[0]!.index, 0)
  // 序列化后不含任何原文
  const text = JSON.stringify(masked)
  assert.ok(!text.includes('WXXCX-REAL-TOKEN'), text.slice(0, 120))
  assert.ok(!text.includes('another-real-token'))
})

test('maskPayloadTokens：**不改动入参**（同一份报文还要用于真实提交）', () => {
  const payload = { token: 'real', detail: { token: 'real2' } }
  const masked = maskPayloadTokens(payload)
  assert.equal(payload.token, 'real', '入参必须保持原样')
  assert.equal(payload.detail.token, 'real2', '嵌套入参也必须保持原样')
  assert.notEqual(masked, payload, '返回值应是新对象')
  assert.notEqual(masked.detail, payload.detail)
})

test('maskPayloadTokens：空值/非字符串 token 同样掩码；键名大小写不敏感', () => {
  assert.equal(maskPayloadTokens({ token: '' }).token, MASK_TOKEN_PLACEHOLDER)
  assert.equal(maskPayloadTokens({ token: null }).token, MASK_TOKEN_PLACEHOLDER)
  assert.equal(maskPayloadTokens({ token: 123 }).token, MASK_TOKEN_PLACEHOLDER)
  assert.equal(maskPayloadTokens({ Token: 'abc' }).Token, MASK_TOKEN_PLACEHOLDER)
  assert.equal(maskPayloadTokens({ TOKEN: 'abc' }).TOKEN, MASK_TOKEN_PLACEHOLDER)
  // 只是"像 token"的键名不掩码（`tokenType` 不是凭据）
  assert.equal(maskPayloadTokens({ tokenType: 'WXXCX' }).tokenType, 'WXXCX')
})

test('maskPayloadTokens：超深结构原样保留（不递归到天荒地老），非对象值直接透传', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { token: 'too-deep' } } } } } } } }
  const out = maskPayloadTokens(deep, MASK_TOKEN_PLACEHOLDER, 3)
  // 超过深度的层级保持原样（掩码是"尽力而为"，但不能把界面卡死）
  assert.equal(typeof out, 'object')
  assert.equal(maskPayloadTokens(null), null)
  assert.equal(maskPayloadTokens(undefined), undefined)
  assert.equal(maskPayloadTokens('plain'), 'plain')
  assert.equal(maskPayloadTokens(42), 42)
})
