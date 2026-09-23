/**
 * **响应原文留档**（captures）：把每个代理请求**脱敏后的完整响应正文**写成一份单独文件。
 *
 * ## 为什么要有它（用户原话）
 * 「裁剪的话要是有重要数据不就无法获得了？……主要是**我们拿到数据进行分析**，就不在客户端上进行了」
 * ⇒ **响应原文必须完整可分析**。日志行里的 `respBody` 仍是"小而可读"的摘要（给"扫一眼"用），
 * 而**要分析**就去 captures 目录拿原文 —— 两条路各司其职。
 *
 * ## 目录与命名
 * - 目录：**与日志同级** = `<RUNTIME_DIR>/captures`，可用 `TOTORO_CAPTURE_DIR` 覆盖（风格同 `TOTORO_LOG_DIR`）；
 * - 文件名：`<本地时间戳 YYYYMMDD-HHmmssSSS>-<4 位序号>-<端点短名>-<http状态>.<json|txt>`
 *   （字典序 = 时间序，便于人看与脚本排序）；非 JSON 响应存 `.txt`，正文是**全文**；
 * - 元信息：同名 `.meta.json`（本机时间/端点/http/耗时/原始字节/落盘字节/形态/`unpack`/是否裁剪）。
 *
 * ## 🔴 隐私口径**完全不变**
 * 写盘前必须已脱敏（调用方传进来的就是 `summarizeResponseBody()` 的产物）：
 * token 任何形态不落盘、学号/姓名/手机打码、动态键名与自述人名按现有判据。
 * 导出时仍以 `assertNoCredentials()` 为**唯一红线判据**（`hasUnmaskedCredential()` 同源）。
 *
 * ## 坐标
 * captures 与日志行**一视同仁**：本机记录坐标；**导出时若「包含跑道/任务坐标」关闭，captures 里的坐标逐份剥掉**
 * （复用 `stripGeometryFromRespBody()`，**不写第二份口径**）。
 *
 * ## 体积：**不裁单份**，用"总量预算 + 淘汰记账"
 * 单份**永不截断**（这是用户明确要求）；超预算时按"**最旧先淘汰**"腾地方，并把淘汰**记账**写进
 * `<CAPTURE_DIR>/.evicted.json`（累计份数/字节/名字）—— 导出 manifest 会读它，**绝不静默丢**。
 * 「当天不删」与"时间窗"策略沿用日志那一套（窗口只影响**导出**，不影响本机留存）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  DIAG_CAPTURE_DAYS,
  DIAG_CAPTURE_MAX_BYTES,
  captureFileName,
  type CaptureMeta,
} from '../../utils/mp/diagnostics'
import { RUNTIME_DIR, logWarn } from './logger'

/**
 * 时间窗（天）—— **再导出**给 `server/api/local/diagnostics/record/**` 用。
 * ⚠️ 那里**不能**直接 `import '../../../../utils/mp/diagnostics'`（实测解析不到，属打包器路径口径问题），
 * 只能走 `server/utils/*`。所以窗口天数在这里转出一份（值仍只有 `diagnostics.ts` 一个来源）。
 */
export { DIAG_CAPTURE_DAYS }

/**
 * 留档目录（**与日志同级**；`TOTORO_CAPTURE_DIR` 可覆盖）。
 * ⚠️ 与 `logger.ts` 的 `CAPTURE_DIR` 同源同默认（那里只是给别处引用路径用；读写在**本模块**）。
 */
