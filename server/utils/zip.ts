/**
 * 最小 ZIP **写入器**（store 模式，不压缩）—— 2026-09-21 新增，供「一键诊断导出」用
 *
 * ## 为什么不装依赖
 * 本仓是**零运行期依赖**的纪律（`package.json` 只有 nuxt/vue/ky/vue-router），
 * 而这里只需要「把几个内存里的 Buffer 打成一个能被 Windows 资源管理器 / 7-Zip / unzip 打开的包」：
 * store（method=0，不压缩）模式的 ZIP 结构**只需 3 段**（local file header + data + central directory + EOCD），
 * 不必为了这点活引入 deflate 库。
 *
 * ## 来源与许可（规则 13：机械活先找轮子）
 * - 结构/字段布局参照 **Go 标准库 `archive/zip` 的 writer**（BSD-3-Clause，`https://go.dev/src/archive/zip/writer.go`）：
 *   local header 30 字节固定头、central directory 46 字节固定头、EOCD 22 字节，字段顺序与偏移照抄；
 *   Go 的 `detectUTF8`（"能不用 UTF-8 标志就不用，要求多字节时才置"）我们**简化**成「一律置 bit 11」——
 *   本包文件名含中文是常态，一律置位语义最确定（且是本任务的硬要求）。
 * - CRC32（IEEE 802.3，多项式 `0xEDB88320`，反射实现）与流式用法参考 **zip-go**（MIT，
 *   `https://github.com/jimmywarting/zip-go`，`lib/crc.js`）：同样的 `-1` 初值、每字节查表、末尾取反。
 * - 代码是**读懂后按上述两处结构自己写的**（无任何第三方代码原样拷入）：Go 是 Go、zip-go 是
 *   WebStream 流式 + data descriptor，两者都不能直接搬；本文件也没有第三方运行期依赖。
 *
 * ## 取舍（明确写下来，免得后人猜）
 * - **store 模式**：入口内容本来就是 UTF-8 文本（日志/JSON），deflate 能省 60~80%，
 *   但"零依赖 + 输出可被任何工具打开"优先；体积由调用方控制（日志 ≤3×8MB）。
 * - **不用 data descriptor**：本写入器**一次性**拿到完整内容（不是流），
 *   于是 local header 里就能写**真实**的 crc/size —— 少写 16 字节/条，也让"边写边流"的读取器更省事。
 * - **不做 ZIP64**：总长超 `ZIP64_LIMIT` 时**直接抛错**而不是悄悄写出越界字段（那种包打开就报错、更难查）。
 * - **文件名一律 UTF-8 且置 bit 11**（通用位标志第 11 位 = 语言编码标志）。
 */

/** 单条要写入的条目：包内路径（`/` 分隔）+ 内容 */
export interface ZipEntry {
  /** 包内路径，如 `logs/app-2026-09-21.log`；**必须**用 `/`，不得以 `/` 开头 */
  name: string
  /** 内容（UTF-8 文本或任意二进制） */
  data: Uint8Array | Buffer
}

/** 写入时刻（默认取当前时间；显式传入便于单测固定字节） */
export interface ZipOptions {
  /** 条目的 DOS 时间戳（本地时间；ZIP 的 MS-DOS 时间没有时区，按调用方给的原样编码） */
  date?: Date
}

/**
 * ZIP64 的起点（`0xFFFFFFFF` 是这个 32 位字段的"哨兵值"，不能当真实长度写进去）。
 * 留一点余量：本包实际只有 ~24MB 上限，正常永远碰不到。
 */
const ZIP64_LIMIT = 0xfffffff0

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/**
 * CRC-32（IEEE 802.3 / ZIP 用的是同一个）：`crc = ~(init ~ crc 逐字节查表)`。
 * 多项式 `0xEDB88320` 是 IEEE 多项式的**反射**形式（ZIP/PNG/gzip 都用它）。
 */
