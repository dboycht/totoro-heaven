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
 * 📌 路径说明：本文件在测试运行器里会被拷到 `<项目>/.mp-test-build/tests/mp/`，所以
 *    "上三级" = 项目根（**开发副本**）。因此这里必须用**开发副本**的 .vue 源码（canonical 里没有 docs 也不算源码差异）。
 */
const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')

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
