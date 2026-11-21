/**
 * check-release-art.mjs - BUILD-TIME GATE for dev-placeholder text in src/mp/releaseArt.ts.
 *
 * Why (user caliber 2026-11-21, relayed via dev-sync BOARD): when the user asks for a
 * "build for release" EXE, the shipped UI text must NOT contain the dev-placeholder lines
 * of the current development entry (e.g. 1.3.8's "开发中版本（…）；定版与发布由用户决定。" /
 * "定版与发布由用户决定；本条目日期为开发轮占位日期…" / "本版尚无新改动…" etc.), nor the
 * same-class residue on older cards. The entry must be formalized FIRST (HANDOVER §6 step 1),
 * only then is `npm run sea` allowed.
 *
 * What it scans: src/mp/releaseArt.ts (the single source the version page renders).
 *   Channel A = every STRING LITERAL in the file (that is exactly what ships in the EXE).
 *   Channel B = the file with comments stripped (catches placeholder text pasted unquoted).
 * Comments are exempt: the judging comments inside releaseArt.ts quote the placeholder lines
 * on purpose (they are documentation, not UI text) - a naive grep would stay red forever.
 *
 * Patterns (extend here when the placeholder wording evolves; keep one phrase per line):
 *   开发中版本 / 定版与发布由用户决定 / 开发轮占位日期 / 本版尚无新改动 /
 *   下一轮内容待定 / 下一轮改动会更新本条目 / （开发中）
 *   + any user-facing string literal STARTING WITH 开发中 (mirrors pages/version-info.vue
 *     isDevEntry = note.startsWith('开发中') - such a card would ship as a "dev card").
 *
 * Usage: node pack/sea/check-release-art.mjs [path-to-releaseArt.ts]
 * Exit codes: 0 = clean (formalized), 1 = placeholder found (REFUSE TO PACK), 2 = cannot scan.
 * This file is invoked by pack/sea/build-sea.ps1 step [0/7-pre] and refuses the build on exit != 0.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TARGET = resolve(HERE, '..', '..', 'src', 'mp', 'releaseArt.ts')
const target = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_TARGET

/** Placeholder phrases that must never appear in shipped UI text. Pure data, easy to extend. */
const PATTERNS = [
  '开发中版本',
  '定版与发布由用户决定',
  '开发轮占位日期',
  '本版尚无新改动',
  '下一轮内容待定',
  '下一轮改动会更新本条目',
  '（开发中）',
]

let raw
try {
  raw = readFileSync(target, 'utf8')
} catch (e) {
  console.error(`[check-release-art] cannot read ${target}: ${e.message}`)
  process.exit(2)
}

/**
 * Mini-lexer: single left-to-right pass that classifies the file into
 * line comments / block comments / single-quoted strings / double-quoted strings /
 * template literals / normal code. Returns the collected string literal contents
 * (with escapes kept as-is; the patterns below contain no escape sequences) plus
 * the source with all comments removed (for channel B).
 */
