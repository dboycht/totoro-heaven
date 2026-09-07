import { createNodeRSA } from './nodeRSA'
import { rsaKeys } from '../data/rsaKeys'

/**
 * 将请求对象序列化后用 RSA 加密为 base64
 * 龙猫校园服务端要求请求体为 RSA(pkcs1) 密文文本
 */
export const encryptRequestContent = (req: unknown): string => {
  const rsa = createNodeRSA(rsaKeys.privateKey)
  const reqStr = JSON.stringify(req)
  return rsa.encrypt(reqStr, 'base64')
}

/**
 * 解密密文为请求对象（联调/解码页用）
 */
export const decryptRequestContent = (cipherBase64: string): unknown => {
  const rsa = createNodeRSA(rsaKeys.privateKey)
  const data = rsa.decrypt(cipherBase64, 'utf8')
  return JSON.parse(data)
}