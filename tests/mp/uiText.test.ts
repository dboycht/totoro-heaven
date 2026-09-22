/**
 * 「用户可见文本里不许出现 markdown 标记」的**源码级**守卫（2026-09-18 新增）
 *
 * 为什么要有：这个坑本项目踩了**三次** ——
 *   ① 1.1.8 发布时界面文本里成片 `**重点**` 原样露出（`ERROR.md` **E44**）；
 *   ② 1.1.9 写更新日志时又在 `releaseArt.ts` 里手写 `**`（当时靠新增的 `releaseArt.test.ts` 抓到）；
 *   ③ 1.1.9 后半段我在「轨迹预览」的模板插值里又写了 `**到官方路线**`（本文件建立时抓到）。
 * 前两次都是"人记得"或"只覆盖某一个文件"，所以这次做成**跨文件**的机器判据。
 *
 * 判据（可执行）：`.vue` 的 `<template>` 段里，**插值/属性/文本节点**中出现的"包住中文的成对星号"
 * 一律视为违规（Vue 不渲染 markdown，用户会看到字面的星号）；`src/mp/releaseArt.ts` 的
 * 用户可见字符串同样不许有（已有 `releaseArt.test.ts` 覆盖，这里再兜一层）。
 *
 * ⚠️ 刻意**排除**这些合法场景，避免误报：
 *   · 注释（HTML 注释与 JS 行注释/块注释）——注释里写 markdown 是给人看的；
 *   · 乘方运算符（例如 `2 ** z`）——**E44 就栽在这上面**（宽正则会把它当成成对标记）；
 *   · 代码块里的 JS 模板字符串（反引号）——反引号不是 markdown 粗体，不在本判据范围。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ⚠️ 用 `fileURLToPath(import.meta.url)` 而不是 `import.meta.dirname`：
 * 测试跑在 Node 的**原生 TS 剥离**下（`node --test tests/mp/*.test.ts`），而 `import.meta.dirname`
 * 在该模式下不被支持（实测报 `SyntaxError: Expected ';', '}' or <eof>`）。项目其它测试同此写法。
 *
 * 📌 **项目根要"向上找"**：本文件在测试运行器里会被拷到 `<项目>/.mp-test-build/tests/mp/`，
 *    此时"上三级"是 `.mp-test-build/`（不是项目根）⇒ 必须靠**特征目录**（`pages/`）
 *    逐级向上定位真正的项目根。直接写死层级会在两种运行方式下各错一次（实测踩到）。
 */
const findProjectRoot = (): string => {
  let dir = join(fileURLToPath(import.meta.url), '..')
  for (let i = 0; i < 6; i++) {
    const parent = join(dir, '..')
    if (existsSync(join(parent, 'pages')) && existsSync(join(parent, 'package.json'))) return parent
    dir = parent
  }
  throw new Error('找不到项目根（pages/package.json 特征目录）—— 测试路径假设失效，请更新本测试')
}
const ROOT = findProjectRoot()

/** 收集要检查的 .vue（页面 + 组件 + 布局） */
const vueFiles = (): { rel: string; abs: string }[] => {
  const out: { rel: string; abs: string }[] = []
  for (const dir of ['pages', 'components', 'layouts']) {
    const abs = join(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.vue')) out.push({ rel: `${dir}/${e.name}`, abs: join(abs, e.name) })
    }
  }
  return out
}

/** 取 `<template>` 段（只查模板；script 里的 JS 对象/注释不算用户可见文本） */
const templateOf = (text) => {
  const start = text.indexOf('<template>')
  const end = text.lastIndexOf('</template>')
  return start >= 0 && end > start ? text.slice(start, end) : ''
}

/** 去掉 HTML 注释（`<!-- ... -->`），注释里的 markdown 不算违规 */
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '')

/** "包住中文的成对星号"（E44 的判据）：`**…中文…**`，且星号内不含另一个星号 */
const MARKDOWN_BOLD_CN = /\*\*[^*\n]*[\u4e00-\u9fa5][^*\n]*\*\*/g

test('用户可见文本：.vue 模板里不得出现"包住中文的成对星号"（Vue 不渲染 markdown）', () => {
  const bad: string[] = []
  for (const { rel, abs } of vueFiles()) {
    const tpl = stripHtmlComments(templateOf(readFileSync(abs, 'utf8')))
    for (const m of tpl.matchAll(MARKDOWN_BOLD_CN)) {
      const line = tpl.slice(0, m.index).split('\n').length
      bad.push(`${rel}（模板内第 ${line} 行附近）：${m[0]}`)
    }
  }
  assert.deepEqual(bad, [], `发现会被用户看到的 markdown 星号：\n  - ${bad.join('\n  - ')}`)
})

