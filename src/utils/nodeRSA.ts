import NodeRSA from 'node-rsa'

/**
 * 创建 pkcs1 方案的 NodeRSA 实例（与原版一致）
 */
export function createNodeRSA(key: string): NodeRSA {
  const rsa = new NodeRSA(key, 'pkcs8-private-pem')
  rsa.setOptions({ encryptionScheme: 'pkcs1' })
  return rsa
}