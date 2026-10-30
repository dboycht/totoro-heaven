/**
 * 入口拦截单测（2026-10-30，1.3.4）
 *
 * 用户方案：默认拦截校园跑相关链接（输入后"什么也没有"），
 * 在游戏页输入作弊码 `↑↑↓↓←→←→BA` 后跳转真实页面，此后拦截关闭、与正常软件一致。
 *
 * ⚠️ 本文件**直接调用生产代码**（`utils/game/entryGate.ts` 的 `decideRoute`），
 *    不自己复算一份规则 —— 复算等于"测我自己写的副本"，改了生产代码也不会红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideRoute, UNLOCK_KEY } from '../../utils/game/entryGate.ts'
import { CheatDetector, KONAMI_SEQUENCE } from '../../utils/game/chibiRun.ts'

/** 每一个工具页（**必须全部被拦**）：覆盖现有全部路由前缀 */
const TOOL_PATHS = [
  '/app',
  '/runs',
  '/runs/sunrun',
  '/runs/freerun',
  '/run',
  '/freerun',
  '/morning-sign',
  '/field',
  '/field/track-editor',
  '/field/mornsign-zone',
  '/data',
  '/data/records',
  '/data/logs',
  '/records',
  '/logs',
  '/track-editor',
  '/mornsign-zone',
  '/version-info',
  '/credits',
]

test('入口拦截 A：未解锁访问根路径 ⇒ 进游戏页（默认打开就是小游戏）', () => {
  assert.equal(decideRoute('/', false), 'game')
})

test('入口拦截 B：**所有**工具页在未解锁时都被拦（默认全拦，新页面天然安全）', () => {
  const leaked = TOOL_PATHS.filter((p) => decideRoute(p, false) !== 'blank')
  assert.deepEqual(leaked, [], `这些工具页没被拦住（会直接暴露）：${leaked.join(', ')}`)
})

test('入口拦截 C：游戏页与空白页永远可访问', () => {
  for (const p of ['/play', '/blank']) {
    assert.equal(decideRoute(p, false), 'allow', `${p} 未解锁时也应可访问`)
    assert.equal(decideRoute(p, true), 'allow', `${p} 解锁后当然也可访问`)
  }
})

test('入口拦截 D：解锁后一切放行（与正常软件一致）', () => {
  for (const p of ['/', ...TOOL_PATHS]) {
    assert.equal(decideRoute(p, true), 'allow', `${p} 解锁后应放行`)
  }
})

test('入口拦截 E：解锁标记是**会话级**键名（关浏览器即忘，不会永久露馅）', () => {
  assert.equal(UNLOCK_KEY, 'totoro_play_unlocked')
  // 键名固定即可；真正"是 sessionStorage 而不是 localStorage"由实现保证（见 entryGate.ts 注释）
})

test('作弊码 A：完整输入 Konami 序列 ⇒ 解锁，且只触发一次', () => {
  const d = new CheatDetector()
  let fired = 0
  for (const k of KONAMI_SEQUENCE) {
    if (d.feed(k)) fired++
  }
  assert.equal(fired, 1, '完整输入应恰好触发一次')
  assert.equal(d.unlocked, true)
  for (const k of KONAMI_SEQUENCE) d.feed(k) // 再喂一遍不应重复触发（否则会跳转两次）
  assert.equal(d.unlocked, true)
})

test('作弊码 B：中途多按一下 ⇒ 仍能从"能接上的最长前缀"续上（真人手快必然多按）', () => {
  const d = new CheatDetector()
  d.feed('up')
  d.feed('up')
  d.feed('up') // 多按一下上
  assert.equal(d.progress, 2, '连按三下上之后应仍匹配 ↑↑（长度 2），而不是被清零')
  for (const k of ['down', 'down', 'left', 'right', 'left', 'right', 'b', 'a'] as const) d.feed(k)
  assert.equal(d.unlocked, true, '续上后应能解锁（否则"多按一下就永远解不开"）')
})

test('作弊码 C：序列中途按了无关键 ⇒ 回退到"以它结尾的最长前缀"', () => {
  const d = new CheatDetector()
  d.feed('up')
  d.feed('up')
  d.feed('down') // ↑↑↓
  d.feed('up') // 按错：↑↑↓ 后面不该是 ↑
  assert.equal(d.progress, 1, '应回退到只剩第一个 ↑（↑ 是序列前缀）')
})

test('作弊码 D：乱按不会解锁', () => {
  const d = new CheatDetector()
  for (const k of ['a', 'b', 'left', 'a', 'b', 'right', 'up', 'a'] as const) d.feed(k)
  assert.equal(d.unlocked, false)
})

test('作弊码 E：A/B 既是操作键、也参与序列（需求本身的要求）', () => {
  const d = new CheatDetector()
  for (const k of ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right', 'b'] as const) d.feed(k)
  assert.equal(d.unlocked, false, '差最后一个 A 时不该解锁')
  assert.equal(d.feed('a'), true, '最后一个 A 应触发解锁')
})