/**
 * 🆕 2026-09-22 审计 B11：**模板里的注释也要扫**。
 *
 * 为什么：上一版先 `stripHtmlComments()` 再判 ⇒ "注释里写 `**必须真的显示出来**`" 漏了过去。
 * 它虽然不进 DOM，但**会被后来的编辑者复制进真实文案**（`DiagnosticsExportCard.vue` 实测就是这么发生的 ——
 * 审计正是从这句注释旁边抓到了运行期文案里的星号）。所以注释里的星号也要清。
 *
 * ⚠️ **存量**：其它文件（`RunWorkspace.vue` / `FreePathView.vue` 等，不属于本轮范围）里已经有一批。
 * 处理方式与仓库既有纪律一致 —— **只许变小的基线**：按文件记"当前有几处"，某文件**多出来**就报错。
 * 用**计数**而不是行号：行号会随并行开发挪动而误报/漏报（实测：`FreePathView.vue` 正在被另一条线改）。
 * 清掉某文件的全部存量后，请把该条目从这里删掉（否则守卫又变成一个洞）。
 */
const MARKDOWN_IN_TPL_COMMENT_BASELINE: Record<string, number> = {
  'app.vue': 3,
  'components/DiagnosticsView.vue': 1,
  'components/FreePathView.vue': 17,
  'components/HomeTokenCard.vue': 4,
  'components/RunGateNotice.vue': 3,
  'components/RunSelfCheckCard.vue': 2,
  'components/RunTrajectoryPreview.vue': 1,
  'components/RunWorkspace.vue': 27,
  'components/TabGroupShell.vue': 3,
  'components/TrackEditorView.vue': 6,
  'components/UpdateNotice.vue': 2,
  'layouts/default.vue': 2,
  'pages/morning-sign.vue': 5,
  'pages/version-info.vue': 2,
}

test('用户可见文本：模板**注释**里的中文成对星号（只许比基线更少，新的必须清）', () => {
  const bad: string[] = []
  for (const { rel, abs } of vueFiles()) {
    const n = [...templateOf(readFileSync(abs, 'utf8')).matchAll(MARKDOWN_BOLD_CN)].length
    const allowed = MARKDOWN_IN_TPL_COMMENT_BASELINE[rel] ?? 0
    if (n > allowed) bad.push(`${rel}：${n} 处 > 基线 ${allowed} 处（新增的必须清掉）`)
  }
  assert.deepEqual(bad, [], `模板注释里出现新的 markdown 星号（会被复制进真实文案）：\n  - ${bad.join('\n  - ')}`)
})

/**
 * 🆕 2026-09-22 审计 B11：**script 段里的"会渲染/会进 manifest"的文案**也要守。
 *
 * 为什么单独一条：`DiagnosticsExportCard.vue` 的「这个包里会包含什么」不是模板字面量，
 * 而是 computed 里拼出来的 note 字符串（渲染进 `{{ m.note }}`），模板扫描器看不到；
 * `export.post.ts` 的 manifest note 同理（会写进包内 `manifest.json` 给维护者看）。
 * 判据（可执行）：这些文件里**含中文且含成对星号**的字符串字面量/模板串一律违规；
 * 注释行（`*` / `//` / `/*` 开头）与纯代码行不算 —— 注释里讲 markdown 是给人看的。
 */
test('用户可见文本：运行期拼出来的文案（组件 script / manifest note）也不许有 markdown 星号', () => {
  const files = ['components/DiagnosticsExportCard.vue', 'server/api/local/diagnostics/export.post.ts']
  const bad: string[] = []
  for (const rel of files) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) {
      bad.push(`${rel}：文件不存在（守卫需同步更新）`)
      continue
    }
    const lines = readFileSync(abs, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('<!--')) return
      const hit = [...line.matchAll(MARKDOWN_BOLD_CN)]
      if (hit.length) bad.push(`${rel}:${i + 1} ${hit.map((m) => m[0]).join(' / ')}`)
    })
  }
  assert.deepEqual(bad, [], `运行期文案里有 markdown 星号（用户/manifest 会看到字面 **）：\n  - ${bad.join('\n  - ')}`)
})

/**
 * 🆕 2026-09-22：**纯函数产出的清单文案**也要守（`diagManifestEntries()` 的 note 会渲染到界面）。
 * 这条同时覆盖"服务端 manifest"与"界面预览"——两边用的是同一个函数。
 */