export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS 时间（local header / central directory 的时间字段；秒只有 2 秒精度，是格式本身的限制） */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear()
  // DOS 时间从 1980 起算；更早的日期夹到 1980（避免写出负数）
  const y = Math.max(0, year - 1980)
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f)
  const date = ((y & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  return { time: time & 0xffff, date: date & 0xffff }
}

/**
 * 把若干条目打成**一个完整的 ZIP 文件字节串**（全部在内存里拼，调用方自己决定要不要落盘）。
 *
 * ⚠️ 抛出（fail fast，而不是写出一个坏包）：条目为空、名字非法、名字重名、内容超 4GB、总长超 ZIP64 上限。
 */
export function createZip(entries: ZipEntry[], options: ZipOptions = {}): Buffer {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('createZip: 至少要有一个条目')
  if (entries.length > 0xffff) throw new Error(`createZip: 条目过多（${entries.length}）—— 本实现不做 ZIP64 的条目数扩展`)

  const { time, date } = dosDateTime(options.date ?? new Date())

  /** 先算总长（local 段 + central 段 + EOCD 22），一次分配、零碎片 */
  interface Planned {
    nameBuf: Buffer
    data: Buffer
    crc: number
    offset: number
  }
  const planned: Planned[] = []
  let localBytes = 0
  for (const e of entries) {
    const name = String(e?.name ?? '')
    if (!name) throw new Error('createZip: 条目 name 不能为空')
    if (name.startsWith('/') || name.includes('\\')) throw new Error(`createZip: 条目 name 必须是"以 / 分隔的相对路径"：${name}`)
    const raw = e?.data
    if (!(raw instanceof Uint8Array)) throw new Error(`createZip: 条目 ${name} 的 data 必须是 Uint8Array/Buffer`)
    if (raw.length > ZIP64_LIMIT) throw new Error(`createZip: 条目 ${name} 超过 4GB，本实现不支持 ZIP64`)
    const nameBuf = Buffer.from(name, 'utf8')
    if (nameBuf.length > 0xffff) throw new Error(`createZip: 条目 ${name} 的名字过长`)
    if (planned.some((p) => p.nameBuf.equals(nameBuf))) throw new Error(`createZip: 条目重名：${name}`)
    planned.push({ nameBuf, data: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), crc: crc32(raw), offset: localBytes })
    localBytes += 30 + nameBuf.length + raw.length
  }
  let centralBytes = 0
  for (const p of planned) centralBytes += 46 + p.nameBuf.length
  const totalBytes = localBytes + centralBytes + 22
  if (totalBytes > ZIP64_LIMIT) throw new Error(`createZip: 总长 ${totalBytes} 超过 4GB，本实现不支持 ZIP64`)

  const out = Buffer.alloc(totalBytes)
  let at = 0

  // ---------- ① local file header（30 字节固定 + 名字 + 内容）----------
  for (const p of planned) {
    out.writeUInt32LE(0x04034b50, at) // 签名 "PK\x03\x04"
    out.writeUInt16LE(20, at + 4) // version needed to extract = 2.0
    out.writeUInt16LE(0x0800, at + 6) // flags：bit 11 = 文件名是 UTF-8（中文名的关键）
    out.writeUInt16LE(0, at + 8) // method = 0（store，不压缩）
    out.writeUInt16LE(time, at + 10)
    out.writeUInt16LE(date, at + 12)
    out.writeUInt32LE(p.crc, at + 14) // ← 一次性拿到内容，所以这里能写**真实**值（不用 data descriptor）
    out.writeUInt32LE(p.data.length, at + 18) // compressed size
    out.writeUInt32LE(p.data.length, at + 22) // uncompressed size（store 模式下二者相等）
    out.writeUInt16LE(p.nameBuf.length, at + 26)
    out.writeUInt16LE(0, at + 28) // extra field 长度 = 0
    p.nameBuf.copy(out, at + 30)
    p.data.copy(out, at + 30 + p.nameBuf.length)
    at += 30 + p.nameBuf.length + p.data.length
  }

  // ---------- ② central directory（46 字节固定 + 名字）----------
  const centralStart = at
  for (const p of planned) {
    out.writeUInt32LE(0x02014b50, at) // 签名 "PK\x01\x02"
    out.writeUInt16LE(0x0014, at + 4) // version made by = 2.0 / MS-DOS（高字节 0 = FAT）
    out.writeUInt16LE(20, at + 6) // version needed to extract
    out.writeUInt16LE(0x0800, at + 8) // flags（与 local header 必须一致）
    out.writeUInt16LE(0, at + 10) // method = store
    out.writeUInt16LE(time, at + 12)
    out.writeUInt16LE(date, at + 14)
    out.writeUInt32LE(p.crc, at + 16)
    out.writeUInt32LE(p.data.length, at + 20)
    out.writeUInt32LE(p.data.length, at + 24)
    out.writeUInt16LE(p.nameBuf.length, at + 28)
    out.writeUInt16LE(0, at + 30) // extra field 长度
    out.writeUInt16LE(0, at + 32) // comment 长度
    out.writeUInt16LE(0, at + 34) // 起始磁盘号
    out.writeUInt16LE(0, at + 36) // internal attributes
    out.writeUInt32LE(0, at + 38) // external attributes（不必置"归档"位：本实现只写文件）
    out.writeUInt32LE(p.offset, at + 42) // 该条目 local header 的偏移（读取器靠它定位）
    p.nameBuf.copy(out, at + 46)
    at += 46 + p.nameBuf.length
  }

  // ---------- ③ EOCD（22 字节，读取器的**唯一入口**：从文件尾部往前找这个签名）----------
  out.writeUInt32LE(0x06054b50, at) // 签名 "PK\x05\x06"
  out.writeUInt16LE(0, at + 4) // 本磁盘号
  out.writeUInt16LE(0, at + 6) // central directory 起始磁盘号
  out.writeUInt16LE(planned.length, at + 8)
  out.writeUInt16LE(planned.length, at + 10)
  out.writeUInt32LE(centralBytes, at + 12)
  out.writeUInt32LE(centralStart, at + 16)
  out.writeUInt16LE(0, at + 20) // zip 注释长度 = 0
  return out
}
