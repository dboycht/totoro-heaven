/**
 * `server/utils/zip.ts` 的单测 —— 2026-09-21 新增
 *
 * 手法：**自带一个最小 ZIP 读取器**（只认 store 模式），从包尾找 EOCD → 读 central directory →
 * 按偏移取 local header + 内容 → 校验「名字 / CRC / 长度 / UTF-8 标志」。
 * 这样"写出来的包能不能被解"是**从字节层面**验证的，而不是自我印证：
 * 读取器**独立于写入器**实现（只用签名 + 偏移，不用写入器的任何内部结构）。
 *
 * ⚠️ 为什么不用 `unzip` / 第三方库：本仓纪律是零依赖 + 单测要能在任何机器上离线跑通。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crc32, createZip } from '../../server/utils/zip.ts'

interface ReadEntry {
  name: string
  data: Buffer
  crc: number
  method: number
  utf8Flag: boolean
}

/** 最小 ZIP 读取器：EOCD → central directory → local header → 内容（store 模式专用） */
function readZip(buf: Buffer): ReadEntry[] {
  // ① EOCD：签名 `PK\x05\x06`，从尾部往前找（后面可能跟最多 65535 字节注释，本写入器不写注释）
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, 'EOCD 未找到（不是合法 zip）')
  const count = buf.readUInt16LE(eocd + 10) // 条目总数
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  assert.ok(cdOffset + cdSize <= buf.length, 'central directory 越界')

  const out: ReadEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `第 ${i} 条 central directory 签名不对`)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const size = buf.readUInt32LE(p + 20)
    const uncompressed = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    // ② local header：签名 + 标志 + 方法 + 长度必须与 central directory **一致**
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `${name} 的 local header 签名不对`)
    assert.equal(buf.readUInt16LE(localOffset + 6), flags, `${name} 的 local/central 标志不一致`)
    assert.equal(buf.readUInt16LE(localOffset + 8), method, `${name} 的 local/central 压缩方法不一致`)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const lCrc = buf.readUInt32LE(localOffset + 14)
    const lSize = buf.readUInt32LE(localOffset + 18)
    const dataAt = localOffset + 30 + lNameLen + lExtraLen
    const data = buf.subarray(dataAt, dataAt + lSize)

    assert.equal(lCrc, crc, `${name} 的 local/central CRC 不一致`)
    assert.equal(lSize, size, `${name} 的 local/central 长度不一致`)
    assert.equal(buf.toString('utf8', localOffset + 30, localOffset + 30 + lNameLen), name, `${name} 的 local 名字不一致`)

    out.push({ name, data: Buffer.from(data), crc, method, utf8Flag: (flags & 0x0800) !== 0 })
    assert.equal(uncompressed, size, `${name} 的 store 模式压缩/原始长度应相等`)
    p += 46 + nameLen + extraLen + commentLen
  }
  assert.equal(p, cdOffset + cdSize, 'central directory 实际长度与 EOCD 记录不符')
  return out
}

test('zip：CRCs 与已知标准值一致（含经典的 "123456789" = 0xCBF43926）', () => {
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926)
  assert.equal(crc32(Buffer.alloc(0)), 0)
  assert.equal(crc32(Buffer.from('a', 'ascii')), 0xe8b7be43)
})

test('zip：单条目（纯 ASCII）能被独立解析，名字/内容/CRC/大小都对得上', () => {
  const content = Buffer.from('hello totoro\n', 'utf8')
  const zip = createZip([{ name: 'a.txt', data: content }], { date: new Date(2026, 8, 21, 10, 30, 0) })
  const entries = readZip(zip)
  assert.equal(entries.length, 1)
  const [e] = entries
  assert.ok(e)
  assert.equal(e.name, 'a.txt')
  assert.equal(e.method, 0, '必须是 store 模式（不压缩）')
  assert.ok(e.utf8Flag, 'UTF-8 文件名标志（bit 11）必须置位')
  assert.deepEqual(e.data, content)
  assert.equal(e.crc, crc32(content))
})

test('zip：多条目按输入顺序排列，且 CRC/内容各自独立正确', () => {
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"a":1}', 'utf8') },
    { name: 'snapshot.json', data: Buffer.from('{"b":"中文内容"}', 'utf8') },
    { name: 'logs/app-2026-09-21.log', data: Buffer.from('{"msg":"x"}\n'.repeat(50), 'utf8') },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ]
  const zip = createZip(entries)
  const parsed = readZip(zip)
  assert.deepEqual(parsed.map((p) => p.name), entries.map((e) => e.name))
  for (const [i, p] of parsed.entries()) {
    assert.deepEqual(p.data, entries[i]!.data, `${p.name} 的内容应逐字节相同`)
    assert.equal(p.crc, crc32(entries[i]!.data), `${p.name} 的 CRC 不对`)
  }
})

test('zip：中文/emoji 文件名走 UTF-8 且 bit 11 置位，能原样读回', () => {
  const name = '诊断/日志-猫猫🐱-2026-09-21.log'
  const content = Buffer.from('中文内容也要原样往返', 'utf8')
  const zip = createZip([{ name, data: content }])
  const [e] = readZip(zip)
  assert.ok(e)
  assert.equal(e.name, name, '中文文件名必须原样往返（UTF-8 编码）')
  assert.ok(e.utf8Flag, '含非 ASCII 名字时 bit 11 必须置位（否则 Windows 会按本地代码页解成乱码）')
  assert.deepEqual(e.data, content)
})

test('zip：EOCD 里记录的条目数与 central directory 长度自洽（读取器不靠猜）', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from(`内容${i}`, 'utf8') }))
  const zip = createZip(many)
  const eocdAt = zip.length - 22
  assert.equal(zip.readUInt32LE(eocdAt), 0x06054b50)
  assert.equal(zip.readUInt16LE(eocdAt + 8), 40) // 本磁盘条目数
  assert.equal(zip.readUInt16LE(eocdAt + 10), 40) // 总条目数
  assert.equal(zip.readUInt32LE(eocdAt + 12) + zip.readUInt32LE(eocdAt + 16) + 22, zip.length, 'central 起点 + 长度 + EOCD 必须正好等于文件长度')
  assert.equal(readZip(zip).length, 40)
})

test('zip：空条目列表 / 非法名字 / 重名 / 内容类型不对 都要**当场抛错**（不产出坏包）', () => {
  assert.throws(() => createZip([]), /至少要有一个条目/)
  assert.throws(() => createZip([{ name: '', data: Buffer.alloc(0) }]), /name 不能为空/)
  assert.throws(() => createZip([{ name: '/abs.txt', data: Buffer.alloc(0) }]), /相对路径/)
  assert.throws(() => createZip([{ name: 'a\\b.txt', data: Buffer.alloc(0) }]), /相对路径/)
  assert.throws(
    () =>
      createZip([
        { name: 'dup.txt', data: Buffer.from('1') },
        { name: 'dup.txt', data: Buffer.from('2') },
      ]),
    /重名/,
  )
  assert.throws(() => createZip([{ name: 'x.txt', data: 'not bytes' as unknown as Uint8Array }]), /Uint8Array/)
})