test('用户可见文本：diagManifestEntries 的输出（界面预览 + 包内 manifest）不含 markdown 星号', async () => {
  const { diagManifestEntries } = await import('../../utils/mp/diagnostics.ts')
  const bad: string[] = []
  const cases = [
    diagManifestEntries({ logNames: ['app-2026-09-22.log'], includeGeometry: true }),
    diagManifestEntries({ logNames: [], includeGeometry: false }),
    diagManifestEntries({
      logNames: ['app-2026-09-22.log'],
      includeGeometry: true,
      logNote: '本次只收录记录窗口内的日志行（保留 12 行）',
      window: { id: 'w-1', startedAt: 'a', endedAt: 'b' },
    }),
  ]
  for (const entries of cases) {
    for (const e of entries) {
      for (const m of e.note.matchAll(MARKDOWN_BOLD_CN)) bad.push(`${e.name}: ${m[0]}`)
      if (e.note.includes('`')) bad.push(`${e.name}: 反引号 -> ${e.note.slice(0, 40)}`)
    }
  }
  assert.deepEqual(bad, [], `清单文案里有 markdown：\n  - ${bad.join('\n  - ')}`)
})

test('用户可见文本：releaseArt.ts 的版本条目不含 markdown 标记（与 releaseArt.test.ts 双重覆盖）', async () => {
  const { VERSION_ENTRIES } = await import('../../src/mp/releaseArt.ts')
  const bad: string[] = []
  for (const e of VERSION_ENTRIES) {
    for (const s of [e.title, ...e.highlights, ...(e.note ? [e.note] : [])]) {
      for (const m of s.matchAll(MARKDOWN_BOLD_CN)) bad.push(`v${e.version}: ${m[0]}`)
      if (s.includes('`')) bad.push(`v${e.version}: 反引号 -> ${s.slice(0, 40)}`)
    }
  }
  assert.deepEqual(bad, [], `版本条目里有 markdown：\n  - ${bad.join('\n  - ')}`)
})

test('守卫本身的自测（反向用例）：乘方 `2 ** z` 与注释里的 markdown **不得**被误报', () => {
  // ① 乘方：不含中文 ⇒ 不该命中（E44 的教训：宽正则会误伤求幂）
  assert.equal([...'const y = ((lng + 180) / 360) * 2 ** z'.matchAll(MARKDOWN_BOLD_CN)].length, 0)
  // ② 注释里的成对星号：剥掉注释后不该命中
  const withComment = stripHtmlComments('<!-- 这里是 **说明** 注释 --><div>{{ x }}</div>')
  assert.equal([...withComment.matchAll(MARKDOWN_BOLD_CN)].length, 0)
  // ③ 真违规：模板插值里的成对星号**必须**命中
  const realBad = '<div>—— ⚠️ 这个数是**到官方路线**的距离</div>'
  assert.equal([...realBad.matchAll(MARKDOWN_BOLD_CN)].length, 1)
})

/**
 * 重复按钮守卫（2026-09-18 新增）
 *
 * 起因：`pages/track-editor.vue` 里出现了**两个「保存（本机）」按钮**（用户截图发现）——
 * 我插"重命名弹窗"时多留了一个，而且多出来的那个**没有"内外圈不合法就禁用"的保护** ⇒
 * 用户可能把不合法的圈存进路线库。这类"复制粘贴多留一份"的错，文本断言与类型检查都抓不到。
 *
 * 判据（可执行）：模板里**同一个按钮文案**不得出现两次（`v-btn`/`v-list-item` 的文本节点），
 * 例外用 `ALLOW_DUPLICATE_LABELS` 显式登记并写明原因（**不允许**默默放过）。
 */
