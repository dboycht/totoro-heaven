/**
 * 终端横幅两变体的**伪装契约**（2026-10-31，§71）
 *
 * 背景：EXE 启动时终端只允许出现"小游戏"口径（`disguised`）；用户在游戏里输入作弊码后，
 * launcher 才打印与原版逐字一致的完整横幅（`full`，「阳光跑助手 · 本地 Web 服务」）。
 * 横幅实现在 `pack/sea/banner.mjs`（esbuild 打包时内联进 SEA 入口），本测试直接 import 同一份 ——
 * 横幅只有一个真源，测试也盯同一个真源。
 *
 * 判据（可执行）：
 *   ① 伪装口径**绝不出现**「阳光跑助手」五个字（这是整个伪装层在终端侧的泄漏面）；
 *   ② `full` 与原版逐字一致（副标题原文 + 版本号/端口注入正确）；
 *   ③ 两变体**除副标题那一行外逐行相同**（改横幅不许只改一个变体）；
 *   ④ 艺术字 `TITLE_LINES` 纯 ASCII（FIGlet 产物约定，见 E0）；
 *   ⑤ 盒子行显示宽度一致（CJK 按 2 列计，E0 的对齐不变量）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 从测试副本（.mp-test-build）向上找仓库根，import 真正的 pack/sea/banner.mjs（同 captureStore.test.ts 的姿势） */
async function importBanner(): Promise<typeof import('../../pack/sea/banner.mjs')> {
  const { join, dirname } = await import('node:path')
  const { existsSync } = await import('node:fs')
  const { pathToFileURL, fileURLToPath } = await import('node:url')
  let dir = dirname(fileURLToPath(import.meta.url))
  let root = ''
  for (let i = 0; i < 6; i++) {
    dir = dirname(dir)
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'pack', 'sea', 'banner.mjs'))) {
      root = dir
      break
    }
  }
  if (!root) throw new Error('找不到仓库根（package.json + pack/sea/banner.mjs）')
  return (await import(pathToFileURL(join(root, 'pack', 'sea', 'banner.mjs')).href)) as typeof import('../../pack/sea/banner.mjs')
}

/** 剥掉 ANSI 色码（横幅的 styled 行带颜色；宽度与文本断言都基于剥色后的纯文本） */
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '')

/** 与 banner.mjs 同口径的显示宽度：CJK（> U+1FFF）计 2 列 */
const displayWidth = (s: string): number =>
  [...s].reduce((w, ch) => w + (ch.codePointAt(0)! > 0x1fff ? 2 : 1), 0)

test('launcherBanner：伪装口径绝不出现「阳光跑助手」，只写小游戏口径', async () => {
  const { buildBanner } = await importBanner()
  const text = stripAnsi(buildBanner({ variant: 'disguised', version: '1.3.4', port: 3000 }))
  assert.ok(!text.includes('阳光跑助手'), '伪装横幅出现了「阳光跑助手」—— 终端侧伪装泄漏')
  assert.ok(!text.includes('Web 服务'), '伪装横幅出现了「Web 服务」—— 终端侧伪装泄漏')
  assert.ok(text.includes('像素小游戏'), '伪装横幅没有小游戏口径副标题')
})

test('launcherBanner：full 变体与原版逐字一致（副标题原文 + 版本/端口注入）', async () => {
  const { buildBanner } = await importBanner()
  const text = stripAnsi(buildBanner({ variant: 'full', version: '1.3.4', port: 4321 }))
  assert.ok(text.includes('阳光跑助手 · 本地 Web 服务'), 'full 变体副标题不是原版原文')
  assert.ok(text.includes('v1.3.4'), '版本号未注入')
  assert.ok(text.includes('localhost:4321'), '端口未注入')
})

test('launcherBanner：两变体除副标题一行外逐行相同（改横幅不许只改一个变体）', async () => {
  const { buildBanner } = await importBanner()
  const a = stripAnsi(buildBanner({ variant: 'disguised', version: '9.9.9', port: 3000 })).split('\n')
  const b = stripAnsi(buildBanner({ variant: 'full', version: '9.9.9', port: 3000 })).split('\n')
  assert.equal(a.length, b.length, '两变体行数不同')
  const diffs = a.map((line, i) => (line === b[i] ? -1 : i)).filter((i) => i >= 0)
  assert.equal(diffs.length, 1, `两变体差异行数应为 1（副标题），实际 ${diffs.length} 行：${diffs.join(',')}`)
  assert.ok(a[diffs[0]!]!.includes('像素小游戏'), 'disguised 差异行不是小游戏副标题')
  assert.ok(b[diffs[0]!]!.includes('阳光跑助手'), 'full 差异行不是原版副标题')
})

test('launcherBanner：艺术字 TITLE_LINES 纯 ASCII（FIGlet 产物约定，E0）', async () => {
  const { TITLE_LINES } = await importBanner()
  assert.ok(TITLE_LINES.length >= 4, '艺术字行数异常')
  for (const line of TITLE_LINES) {
    assert.ok([...line].every((ch) => ch.codePointAt(0)! < 128), `艺术字出现非 ASCII 字符：${line}`)
  }
})

test('launcherBanner：盒子行显示宽度一致（CJK 按 2 列，E0 对齐不变量）', async () => {
  const { buildBanner } = await importBanner()
  for (const variant of ['disguised', 'full'] as const) {
    const lines = stripAnsi(buildBanner({ variant, version: '1.3.4', port: 3000 })).split('\n')
    const boxLines = lines.filter((l) => l.startsWith('│') && l.endsWith('│'))
    assert.equal(boxLines.length, 2, `${variant} 盒子应有标题/副标题两行`)
    const widths = boxLines.map(displayWidth)
    assert.equal(widths[0], widths[1], `${variant} 盒子两行显示宽度不一致（${widths.join(' vs ')}）—— 盒子会错位`)
  }
})
