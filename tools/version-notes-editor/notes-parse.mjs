/**
 * 编辑器侧的**预览解析器**（与主程序 `utils/mp/versionNotes.ts` 同一套规则）
 *
 * 为什么会有两份：编辑器是**独立软件**（不依赖 Nuxt、不需要构建），跑在纯 Node + 浏览器里；
 * 主程序那份是 TS。两份必须逐字同行为 —— 由 `tests/mp/versionNotes.test.ts` 的
 * "跨端一致性"用例逐条比对（改了一边忘了另一边，测试当场红）。
 *
 * 规则（"简易 Markdown"就这三样，别的原样当文字）：
 *   · `- ` / `* ` 开头的列表项（连续几行并成一个列表）
 *   · `**粗体**`（成对才生效）
 *   · `#` / `##` / `###` 小标题（最多三级）
 *   · 其余每个非空行 = 一段；空行只作分隔
 */

export function normalizeVersionNotes(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

export function parseNotesInline(line) {
  const src = String(line ?? '')
  const out = []
  const re = /\*\*([^*]+?)\*\*/g
  let last = 0
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: src.slice(last, at), bold: false })
    out.push({ text: m[1], bold: true })
    last = at + m[0].length
  }
  if (last < src.length) out.push({ text: src.slice(last), bold: false })
  return out.length ? out : [{ text: '', bold: false }]
}

export function parseVersionNotes(raw) {
  const text = normalizeVersionNotes(raw)
  if (!text.trim()) return { blocks: [], chars: 0, isEmpty: true }
  const blocks = []
  let list = null
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
      blocks.push({ kind: 'h', level: heading[1].length, text: parseNotesInline(heading[2]) })
      continue
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      list = list ?? []
      list.push(parseNotesInline(bullet[1]))
      continue
    }
    flushList()
    blocks.push({ kind: 'p', text: parseNotesInline(line) })
  }
  flushList()
  return { blocks, chars: text.length, isEmpty: false }
}