const ALLOW_DUPLICATE_LABELS = new Map<string, string>([
  [
    'components/UpdateNotice.vue：立即检测',
    '该组件在"有新版本 / 连不上 GitHub / 正常"三个**互斥分支**里各有一个「立即检测」按钮，' +
      '同一时刻只渲染一个（`v-if` / `v-else-if` / `v-else`），不是视觉重复 —— 2026-09-18 核实过源码',
  ],
  // ⚠️ 2026-09-19：原先这里有一条 `components/HomeTokenCard.vue：一键获取 token` 的例外登记 ——
  //    它登记的"第二处就近入口"被判定为**真重复**（工具栏那个是**无条件常显**的同一个按钮），
  //    已按用户"清除重复性元素"的要求删掉，**这条白名单条目也一并删除**。
  //    判据：白名单里的每一条都必须在代码里**仍然成立**；删功能时要连条目一起清 ——
  //    否则等于给守卫留了个永久的洞（守卫会继续放过同名重复）。
  [
    /**
     * ⚠️ 2026-09-19（审计 R18 修正登记理由）：这条**仍然必要**，但原先的理由写错了 ——
     * 实测是 **2 处**（不是"三处"），两处在**互斥分支**里：
     *   `v-else-if="libEntriesNotForTask"`（库里有条目但都不属于当前任务）与
     *   `v-else`（完全没描过），同一时刻只渲染一个 ⇒ 不是视觉重复。
     * 判据：白名单理由必须与代码**逐条对得上**，否则守卫的可信度会被"一条过时理由"带坏。
     *
     * 🆕 2026-09-22 更新（issue #12）：现在是 **3 处**，仍在**互斥分支**里 ——
     *   `v-if="routeIsFree"`（任务未下发线路且本机一条都没描）/ `v-else-if="libEntriesNotForTask"` /
     *   `v-else-if="activeLinesRaw.length"`，三者的条件两两互斥，同一时刻只渲染一个。
     */
    'components/RunWorkspace.vue：去「跑道编辑」描一条',
    '**3 处**，位于互斥的 `v-if="routeIsFree"` / `v-else-if="libEntriesNotForTask"` / ' +
      '`v-else-if="activeLinesRaw.length"` 分支（本任务未下发线路且没描过 / 库里有别的任务的跑道 / 有线路但没描过），' +
      '同一时刻只渲染一个 —— 2026-09-22 逐行核对过源码',
  ],
])

test('模板守卫：同一个按钮文案不得出现两次（防"复制粘贴多留一份"）', () => {
  const bad: string[] = []
  for (const { rel, abs } of vueFiles()) {
    const tpl = stripHtmlComments(templateOf(readFileSync(abs, 'utf8')))
    // 抓 v-btn / v-list-item 的**直接文本子节点**（形如 `>保存（本机）</v-btn>`）
    const labels = new Map<string, number>()
    for (const m of tpl.matchAll(/>\s*([^<>{}\n]{2,24}?)\s*<\/v-(?:btn|list-item)>/g)) {
      const label = m[1]!.trim()
      if (!label) continue
      labels.set(label, (labels.get(label) ?? 0) + 1)
    }
    for (const [label, n] of labels) {
      if (n <= 1) continue
      if (ALLOW_DUPLICATE_LABELS.has(`${rel}：${label}`)) continue
      bad.push(`${rel}：「${label}」出现 ${n} 次`)
    }
  }
  assert.deepEqual(bad, [], `发现重复按钮（多半是复制粘贴多留了一份）：\n  - ${bad.join('\n  - ')}`)
})

/**
 * 跑道编辑「保存（本机）」的守卫。
 *
 * ⚠️ 2026-09-20 修正：**不要硬编码"哪个文件里有这个按钮"**。
 *    本次分组重构把内容从 `pages/track-editor.vue` 搬进了 `components/TrackEditorView.vue`
 *    （页面变成薄页面）⇒ 硬编码路径的守卫直接报"找不到按钮"（**同一个坑第三次**：
 *    1.1.10 那次是跑步界面从 `pages/run.vue` 搬到 `components/RunWorkspace.vue`）。
 *    所以改成**在所有候选文件里找**，并且断言"**只有一个文件实现它**"——
 *    这样既不会因为搬家失效，也能挡住"复制一份到两个文件"的退化。
 */
test('跑道编辑：「保存（本机）」有且仅有一处，且带"内外圈不合法则禁用"的保护', () => {
  const files = [...vueFiles().map((v) => v.rel), 'components/TrackEditorView.vue'].filter((v, i, a) => a.indexOf(v) === i)
  /** 每个文件里"带文案的保存按钮"的 disabled 表达式 */
  const found: { rel: string; attrs: string }[] = []
  for (const rel of files) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    const tpl = stripHtmlComments(templateOf(readFileSync(abs, 'utf8')))
    for (const m of tpl.matchAll(/<v-btn\b([^>]*)>\s*保存（本机）\s*<\/v-btn>/g)) {
      found.push({ rel, attrs: m[1] ?? '' })
    }
    // 兼容"文案不在同一行/含插值"的写法：退一步看开标签里是否含 ringCheck（仅用于定位）
    if (!tpl.includes('保存（本机）')) continue
  }
  assert.ok(found.length >= 1, '找不到带文案的「保存（本机）」按钮（候选文件里都没有）')
  assert.equal(
    found.length,
    1,
    `「保存（本机）」应**只有 1 处实现**，实际 ${found.length} 处：\n  - ${found.map((f) => f.rel).join('\n  - ')}`,
  )
  assert.match(
    found[0]!.attrs,
    /:disabled="[^"]*ringCheck/,
    `「保存（本机）」（在 ${found[0]!.rel}）必须按 ringCheck 禁用，否则能存进不合法的内外圈`,
  )
})
