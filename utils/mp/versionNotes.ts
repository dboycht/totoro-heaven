/**
 * **「版本更新」弹窗文案的解析层**（纯函数，零依赖，有单测）
 *
 * ## 用户口径（2026-11-28）
 * > "添加一个「版本更新」的弹窗；启动新版本的时候弹窗说明本次更新了什么；
 * >  这个文本的内容我自己去写；因此你还需要给我写一个编辑器让我来编写。"
 *
 * ## 文案在哪
 * 每个版本一个文件：`public/version-notes/<版本>.md`（随源码进 canonical、打包时自动带上）。
 * 写作用独立的小编辑器（`tools/version-notes-editor/`，与主程序无关）；
 * 本模块只负责**把文本读成界面要的结构**。
 *
 * ## 支持的一小撮 Markdown（"简易"就这三样，别的原样当文字）
 *   · `- ` 开头的列表项（连续几行并成一个列表）
 *   · `**粗体**`（成对才生效；没配对就当普通星号，不猜）
 *   · `#` / `##` / `###` 小标题（最多三级）
 *   · 其余每个非空行 = 一段；空行只作分隔，不产出空段
 *
 * ⚠️ **故意不解析 HTML**：渲染层只按 `{ text, bold }` 片段吐文本节点（Vue 自动转义），
 *    文案里写 `<script>` 也只是字面文字 —— 这条比"支持更多语法"重要。
 */

/** 一段行内文字（`bold` = 这段要不要加粗） */
export interface NotesInlineSegment {
  text: string
  bold: boolean
}

/** 一个块：段落 / 小标题 / 列表 */
export interface NotesBlock {
  kind: 'p' | 'h' | 'ul'
  /** `p` / `h` 的行内片段（`ul` 用 `items`） */
  text?: NotesInlineSegment[]
  /** `h` 的级别（1~3） */
  level?: 1 | 2 | 3
  /** `ul` 的每一项（每项本身又是行内片段数组） */
  items?: NotesInlineSegment[][]
}

export interface ParsedVersionNotes {
  blocks: NotesBlock[]
  /** 归一化后的字符数（0 = 没写） */
  chars: number
  /** 文案为空（弹窗据此显示"本版未填写"而不是空白卡片） */
  isEmpty: boolean
}

/**
 * 归一化：CRLF → LF、去掉行尾空白与首尾空行、去掉 BOM。
 * 判据：Windows 编辑器存出来的 CRLF 文件不会在界面上多出空行。
 */
export function normalizeVersionNotes(raw: unknown): string {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/**
 * 行内解析：`**粗体**` 成对才生效。
 * 判据：`a**b**c` ⇒ [a, b(粗), c]；`a**b` ⇒ 整条原样（没配对就不猜，避免吃掉半个星号）。
 */
export function parseNotesInline(line: string): NotesInlineSegment[] {
  const src = String(line ?? '')
  const out: NotesInlineSegment[] = []
  const re = /\*\*([^*]+?)\*\*/g
  let last = 0
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: src.slice(last, at), bold: false })
    out.push({ text: m[1]!, bold: true })
    last = at + m[0].length
  }
  if (last < src.length) out.push({ text: src.slice(last), bold: false })
  return out.length ? out : [{ text: '', bold: false }]
}

/** 把整篇文案读成块序列（空文本 ⇒ `isEmpty=true`、`blocks=[]`） */
export function parseVersionNotes(raw: unknown): ParsedVersionNotes {
  const text = normalizeVersionNotes(raw)
  if (!text.trim()) return { blocks: [], chars: 0, isEmpty: true }
  const blocks: NotesBlock[] = []
  let list: NotesInlineSegment[][] | null = null
  const flushList = () => {
    if (list && list.length) blocks.push({ kind: 'ul', items: list })
    list = null
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      flushList()
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      flushList()
      blocks.push({ kind: 'h', level: heading[1]!.length as 1 | 2 | 3, text: parseNotesInline(heading[2]!) })
      continue
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      list ??= []
      list.push(parseNotesInline(bullet[1]!))
      continue
    }
    flushList()
    blocks.push({ kind: 'p', text: parseNotesInline(line) })
  }
  flushList()
  return { blocks, chars: text.length, isEmpty: false }
}

/**
 * 这次启动该不该弹（纯函数，界面只读它的结果）。
 *
 * 判据（用户 2026-11-28 口径"版本号变了才弹一次"）：
 *   · 读不到版本号 / 版本号是 `dev` ⇒ 不弹（开发态不打扰）；
 *   · `seenVersion` 与本机版本相同 ⇒ 不弹（同一版本只弹一次）；
 *   · 彩蛋页 `/play` 与空白页 `/blank` ⇒ 不弹（那两页有自己的开场流程，别叠弹窗）。
 */
export function shouldShowVersionNotes(input: {
  version: string
  seenVersion?: string | null
  path?: string
}): boolean {
  const version = String(input.version || '').trim()
  if (!version || version === 'dev') return false
  const path = String(input.path ?? '')
  if (path === '/play' || path === '/blank') return false
  return String(input.seenVersion ?? '').trim() !== version
}