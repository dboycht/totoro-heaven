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
  [
    'components/HomeTokenCard.vue：一键获取 token',
    '第一处是 token 卡片工具栏的常驻按钮；第二处是**「上次读取的会话」提示块内、仅在 `!isRealSession` 时**' +
      '渲染的快捷入口（2026-09-18 用户被"灰着的恢复按钮"卡住后新增）。两处都在同一个卡片的不同区块、' +
      '且第二处有额外条件，属于**有意的就近入口**，不是复制粘贴残留 —— 已核实',
  ],
  [
    'pages/run.vue：去「跑道编辑」描一条',
    '三处都在**互斥的 `v-if` / `v-else-if` 分支**里（已配置 / 库里有别的任务的跑道 / 完全没描过），' +
      '同一时刻只渲染一个 —— 2026-09-18 审计 M1 补齐"库里有条目但都不属于当前任务"这条分支时核实过',
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

test('跑道编辑页：「保存（本机）」必须带"内外圈不合法则禁用"的保护', () => {
  const tpl = stripHtmlComments(templateOf(readFileSync(join(ROOT, 'pages', 'track-editor.vue'), 'utf8')))
  // 取"文案含保存（本机）的那个 v-btn 开标签"，要求它的属性里带 ringCheck 的 disabled 保护
  const btnTags = [...tpl.matchAll(/<v-btn\b[^>]*>/g)].map((m) => m[0])
  const saveTags = btnTags.filter((t) => /保存（本机）/.test(t) || /保存\(本机\)/.test(t))
  // 文案在 v-btn 的子节点里时，开标签本身不含文案 ⇒ 用"开标签 + 紧随其后的文案"整体判断
  const withLabel = [...tpl.matchAll(/<v-btn\b([^>]*)>\s*保存（本机）\s*<\/v-btn>/g)].map((m) => m[1] ?? '')
  assert.ok(withLabel.length >= 1, `找不到带文案的「保存（本机）」按钮（候选 ${saveTags.length} 个）`)
  assert.equal(withLabel.length, 1, `「保存（本机）」应只有 1 个，实际 ${withLabel.length} 个`)
  assert.match(withLabel[0]!, /:disabled="[^"]*ringCheck/, '「保存（本机）」必须按 ringCheck 禁用（否则能存进不合法的内外圈）')
})
