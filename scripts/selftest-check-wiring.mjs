/**
 * selftest-check-wiring.mjs —— 给 `check-wiring.mjs` 做**自测**（零依赖）
 *
 * 为什么需要：一个永远绿、其实没在查的检查器，比没有检查器更危险。
 * 做法（`memory/13-文档索引与台账自检纪律.md` §3.2 的"注入漂移自测"）：
 *   ① 把检查器要读的源文件**复制**到临时目录（保持相对路径）；
 *   ② 在副本上**故意注入违规**；
 *   ③ 断言检查器"**报出了那一条** 且 **退出码非 0**"；
 *   ④ 再对未篡改的副本断言退出码 0（避免把"检查器坏了"误判成"代码有问题"）。
 * 全程只读写临时目录，不碰真实源码。
 *
 * 用法：node scripts/selftest-check-wiring.mjs
 */
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKER = join(ROOT, 'scripts', 'check-wiring.mjs')

/** 检查器会读到的路径（与 check-wiring.mjs 保持一致） */
const NEEDED = [
  'composables/useMpReal.ts',
  // ⚠️ 2026-09-17 结构整理：真实链路已拆为 组装器 + real/{state,data,submit}.ts；
  //    这几个文件检查器**也要读**（顺序 / 构造出口 / E33 守卫），副本里必须一并存在。
  'composables/real/state.ts',
  'composables/real/data.ts',
  'composables/real/submit.ts',
  'composables/useMpDemo.ts',
  // ⚠️ 本次结构整理：演示/跑步机链路已拆为 组装器 + demo/{state,records,runner}.ts；
  //    这几个文件检查器**也要读**（E33 守卫 / 报文构造出口），副本里必须一并存在。
  'composables/demo/state.ts',
  'composables/demo/records.ts',
  'composables/demo/runner.ts',
  'pages/run.vue',
  'pages/index.vue',
  'pages/records.vue',
  'utils/mp/submitPayload.ts',
  'utils/mp/runData.ts',
  'src/mp/envelope.ts',
  'src/mp/types.ts',
  'src/mp/constants.ts',
  'src/wrappers/MpApiWrapper.ts',
  // ⚠️ 2026-09-17 D 轮（分层规则）：检查器现在还要读代理与契约层常量 ——
  //    L7 断言"前缀单一来源"（代理不得自己声明 KNOWN_PREFIXES、constants 必须有 MP_PATH_PREFIXES）。
  'server/api/mp/[...slug].ts',
  // ⚠️ 2026-09-18（1.1.9）：R10 断言"全局提示必须走 useNotice() 单一契约"——
  //    检查器要读 app.vue（必须 provide NOTICE_KEY）与 composables/useNotice.ts（键的唯一来源）。
  'app.vue',
  'composables/useNotice.ts',
  // ⚠️ 2026-09-18（1.1.9）：R11 断言"kebab-case 绑定不得丢掉 prop"——
  //    检查器要把页面里的组件标签与**组件文件里声明的 props** 对照，所以组件文件也必须在副本里，
  //    否则 byName 找不到它、检查直接跳过（自测实测：漏拷组件 → 注入违规却"通过"）。
  'components/RunTrajectoryPreview.vue',
]

/**
 * 真实提交源文件（`submitRealRun` 所在）——顺序注入必须打在**检查器真正读到的**那个文件上。
 * 与 `check-wiring.mjs` 的 `readFirstExisting` 同序：新路径优先、旧路径兜底。
 */
const REAL_SUBMIT_REL =
  ['composables/real/submit.ts', 'composables/useMpReal.ts'].find((rel) => existsSync(join(ROOT, rel))) ?? ''

/**
 * 演示预览的报文构造源文件（`buildScoreDetailRequest(` / `buildScoreRequest(` 所在）——
 * 与 `check-wiring.mjs` 的候选取序一致：新路径优先、旧路径兜底。
 */
const DEMO_BUILDER_RELS = ['composables/demo/runner.ts', 'composables/useMpDemo.ts']

