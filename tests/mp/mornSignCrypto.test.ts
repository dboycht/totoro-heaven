/**
 * 早操签到加密（`encryptLong` 等价实现）测试 —— 2026-09-18
 *
 * 加密是纯函数，所以**不需要线上凭据**就能证明它是对的：
 * 造一对密钥 → 用被测代码加密 → 用私钥解密 → **逐字节比对原文**。
 * 同时钉住三个易错点：**117 字节分段**（不是按字符切）、**密文长度 = 128×段数**、
 * **中文/超长串不裂**（按 UTF-8 字节宽度切）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto'
import { RSA_CHUNK_BYTES, encryptChunk, encryptLong, splitUtf8ByBytes } from '../../utils/mp/mornSignCrypto.ts'

/** 自造 1024-bit 密钥对，公钥以 SPKI/DER/Base64 导出（与厂商公钥同格式） */
const mkKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const b64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  return { b64, privateKey }
}

/** 用私钥把 encryptLong 的结果解回明文（按 128 字节切密文逐段解） */
const decryptLong = (b64: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string => {
  const buf = Buffer.from(b64, 'base64')
  assert.equal(buf.length % 128, 0, `密文长度应为 128 的整数倍，实际 ${buf.length}`)
  const parts: string[] = []
  for (let i = 0; i < buf.length; i += 128) {
    parts.push(
      privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
        buf.subarray(i, i + 128),
      ).toString('utf8'),
    )
  }
  return parts.join('')
}

test('mornSignCrypto：分段按 **UTF-8 字节宽度**（不是按字符数）', () => {
  // 全是 ASCII：117 字节 = 117 字符
  assert.equal(splitUtf8ByBytes('a'.repeat(117)).length, 1)
  assert.equal(splitUtf8ByBytes('a'.repeat(118)).length, 2)
  // 全是中文（每字 3 字节）：117/3 = 39 字满段
  const cn = '中'.repeat(39)
  assert.equal(Buffer.byteLength(cn, 'utf8'), 117)
  assert.deepEqual(splitUtf8ByBytes(cn), [cn])
  assert.equal(splitUtf8ByBytes('中'.repeat(40)).length, 2, '第 40 个中文应另起一段')
  // 每段字节数都不超上限（这是 PKCS#1 的硬约束）
  for (const chunk of splitUtf8ByBytes('中文abc'.repeat(50))) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= RSA_CHUNK_BYTES, `段超限：${Buffer.byteLength(chunk, 'utf8')}`)
  }
})

test('mornSignCrypto：空串返回空串（照厂商行为）', () => {
  assert.equal(encryptLong(''), '')
})

test('mornSignCrypto：单段加密超限时**抛错**（不静默截断）', () => {
  assert.throws(() => encryptChunk('a'.repeat(RSA_CHUNK_BYTES + 1), mkKey().b64), /超过上限/)
})

test('mornSignCrypto：加密→解密往返一致（短串/超长串/中文混合）', () => {
  const { b64, privateKey } = mkKey()
  const cases = [
    'short',
    'a'.repeat(117), // 正好一段
    'a'.repeat(118), // 两段
    JSON.stringify({ taskId: 'mornsignTask-1', qrCode: 'mornsignPlace-2021091700000706', note: '东操场' }),
    '东操场北门'.repeat(40), // 全中文超长
    JSON.stringify({ mixed: '中文与 ascii 混排 1234567890'.repeat(20) }),
  ]
  for (const plain of cases) {
    const enc = encryptLong(plain, b64)
    assert.equal(backToPlain(enc, privateKey), plain, `往返不一致：${plain.slice(0, 24)}…`)
  }
  function backToPlain(enc: string, key: typeof privateKey) {
    return decryptLong(enc, key)
  }
})

test('mornSignCrypto：密文长度 = 128 × 段数，且 Base64 可解', () => {
  const { b64 } = mkKey()
  const plain = 'a'.repeat(300) // 300/117 = 3 段（117+117+66）
  assert.equal(splitUtf8ByBytes(plain).length, 3)
  const buf = Buffer.from(encryptLong(plain, b64), 'base64')
  assert.equal(buf.length, 3 * 128)
})

test('mornSignCrypto：厂商公钥能正常加载（不是占位符）', () => {
  // 用厂商公钥加密一次即可：公钥非法时 createPublicKey 会抛
  const enc = encryptLong('{"probe":1}')
  assert.ok(enc.length > 0)
  assert.equal(Buffer.from(enc, 'base64').length, 128, '1024-bit 单段密文应为 128 字节')
})
