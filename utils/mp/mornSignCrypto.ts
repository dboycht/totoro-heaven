/**
 * 早操签到提交所需的 **RSA 加密**（`encryptLong` 等价实现）—— 2026-09-18
 *
 * ## 这是什么
 * `morningExercises` 是**唯一使用加密参的端点**：请求体只有一个字段 `{ encryptParams }`，
 * 里面是"业务 JSON 明文"经 RSA 分段加密后的 Base64。厂商小程序用的是 JSEncrypt 的 `encryptLong`：
 *
 * ```js
 * // 厂商 app-service.js（解包产物）里的等价实现
 * function splitUtf8(str, 117)              // 按 UTF-8 字节宽度切，每段 ≤117 字节
 * chunks.map(c => rsaEncrypt_pkcs1v15(c))   // 1024-bit 密钥 ⇒ 128-11 = 117
 * Buffer.concat(encrypted).toString('base64')  // 密文拼接后整体 Base64
 * ```
 *
 * ## 为什么可以离线自证
 * 加密是**纯函数**（只依赖公钥），所以单测可以：造一对密钥 → 用我们这段代码加密 → 用私钥解密
 * → **逐字节比对原文**。这样"117 字节分段 / 密文长度 = 128×段数 / 中文不裂"都能在没有线上凭据时证明。
 *
 * ⚠️ 本模块**只负责加密**，不发起任何请求；是否提交由调用方与用户决定（见 `morningSign.ts` 顶部红线说明）。
 */
import { constants, createPublicKey, publicEncrypt, type KeyObject } from 'node:crypto'

/**
 * 厂商的 RSA 公钥（1024-bit，SPKI/DER，Base64）。
 * 出处：厂商小程序解包产物 `_mp-analyze/extracted/app-service.js`（硬编码常量），
 * 与第三方 `lib/server/morning-sign.js:10` 中的常量**逐字符一致**（双向印证）。
 */
export const MORNSIGN_PUBLIC_KEY_B64 =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC/dTvkr4EMAVX2Op39VYwufkOG1X6bDIXY8SPwOAujssdHuj/AbJKKAPAHYfNKFSt6IsPKNJcQRd94B1cc1Qb+AHOR+Zj4QnfGU7JLw0W2NrobGX3i6wBJCgxmvXqKDp+7fXs/r1zo76krrIj+bEEHKo3hPbLKaI1Xw9B1mFPUEQIDAQAB'

/** 1024-bit 密钥单段明文上限：128 − 11（PKCS#1 v1.5 填充开销） */
export const RSA_CHUNK_BYTES = 117

const keyCache = new Map<string, KeyObject>()

const publicKeyOf = (b64: string): KeyObject => {
  const cached = keyCache.get(b64)
  if (cached) return cached
  const key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })
  keyCache.set(b64, key)
  return key
}

/**
 * 按 **UTF-8 字节宽度**把字符串切成每段 ≤ `maxBytes` 字节的片段。
 *
 * ⚠️ **不能按 `slice()` 切字符**：一个中文字符占 3 字节，按字符切会让某一段的字节数超限
 *    （PCKS#1 上限是硬约束，超了 `publicEncrypt` 直接抛错）。所以这里逐字符累计字节宽度。
 *    厂商的做法完全一致（`charCodeAt` 判 1/2/3/4 字节）。
 */
export function splitUtf8ByBytes(value: string, maxBytes = RSA_CHUNK_BYTES): string[] {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0
    const w = c <= 0x7f ? 1 : c <= 0x7ff ? 2 : c <= 0xffff ? 3 : 4
    if (bytes + w > maxBytes) {
      out.push(cur)
      cur = ch
      bytes = w
    } else {
      cur += ch
      bytes += w
    }
  }
  if (cur) out.push(cur)
  return out
}

/** 单段加密（PKCS#1 v1.5）；段长超限时抛错（而不是静默截断） */
export function encryptChunk(chunk: string, publicKeyB64 = MORNSIGN_PUBLIC_KEY_B64): Buffer {
  const bytes = Buffer.byteLength(chunk, 'utf8')
  if (bytes > RSA_CHUNK_BYTES) {
    throw new Error(`单段明文 ${bytes} 字节超过上限 ${RSA_CHUNK_BYTES}（应先分段）`)
  }
  return publicEncrypt({ key: publicKeyOf(publicKeyB64), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(chunk, 'utf8'))
}

/**
 * `encryptLong` 等价实现：分段加密 → 密文拼接 → 整体 Base64。
 * 空串按厂商行为返回空串（`if (!n || 0 === n.length) return ''`）。
 */
export function encryptLong(value: string, publicKeyB64 = MORNSIGN_PUBLIC_KEY_B64): string {
  const text = String(value ?? '')
  if (!text) return ''
  const chunks = splitUtf8ByBytes(text)
  return Buffer.concat(chunks.map((c) => encryptChunk(c, publicKeyB64))).toString('base64')
}