/**
 * 在**所有存在的候选文件**上注入违规：结构整理后构造出口只在其中一个文件里，
 * 同时注入两处可以保证"不管检查器解析到哪个候选"都仍能被抓到。
 * 返回**真正被改写过**的相对路径 —— 一个都没改到 = 注入目标失效（符号又搬走了），自测必须报错。
 */
const injectInDemoBuilders = (dir, pattern, replacement) => {
  const touched = []
  for (const rel of DEMO_BUILDER_RELS) {
    const file = join(dir, rel)
    if (!existsSync(file)) continue
    const before = readFileSync(file, 'utf8')
    const after = before.replace(pattern, replacement)
    if (after === before) continue
    writeFileSync(file, after, 'utf8')
    touched.push(rel)
  }
  return touched
}

const run = (root) => {
  const res = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` }
}

const sandbox = mkdtempSync(join(tmpdir(), 'wiring-selftest-'))
const failures = []
const copyBase = () => {
  const dir = mkdtempSync(join(sandbox, 'case-'))
  for (const rel of NEEDED) {
    const dest = join(dir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(join(ROOT, rel), dest)
  }
  return dir
}

try {
  // ---------- 基线：未篡改必须通过 ----------
  {
    const dir = copyBase()
    const { code, out } = run(dir)
    if (code !== 0) failures.push(`基线副本应当通过，实际退出码 ${code}：\n${out}`)
  }

  // ---------- 注入 1：E33 复发（真包没有的字段又回来了）----------
  {
    const dir = copyBase()
    const file = join(dir, 'utils/mp/submitPayload.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replace(
      'export function buildScoreDetailRequest',
      'const BAD = { gyroscope: [], accelerometer: [], cheatCode: "正常跑步" }\n\nexport function buildScoreDetailRequest',
    ), 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push('注入了 `gyroscope:` 但检查器仍然通过（E33 守卫失效）')
    else if (!out.includes('E33 复发')) failures.push(`注入了 E33 复发字段，但报错信息不是预期的：\n${out}`)
  }

  // ---------- 注入 2：提交顺序被打乱（成绩早于建场次）----------
  {
    const dir = copyBase()
    // ⚠️ 结构整理后 `submitRealRun` 在 `composables/real/submit.ts`（useMpReal.ts 里只剩组装器）；
    //    注入必须打在**那个**文件上，否则检查器找不到序列 → 自测会误判成"没抓到"。
    if (!REAL_SUBMIT_REL) {
      failures.push('找不到真实提交源文件（composables/real/submit.ts / composables/useMpReal.ts 都不存在）：自测需同步更新')
    } else {
      const file = join(dir, REAL_SUBMIT_REL)
      const text = readFileSync(file, 'utf8')
      // 把首次出现的 getRunBegin 前面塞一个 saveScores 调用 → saveScores 抢到更靠前的位置
      writeFileSync(file, text.replace(
        'MpApiWrapper.getRunBegin(',
        'MpApiWrapper.saveScores({} as never, {}), MpApiWrapper.getRunBegin(',
      ), 'utf8')
      const { code, out } = run(dir)
      if (code === 0) failures.push('打乱了提交顺序但检查器仍然通过（顺序守卫失效）')
      else if (!out.includes('顺序错误')) failures.push(`顺序被打乱，但报错信息不是预期的：\n${out}`)
    }
  }

  // ---------- 注入 3：明细不走单一构造器 ----------
  {
    const dir = copyBase()
    // ⚠️ 本次结构整理后 `buildScoreDetailRequest(` 在 `composables/demo/runner.ts`
    //    （`useMpDemo.ts` 里只剩组装器）；两个候选都注入，否则检查器读到的文件没被篡改 → 自测会误判成"没抓到"。
    const touched = injectInDemoBuilders(dir, /buildScoreDetailRequest\(/g, 'inlineDetailBuilder(')
    if (!touched.length) failures.push('注入 3：候选文件里找不到 `buildScoreDetailRequest(`（自测需同步更新）')
    const { code, out } = run(dir)
    if (code === 0) failures.push('明细不再走构造器但检查器仍然通过（单一出口守卫失效）')
    else if (!out.includes('buildScoreDetailRequest')) failures.push(`报错信息不是预期的：\n${out}`)
  }

  // ---------- 注入 4：成绩报文退回"手抄"（B 轮统一的反向守卫）----------
  {
    const dir = copyBase()
    // 同上：`buildScoreRequest(` 现在住在 `composables/demo/runner.ts`。
    const touched = injectInDemoBuilders(dir, /buildScoreRequest\(/g, 'handWrittenScore(')
    if (!touched.length) failures.push('注入 4：候选文件里找不到 `buildScoreRequest(`（自测需同步更新）')
    const { code, out } = run(dir)
    if (code === 0) failures.push('成绩报文不再走构造器但检查器仍然通过（单一出口守卫失效）')
    else if (!out.includes('buildScoreRequest')) failures.push(`报错信息不是预期的：\n${out}`)
  }

  // ---------- 注入 5：纯逻辑层被塞进框架运行时依赖（D 轮分层规则）----------
  {
    const dir = copyBase()
    const file = join(dir, 'utils/mp/runData.ts')
    writeFileSync(file, `import { ref } from 'vue' // 注入：纯逻辑层不该依赖框架\n${readFileSync(file, 'utf8')}`, 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push('纯逻辑层 import vue 但检查器仍然通过（分层守卫失效）')
    else if (!out.includes('框架运行时依赖')) failures.push(`报错信息不是预期的：\n${out}`)
  }

  // ---------- 注入 6：代理又自己声明了一份上游前缀（D 轮"单一来源"规则）----------
  {
    const dir = copyBase()
    const file = join(dir, 'server/api/mp/[...slug].ts')
    writeFileSync(file, `const KNOWN_PREFIXES = ['/wxxcx/'] // 注入：重复声明\n${readFileSync(file, 'utf8')}`, 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push('代理重新声明 KNOWN_PREFIXES 但检查器仍然通过（单一来源守卫失效）')
    else if (!out.includes('KNOWN_PREFIXES')) failures.push(`报错信息不是预期的：\n${out}`)
  }
  // ---------- 注入 7：模板里裸取可空状态（E27 的成因）----------
  {
    const dir = copyBase()
    const file = join(dir, 'pages/records.vue')
    const text = readFileSync(file, 'utf8')
    // 往模板末尾塞一个"裸取值"：task 是 `useState<MpSunrunTask | null>` 的可空状态
    const injected = text.replace('</template>', '  <div>{{ task.paperName }}</div>\n</template>')
    if (injected === text) failures.push('注入 7：pages/records.vue 里找不到 </template>（自测需同步更新）')
    writeFileSync(file, injected, 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push('模板裸取可空状态但检查器仍然通过（空值守卫失效）')
    else if (!out.includes('裸取可空状态')) failures.push(`报错信息不是预期的：\n${out}`)
  }

  // ---------- 注入 8（反向用例）：同样访问但**写成 v-if 守卫** ⇒ 必须通过 ----------
  // 这条比"能抓到"更重要：它证明守卫识别**不会误报**（否则规则会被人当噪音关掉）。
  {
    const dir = copyBase()
    const file = join(dir, 'pages/records.vue')
    const text = readFileSync(file, 'utf8')
    writeFileSync(file, text.replace('</template>', '  <div v-if="task">{{ task.paperName }}</div>\n</template>'), 'utf8')
    const { code, out } = run(dir)
    if (code !== 0) failures.push(`写了 v-if 守卫却被判违规（规则误报）：\n${out}`)
  }

  // ---------- 注入 9：完全空的 catch（请求/业务路径必须留痕）----------
  {
    const dir = copyBase()
    const file = join(dir, 'utils/mp/runData.ts')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n\nexport function __injected(): void {\n  try { JSON.parse('{') } catch {}\n}\n`, 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push('出现完全空的 catch 但检查器仍然通过（留痕守卫失效）')
    else if (!out.includes('完全空的 catch')) failures.push(`报错信息不是预期的：\n${out}`)
  }
  // ---------- 注入 10：把夜间限制套回「开始跑步」（夜间只该拦真实提交）----------
  {
    const dir = copyBase()
    const file = join(dir, 'pages/run.vue')
    const text = readFileSync(file, 'utf8')
    // ⚠️ 2026-09-18：该按钮的 disabled 现在含多个条件（!activeTask / !libEntries.length / !activeLines.length），
    //    所以注入要**就地追加**夜间条件，而不是替换成某个固定串。
    const injected = text.replace(/(:disabled="!activeTask[^"]*)"/, '$1 || gateStatus.blockedBy === \'night\'"')
    if (injected === text) failures.push('注入 10：pages/run.vue 里找不到「开始跑步」的 disabled 绑定（自测需同步更新）')
    writeFileSync(file, injected, 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push('夜间限制被套回「开始跑步」但检查器仍然通过（适用面守卫失效）')
    else if (!out.includes('只停真实提交')) failures.push(`报错信息不是预期的：\n${out}`)
  }

  // ---------- 注入 13：去掉「开始跑步」的"已配置跑道"约束（2026-09-18 用户要求收紧）----------
  {
    const dir = copyBase()
    const file = join(dir, 'pages/run.vue')
    const text = readFileSync(file, 'utf8')
    const injected = text.replace(
      ':disabled="!activeTask || !configuredForTask"',
      ':disabled="!activeTask"',
    )
    if (injected === text) failures.push('注入 13：pages/run.vue 里找不到「开始跑步」的完整 disabled 绑定（自测需同步更新）')
    writeFileSync(file, injected, 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push('「开始跑步」不再要求"已配置跑道"，但检查器仍然通过（R9 收紧失效）')
    else if (!out.includes('已配置跑道')) failures.push(`报错信息不是预期的：\n${out}`)
  }

  // ---------- 注入 11：提示函数退回"各自内联声明"的字符串注入键（1.1.9 的 useNotice 契约）----------
  {
    const dir = copyBase()
    const file = join(dir, 'pages/records.vue')
    const text = readFileSync(file, 'utf8')
    const injected = text.replace(
      'const showSnackbar = useNotice()',
      "const showSnackbar = inject<(msg: string, color?: string) => void>('showSnackbar', () => {})",
    )
    if (injected === text) failures.push('注入 11：pages/records.vue 里找不到 `const showSnackbar = useNotice()`（自测需同步更新）')
    writeFileSync(file, injected, 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push("页面退回 `inject('showSnackbar')` 但检查器仍然通过（单一契约守卫失效）")
    else if (!out.includes('useNotice')) failures.push(`报错信息不是预期的：\n${out}`)
  }

  // ---------- 注入 12：kebab-case 绑定会丢掉 prop（R11；2026-09-18 真踩到）----------
  // 把 `:lapLengthM="run.lapLengthM"` 改回 `:lap-length="..."` —— 组件声明的 prop 是 lapLengthM，
  // Vue dev 模式用 hyphenate('lapLengthM')='lap-length-m' 严格比对 ⇒ 静默丢弃。检查器必须报出来。
  {
    const dir = copyBase()
    const file = join(dir, 'pages/run.vue')
    const text = readFileSync(file, 'utf8')
    const injected = text.replace(':lapLengthM="run.lapLengthM"', ':lap-length="run.lapLengthM"')
    if (injected === text) failures.push('注入 12：pages/run.vue 里找不到 `:lapLengthM="run.lapLengthM"`（自测需同步更新）')
    writeFileSync(file, injected, 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push('kebab-case 绑定丢掉 prop，但检查器仍然通过（R11 守卫失效）')
    else if (!out.includes('静默丢弃')) failures.push(`报错信息不是预期的：\n${out}`)
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('=== check-wiring 自测（注入违规验证）===\n')
if (failures.length) {
  console.log(`❌ 自测失败 ${failures.length} 条：`)
  for (const f of failures) console.log('   - ' + f)
  process.exit(1)
}
console.log(
  '✅ 自测通过：基线通过、13 类注入（E33 复发 / 顺序错乱 / 绕过明细构造器 / 绕过成绩构造器 / 纯逻辑层拉框架 / ' +
    '代理重复声明前缀 / 模板裸取可空状态 / 空 catch / 夜间限制套回「开始跑步」/ 提示退回字符串注入键 / ' +
    'kebab 绑定丢 prop / **开始跑步不再要求已配置跑道**）都被抓到且退出码非 0，' +
    '且"写了 v-if 守卫"的反向用例不会被误报。',
)
