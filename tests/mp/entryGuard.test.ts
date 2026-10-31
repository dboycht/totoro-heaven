/**
 * 入口拦截单测（2026-10-30，1.3.4；2026-10-31 §72 重构状态归属）
 *
 * 用户方案：默认拦截校园跑相关链接（输入后"什么也没有"），
 * 在游戏页输入作弊码 `↑↑↓↓←→←→BA` 后跳转真实页面，此后拦截关闭、与正常软件一致。
 * §72 口径明确：**"一次运行"= EXE 进程生命周期** —— 触发一次后，关网页/刷新/换浏览器
 * 都保持解锁，重启软件才归零 ⇒ 状态真源在服务端（`server/utils/unlockState.ts`），
 * 浏览器侧只是缓存（`composables/useUnlockGate.ts`）。
 *
 * ⚠️ 本文件**直接调用生产代码**（`utils/game/entryGate.ts` 的 `decideRoute`），
 *    不自己复算一份规则 —— 复算等于"测我自己写的副本"，改了生产代码也不会红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideRoute } from '../../utils/game/entryGate.ts'
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
  // ⚠️ `/app` 例外：它是"打开软件"的入口（根路径重定向到它）⇒ 未解锁时进游戏页，判据见测试 I
  const toolPaths = TOOL_PATHS.filter((p) => p !== '/app')
  const leaked = toolPaths.filter((p) => decideRoute(p, false) !== 'blank')
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

test('入口拦截 E：解锁状态的**真源在服务端**（初始未触发；置位后本运行内保持）', async () => {
  const { isUnlockedThisRun, markUnlockedThisRun } = await import('../../server/utils/unlockState.ts')
  // 🔒 服务端标记：纯内存、进程退出即忘 —— 绝不能是持久化的（否则"永久解锁"露馅）
  assert.equal(isUnlockedThisRun(), false, '运行开始时应当是未触发')
  markUnlockedThisRun()
  assert.equal(isUnlockedThisRun(), true, '置位后本次运行内保持（幂等源）')
  markUnlockedThisRun()
  assert.equal(isUnlockedThisRun(), true, '重复置位幂等')
})

/**
 * 🆕 2026-10-30 用户判定（原话）：
 *   「在一次启动过程中，如果用户输入了作弊码，那么在不关闭软件的情况下，
 *     都是跳过游戏界面直接进入到工作台」
 * 这条是**硬需求**：打包 EXE 里"刷新页面"不等于"关软件"，所以不能只靠 sessionStorage。
 */
test('入口拦截 F：解锁后**根路径直接放行**（不再先回游戏页 —— 刷新也不许退回游戏）', () => {
  assert.equal(decideRoute('/', true), 'allow', '已解锁时打开/刷新根路径必须直接进工作台')
})

test('入口拦截 G：接线源码级守卫 —— 通知端点必须同时置**服务端**标记，状态查询必须读同一真源', async () => {
  // §72 重构的接线契约：横幅钩子与解锁置位在同一个端点里；守卫读的也是这份真源。
  // 任何一边漂移（比如只打横幅不置位 / 守卫去读浏览器标记）都会让"关网页再开"场景复发。
  const { readFileSync, existsSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  let dir = dirname(fileURLToPath(import.meta.url))
  let root = ''
  for (let i = 0; i < 6; i++) {
    dir = dirname(dir)
    if (existsSync(join(dir, 'package.json'))) { root = dir; break }
  }
  assert.ok(root, '找不到仓库根')
  const notify = readFileSync(join(root, 'server', 'api', 'local', 'unlock-notify.post.ts'), 'utf8')
  assert.match(notify, /markUnlockedThisRun\(\)/, 'unlock-notify 必须置服务端标记（否则横幅打了、状态没记，关页即丢）')
  const stateRoute = readFileSync(join(root, 'server', 'api', 'local', 'unlock-state.get.ts'), 'utf8')
  assert.match(stateRoute, /isUnlockedThisRun\(\)/, 'unlock-state 必须读服务端真源')
  const guard = readFileSync(join(root, 'middleware', 'guard.global.ts'), 'utf8')
  assert.match(guard, /ensureUnlockState/, '路由守卫必须问服务端真源（不许再读浏览器标记）')
  const play = readFileSync(join(root, 'pages', 'play.vue'), 'utf8')
  assert.match(play, /markUnlockedLocal/, '作弊码命中时浏览器缓存要立即置真（不等网络往返）')
})

test('入口拦截 H：`/app` 就是工作台本身（不能反过来被拦成空白页）', () => {
  // ⚠️ 2026-10-30 修正：`/app` 现在是"打开软件"的入口（根路径重定向到它），
  // 未解锁时应**进游戏页**（与 `/` 一致），不是空白页 —— 详见下面的 I。
  assert.equal(decideRoute('/app', false), 'game')
  assert.equal(decideRoute('/app', true), 'allow')
  assert.equal(decideRoute('/app/', true), 'allow', '带斜杠结尾也要放行（Nuxt 可能规范化成这种形式）')
})

/**
 * 🆕 2026-10-30 实测事故：工作台迁到 `/app`、根路径 `redirect: '/app'` 之后，
 * Nuxt 会在重定向后**再按新地址判一次** ⇒ 未解锁时 `/app` 走"其余地址"分支被送去 `/blank`，
 * 连"打开软件看游戏"都做不到（实测 `/` 的最终地址是 `/blank`）。
 * 判据：**重定向目标必须与来源地址得到同一个判定**。
 */
test('入口拦截 I：`/` 与 `/app` 判定一致（重定向目标不能被拦成空白页）', () => {
  assert.equal(decideRoute('/', false), 'game')
  assert.equal(decideRoute('/app', false), decideRoute('/', false), '未解锁时 / 与 /app 必须同判定')
  assert.equal(decideRoute('/app/', false), decideRoute('/', false), '带斜杠结尾也一样')
  // 反过来：不能因为放宽 `/app` 而把别的工具页也放进了游戏分支
  for (const p of TOOL_PATHS.filter((x) => x !== '/app')) {
    assert.equal(decideRoute(p, false), 'blank', `${p} 仍应被拦成空白页`)
  }
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