export const CAPTURE_DIR = process.env.TOTORO_CAPTURE_DIR?.trim() || join(RUNTIME_DIR, 'captures')
/** 总量预算（字节）：`TOTORO_CAPTURE_MAX_BYTES` 可覆盖；非法值回落默认 */
export const CAPTURE_MAX_BYTES = ((): number => {
  const raw = Number(process.env.TOTORO_CAPTURE_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DIAG_CAPTURE_MAX_BYTES
})()

/** 淘汰台账（**累计**；导出 manifest 读它，保证"淘汰也看得见"） */
const EVICTED_FILE = '.evicted.json'
interface EvictedLedger {
  /** 累计淘汰份数 */
  files: number
  /** 累计淘汰字节 */
  bytes: number
  /** 最近淘汰的文件名（最多留 200 个） */
  names: string[]
  /** 最后一次淘汰时间（ISO） */
  lastAt: string
}
const EMPTY_LEDGER: EvictedLedger = { files: 0, bytes: 0, names: [], lastAt: '' }

/** 读淘汰台账（不存在/坏了 ⇒ 空台账，**不抛错**） */
export function readEvictedLedger(): EvictedLedger {
  try {
    const p = join(CAPTURE_DIR, EVICTED_FILE)
    if (!existsSync(p)) return { ...EMPTY_LEDGER }
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<EvictedLedger>
    return {
      files: Number(parsed.files ?? 0),
      bytes: Number(parsed.bytes ?? 0),
      names: Array.isArray(parsed.names) ? parsed.names.map(String).slice(-200) : [],
      lastAt: String(parsed.lastAt ?? ''),
    }
  } catch {
    return { ...EMPTY_LEDGER }
  }
}

/** 写淘汰台账（失败只 warn，不影响业务） */
function writeEvictedLedger(ledger: EvictedLedger): void {
  try {
    if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true })
    writeFileSync(join(CAPTURE_DIR, EVICTED_FILE), JSON.stringify(ledger, null, 2), 'utf8')
  } catch (err) {
    logWarn('capture', '淘汰台账写入失败（不影响业务）', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** 目录里"真正的正文文件"（排除 `.meta.json` 与台账） */
const isCapturePayload = (name: string): boolean => /\.(json|txt)$/.test(name) && !name.endsWith('.meta.json')

/** 目录里目前的正文文件（按名字升序 = 时间序） */
function listPayloadFiles(): { name: string; bytes: number; mtimeMs: number }[] {
  try {
    if (!existsSync(CAPTURE_DIR)) return []
    return readdirSync(CAPTURE_DIR)
      .filter(isCapturePayload)
      .map((name) => {
        const st = statSync(join(CAPTURE_DIR, name))
        return { name, bytes: st.size, mtimeMs: st.mtimeMs }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** 当前目录占用（正文 + 元信息 + 台账；**按磁盘实际占用算**，别只算正文那部分） */
export function captureDirBytes(): number {
  try {
    if (!existsSync(CAPTURE_DIR)) return 0
    return readdirSync(CAPTURE_DIR).reduce((s, name) => {
      try {
        return s + statSync(join(CAPTURE_DIR, name)).size
      } catch {
        return s
      }
    }, 0)
  } catch {
    return 0
  }
}

/**
 * 超预算就腾地方：**最旧先淘汰**（正文 + 同名 `.meta.json` 一起删），并把淘汰记进台账。
 * ⚠️ 与日志一致的"**当天不删**"：同一天（按文件名前缀的 `YYYYMMDD`）的文件不参与淘汰 ——
 * 当天的证据正是用户最可能要的（日志轮转那条已经踩过一次，见 logger 的 `rotateOldLogs`）。
 *
 * @param incomingBytes 即将写入的字节数（含元信息估算）
 * @returns 本次淘汰的份数/字节（累计值也在台账里）
 */
export function evictCapturesIfNeeded(incomingBytes: number): { files: number; bytes: number } {
  const result = { files: 0, bytes: 0 }
  try {
    let used = captureDirBytes()
    if (used + incomingBytes <= CAPTURE_MAX_BYTES) return result
    const files = listPayloadFiles()
    const todayPrefix = ((): string => {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    })()
    const ledger = readEvictedLedger()
    for (const f of files) {
      if (used + incomingBytes <= CAPTURE_MAX_BYTES) break
      if (f.name.startsWith(todayPrefix)) continue // 🔒 当天不删
      const metaName = `${f.name}.meta.json`
      let freed = 0
      try {
        freed += statSync(join(CAPTURE_DIR, f.name)).size
        unlinkSync(join(CAPTURE_DIR, f.name))
      } catch {
        continue // 删不掉就跳过（不让单个文件卡住整轮淘汰）
      }
      try {
        if (existsSync(join(CAPTURE_DIR, metaName))) {
          freed += statSync(join(CAPTURE_DIR, metaName)).size
          unlinkSync(join(CAPTURE_DIR, metaName))
        }
      } catch {
        /* 元信息删不掉不影响正文已删的事实 */
      }
      used -= freed
      result.files++
      result.bytes += freed
      ledger.files++
      ledger.bytes += freed
      ledger.names.push(f.name)
    }
    if (result.files > 0) {
      ledger.names = ledger.names.slice(-200)
      ledger.lastAt = new Date().toISOString()
      writeEvictedLedger(ledger)
    }
  } catch {
    /* 淘汰失败不抛错：宁可目录暂时超预算，也不能影响业务 */
  }
  return result
}

/** 进程内自增序号（文件名里那 4 位） */
let seqCounter = 0

/**
 * 写一份 capture（**调用方必须已脱敏**）。
 *
 * @param payload `summarizeResponseBody()` 的产物（`body` = 脱敏后的完整结构 / `text` = 脱敏后的全文）
 * @returns 文件名（成功）或 `null`（失败/没有内容）—— 调用方据此决定日志行里带不带 `capture` 指针
 */
export function writeCapture(input: {
  endpoint: string
  http: number
  ms: number
  originalBytes: number
  payload: { kind: 'json' | 'text' | 'empty'; body?: unknown; text?: string; bytes?: number }
  unpack?: string
  at?: Date
}): string | null {
  try {
    const at = input.at ?? new Date()
    const isJson = input.payload.kind === 'json' && input.payload.body !== undefined
    const text = isJson ? (JSON.stringify(input.payload.body) ?? '') : String(input.payload.text ?? '')
    if (!text) return null
    const payloadBytes = Buffer.byteLength(text, 'utf8')
    if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true })
    /** 先腾地方（按"即将写入的正文 + 元信息估算"来算） */
    evictCapturesIfNeeded(payloadBytes + 1024)
    const name = captureFileName({ at, seq: ++seqCounter, endpoint: input.endpoint, http: input.http, json: isJson })
    const meta: CaptureMeta = {
      at: at.toISOString(),
      endpoint: input.endpoint,
      http: input.http,
      ms: input.ms,
      originalBytes: input.originalBytes,
      bytes: payloadBytes,
      kind: isJson ? 'json' : 'text',
      ...(input.unpack ? { unpack: input.unpack } : {}),
      /** 🔴 **永不裁剪单份** ⇒ 恒为 false（用户要求"完整可分析"） */
      truncated: false,
      fileName: name,
    }
    writeFileSync(join(CAPTURE_DIR, name), text, 'utf8')
    writeFileSync(join(CAPTURE_DIR, `${name}.meta.json`), JSON.stringify(meta, null, 2), 'utf8')
    return name
  } catch (err) {
    // 留档失败**绝不影响业务**：只写一条 warn（日志行照旧，只是没有 capture 指针）
    logWarn('capture', '响应原文留档失败（不影响上游返回）', {
      endpoint: input.endpoint,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** 窗口内要进包的 capture（读回正文；`text` 原样，供红线扫描与坐标剥离） */
export interface CapturePackItem {
  name: string
  bytes: number
  text: string
  meta: CaptureMeta | null
}

/**
 * 取"最近 `days` 天"的 captures（按时间升序），用于导出。
 * 解析不出来的文件名（不是我们生成的）**跳过**，不参与打包。
 */
export function recentCaptures(days = 3, now: Date = new Date()): CapturePackItem[] {
  const out: CapturePackItem[] = []
  try {
    if (!existsSync(CAPTURE_DIR)) return out
    const span = Math.max(0, Math.floor(days))
    if (!span) return out
    const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (span - 1)).getTime()
    for (const f of listPayloadFiles()) {
      const stamp = /^(\d{8})-\d{9}-/.exec(f.name)?.[1]
      if (!stamp) continue
      const t = new Date(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8))).getTime()
      if (!Number.isFinite(t) || t < oldest) continue
      let text = ''
      try {
        text = readFileSync(join(CAPTURE_DIR, f.name), 'utf8')
      } catch {
        continue // 读不了就跳过（不让一份坏文件毁掉整包）
      }
      let meta: CaptureMeta | null = null
      try {
        const mp = join(CAPTURE_DIR, `${f.name}.meta.json`)
        if (existsSync(mp)) meta = JSON.parse(readFileSync(mp, 'utf8')) as CaptureMeta
      } catch {
        meta = null
      }
      out.push({ name: f.name, bytes: Buffer.byteLength(text, 'utf8'), text, meta })
    }
  } catch {
    /* 目录不存在/权限异常 ⇒ 视作"没有 captures"（导出照样要能用） */
  }
  return out
}

/** 给"清空本机数据"用：删掉整个 captures 目录（返回删了几份） */
export function clearCaptures(): { files: number; dir: string } {
  const before = listPayloadFiles().length
  try {
    if (!existsSync(CAPTURE_DIR)) return { files: 0, dir: CAPTURE_DIR }
    for (const name of readdirSync(CAPTURE_DIR)) {
      try {
        unlinkSync(join(CAPTURE_DIR, name))
      } catch {
        /* 单个删不掉就跳过 */
      }
    }
    // 台账也一起清（"清空"了就不该再报"曾经淘汰过"）
    try {
      if (existsSync(join(CAPTURE_DIR, EVICTED_FILE))) unlinkSync(join(CAPTURE_DIR, EVICTED_FILE))
    } catch {
      /* 台账删不掉不影响正文已删 */
    }
  } catch {
    /* 忽略 */
  }
  return { files: before, dir: CAPTURE_DIR }
}

/** 台账文件绝对路径（单测/文档用） */
export const CAPTURE_LEDGER_PATH = (): string => join(CAPTURE_DIR, EVICTED_FILE)
/** 正文文件名（调试用） */
export const capturePath = (name: string): string => join(CAPTURE_DIR, basename(name))
