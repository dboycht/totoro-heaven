/**
 * **「版本更新」弹窗文案的解析与判定**（2026-11-28，用户口径）
 *
 * 用户原话："添加一个「版本更新」的弹窗；启动新版本的时候弹窗说明本次更新了什么；
 * 这个文本的内容我自己去写；因此你还需要给我写一个编辑器让我来编写。"
 *
 * 这里钉住四件事（都是"改坏了不报错、只会静默显示错东西"的一类）：
 *   ① 归一化：CRLF / BOM / 行尾空白 / 首尾空行都不许变成界面上的空行或怪字符；
 *   ② 简易 Markdown 只有三样（列表 / 粗体 / 三级小标题），其余原样当文字；
 *   ③ **不解析 HTML**：文案里写 `<script>` 只是字面文字（渲染层只用文本节点）；
 *   ④ 独立编辑器那份解析器（`tools/version-notes-editor/notes-parse.mjs`）与主程序**逐条同结果**
 *      —— 两边各改一边忘了另一边，这条当场红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  normalizeVersionNotes,
  parseNotesInline,
  parseVersionNotes,
  shouldShowVersionNotes,
} from '../../utils/mp/versionNotes.ts'

/** 向上找项目根（测试副本里上两级是 `.mp-test-build/`，不能写死层级） */
const findProjectRoot = (): string => {
  let dir = join(fileURLToPath(import.meta.url), '..')
  for (let i = 0; i < 6; i++) {
    const parent = join(dir, '..')
    if (existsSync(join(parent, 'pages')) && existsSync(join(parent, 'package.json'))) return parent
    dir = parent
  }
  throw new Error('找不到项目根（pages/package.json 特征目录）')
}
const ROOT = findProjectRoot()
const mirrorUrl = pathToFileURL(join(ROOT, 'tools', 'version-notes-editor', 'notes-parse.mjs')).href

test('normalizeVersionNotes：CRLF / BOM / 行尾空白 / 首尾空行都被抹平', () => {
  const raw = '\uFEFF- 第一行  \r\n- 第二行\r\n\r\n'
  assert.equal(normalizeVersionNotes(raw), '- 第一行\n- 第二行')
  assert.equal(normalizeVersionNotes(undefined), '')
  assert.equal(normalizeVersionNotes('\n\n  \n'), '')
})

test('parseNotesInline：成对星号才加粗，没配对原样保留', () => {
  assert.deepEqual(parseNotesInline('a**b**c'), [
    { text: 'a', bold: false },
    { text: 'b', bold: true },
    { text: 'c', bold: false },
  ])
  assert.deepEqual(parseNotesInline('**整条粗体**'), [{ text: '整条粗体', bold: true }])
  // 没配对 ⇒ 整条原样（不许吃掉半个星号）
  assert.deepEqual(parseNotesInline('a**b'), [{ text: 'a**b', bold: false }])
  // 空行/空串 ⇒ 一个空片段（渲染层据此占位，不会 undefined）
  assert.deepEqual(parseNotesInline(''), [{ text: '', bold: false }])
})

test('parseVersionNotes：连续列表项并成一个列表，空行另起一个；小标题最多三级', () => {
  const parsed = parseVersionNotes('## 本次更新\n- 一\n- 二\n\n- 三\n普通一段')
  assert.equal(parsed.isEmpty, false)
  assert.equal(parsed.blocks.length, 4)
  assert.equal(parsed.blocks[0]!.kind, 'h')
  assert.equal(parsed.blocks[0]!.level, 2)
  assert.equal(parsed.blocks[1]!.kind, 'ul')
  assert.equal(parsed.blocks[1]!.items!.length, 2)
  assert.equal(parsed.blocks[2]!.kind, 'ul')
  assert.equal(parsed.blocks[2]!.items!.length, 1)
  assert.equal(parsed.blocks[3]!.kind, 'p')
  // `####` 不是小标题（只支持三级）⇒ 当普通段落
  const deep = parseVersionNotes('#### 四级')
  assert.equal(deep.blocks[0]!.kind, 'p')
})

test('parseVersionNotes：空文案 ⇒ isEmpty（界面显示"本版未填写"，不是空白卡片）', () => {
  assert.equal(parseVersionNotes('').isEmpty, true)
  assert.equal(parseVersionNotes('   \n\n').isEmpty, true)
  assert.deepEqual(parseVersionNotes('').blocks, [])
  assert.equal(parseVersionNotes('一条').isEmpty, false)
})

test('parseVersionNotes：**不解析 HTML**（文案里写 <script> 只是字面文字）', () => {
  const parsed = parseVersionNotes('<script>alert(1)</script>')
  assert.equal(parsed.blocks.length, 1)
  assert.equal(parsed.blocks[0]!.kind, 'p')
  assert.deepEqual(parsed.blocks[0]!.text, [{ text: '<script>alert(1)</script>', bold: false }])
})

test('shouldShowVersionNotes：版本变了才弹；dev / play / blank 一律不弹', () => {
  assert.equal(shouldShowVersionNotes({ version: '1.3.10', seenVersion: null }), true)
  assert.equal(shouldShowVersionNotes({ version: '1.3.10', seenVersion: '1.3.9' }), true)
  assert.equal(shouldShowVersionNotes({ version: '1.3.10', seenVersion: '1.3.10' }), false)
  assert.equal(shouldShowVersionNotes({ version: 'dev', seenVersion: null }), false)
  assert.equal(shouldShowVersionNotes({ version: '', seenVersion: null }), false)
  assert.equal(shouldShowVersionNotes({ version: '1.3.10', seenVersion: null, path: '/play' }), false)
  assert.equal(shouldShowVersionNotes({ version: '1.3.10', seenVersion: null, path: '/blank' }), false)
  assert.equal(shouldShowVersionNotes({ version: '1.3.10', seenVersion: null, path: '/app' }), true)
})

test('跨端一致性：独立编辑器的 notes-parse.mjs 与主程序逐条同结果', async () => {
  const mirror = (await import(mirrorUrl)) as {
    normalizeVersionNotes: (raw: unknown) => string
    parseNotesInline: (line: string) => unknown
    parseVersionNotes: (raw: unknown) => unknown
  }
  const fixtures = [
    '',
    '   \n\n',
    '一条',
    '- a\n- b',
    '## 标题\n- **粗**体\n普通行\n\n- 第三项',
    '\uFEFF- 第一行  \r\n- 第二行\r\n',
    '<script>alert(1)</script>',
    '**未配对\n***\n- **两边**都有**粗**',
  ]
  for (const fixture of fixtures) {
    assert.equal(mirror.normalizeVersionNotes(fixture), normalizeVersionNotes(fixture), `归一化不一致：${JSON.stringify(fixture)}`)
    assert.deepEqual(mirror.parseVersionNotes(fixture), parseVersionNotes(fixture), `块序列不一致：${JSON.stringify(fixture)}`)
  }
  for (const line of ['a**b**c', 'a**b', '**整条**', '', '- 列表']) {
    assert.deepEqual(mirror.parseNotesInline(line), parseNotesInline(line), `行内解析不一致：${line}`)
  }
})