function lex(src) {
  const strings = [] // { text, line, col }
  let out = '' // comment-stripped source
  let line = 1
  let col = 1
  let i = 0
  const n = src.length
  let strStartLine = 0
  let strStartCol = 0
  let buf = ''
  // state machine
  // NORMAL -> LINE_COMMENT | BLOCK_COMMENT | SQ | DQ | TPL
  let state = 'NORMAL'
  const flushOut = (chunk) => { out += chunk }
  while (i < n) {
    const c = src[i]
    const c2 = i + 1 < n ? src[i + 1] : ''
    if (c === '\n') { line++; col = 1 } else { col++ }
    if (state === 'NORMAL') {
      if (c === '/' && c2 === '/') { state = 'LINE'; flushOut('  '); i += 2; col += 1; continue }
      if (c === '/' && c2 === '*') { state = 'BLOCK'; flushOut('  '); i += 2; col += 1; continue }
      if (c === "'" || c === '"' || c === '`') {
        state = c === "'" ? 'SQ' : c === '"' ? 'DQ' : 'TPL'
        strStartLine = line
        strStartCol = col - 1
        buf = ''
        flushOut(' ')
        i++
        continue
      }
      flushOut(c)
      i++
      continue
    }
    if (state === 'LINE') {
      if (c === '\n') { state = 'NORMAL'; flushOut('\n') }
      else flushOut(' ')
      i++
      continue
    }
    if (state === 'BLOCK') {
      if (c === '*' && c2 === '/') { state = 'NORMAL'; flushOut('  '); i += 2; col += 1; continue }
      flushOut(c === '\n' ? '\n' : ' ')
      i++
      continue
    }
    // inside a string literal (SQ / DQ / TPL)
    if (c === '\\') {
      buf += c + (c2 || '')
      flushOut('  ')
      i += 2
      col += 1
      continue
    }
    if ((state === 'SQ' && c === "'") || (state === 'DQ' && c === '"') || (state === 'TPL' && c === '`')) {
      strings.push({ text: buf, line: strStartLine, col: strStartCol })
      state = 'NORMAL'
      flushOut(' ')
      i++
      continue
    }
    buf += c
    // keep multiline template literals' newlines so line numbers in `out` stay truthful
    flushOut(c === '\n' ? '\n' : ' ')
    i++
  }
  // unterminated string/comment at EOF: fail loud rather than guess (better red than silent)
  if (state !== 'NORMAL') return { strings, out, broken: state }
  return { strings, out, broken: null }
}

const { strings, out, broken } = lex(raw)
if (broken) {
  console.error(`[check-release-art] file ends inside ${broken} (unterminated string or comment) - refusing to judge an unparseable file`)
  process.exit(2)
}
if (strings.length < 1) {
  // releaseArt.ts always carries string literals (version entries). ZERO strings means the lexer
  // mis-parsed the file (or the file was replaced by something else) - do NOT silently pass.
  console.error(`[check-release-art] zero string literals found in ${target} - lexer likely mis-parsed this file; refusing to pass. Extend the lexer instead of bypassing this guard.`)
  process.exit(2)
}

const hits = []
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length
const snippet = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 80)

// Channel A: placeholder text inside string literals (this is what ships in the EXE).
for (const s of strings) {
  for (const p of PATTERNS) {
    if (s.text.includes(p)) {
      hits.push({ where: `string @ line ${s.line}`, pattern: p, text: snippet(s.text) })
    }
  }
  // Mirrors pages/version-info.vue isDevEntry: a note starting with 开发中 ships a "dev card".
  if (s.text.startsWith('开发中')) {
    hits.push({ where: `string @ line ${s.line}`, pattern: 'startsWith(开发中)', text: snippet(s.text) })
  }
}

// Channel B: placeholder text anywhere in live (comment-stripped) code - e.g. pasted unquoted.
for (const p of PATTERNS) {
  let idx = out.indexOf(p)
  while (idx >= 0) {
    hits.push({ where: `code @ line ${lineOf(out, idx)}`, pattern: p, text: snippet(out.slice(Math.max(0, idx - 20), idx + p.length + 40)) })
    idx = out.indexOf(p, idx + p.length)
  }
}

if (hits.length > 0) {
  const seen = new Set()
  const uniq = hits.filter((h) => { const k = `${h.where}|${h.pattern}|${h.text}`; if (seen.has(k)) return false; seen.add(k); return true })
  console.error(`[check-release-art] REFUSING TO PACK: ${uniq.length} placeholder hit(s) in ${target}`)
  for (const h of uniq) console.error(`  - ${h.where} :: pattern「${h.pattern}」:: ${h.text}`)
  console.error('[check-release-art] Formalize the entry FIRST (HANDOVER section 6 step 1: version/title/date/highlights/note -> formal user-facing copy), then rebuild.')
  process.exit(1)
}

console.log(`[check-release-art] OK: ${target} has no dev-placeholder text (${strings.length} string literals scanned, 7 patterns).`)
process.exit(0)
