/**
 * check-wiring.mjs —— 接线与契约的**源码级**不变式检查（零依赖，只读）
 *
 * 为什么需要它：单测覆盖的是「算得对」，但有一类是**顺序 / 单一出口**的接线契约，
 * 纯函数测试证明不了，而项目历史上**恰恰在这类地方出过事**：
 *   - **E33**：明细点漏了 `time`、还多发真包没有的 3 个字段 → 整条明细被服务端拒收 → 云端没有轨迹；
 *   - 提交顺序：明细必须在成绩**成功之后**发；门禁必须在**任何写操作之前**（否则会建出脏场次）。
 *
 * 本脚本把这几条钉成可执行判据，交给 CI 每次跑。**通过 = 退出码 0**。
 * ⚠️ 它只做"结构性断言"，不替代单测；发现违规会**指出文件与行号**，便于直接修。
 *
 * 用法：node scripts/check-wiring.mjs [root]
 *   `root` 可选（默认 = 本脚本所在仓库根）——供自测脚本指向"被篡改的副本"验证检查器真的会报错。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const warnings = []

const read = (rel) => {
  const p = join(ROOT, rel)
  if (!existsSync(p)) {
    failures.push(`文件不存在：${rel}（检查器已失效，请更新 check-wiring.mjs）`)
    return ''
  }
  return readFileSync(p, 'utf8')
}

/** 只读：文件存在就返回 `{ rel, text }`，不存在返回 null（**不记失败**，用于"路径迁移"的探测） */
const readIfExists = (rel) => {
  const p = join(ROOT, rel)
  return existsSync(p) ? { rel, text: readFileSync(p, 'utf8') } : null
}

/**
 * 依次尝试多个候选路径，返回**第一个存在的**文件（都不存在返回 null）。
 * 为什么需要：2026-09-17 结构整理把 `useMpReal.ts` 拆成组装器 + `composables/real/{state,data,submit}.ts`，
 * 顺序 / 构造出口这类"按文件定位"的检查要能**跟着代码搬家**，同时保留旧路径兜底。
 * ⚠️ 调用方必须自己处理 null（**报失败并提示"检查器需同步更新"**），绝不允许静默通过。
 */
const readFirstExisting = (rels) => {
  for (const rel of rels) {
    const hit = readIfExists(rel)
    if (hit) return hit
  }
  return null
}

/**
 * 依次尝试多个候选路径，返回**第一个「存在且内容含 `pattern`」的文件**（都不满足返回 null）。
 * 与 `readFirstExisting` 的区别：找的是**符号所在文件**，所以还要看内容 —— 目标文件再次搬家时
 * 必须能报"检查器需同步更新"，而不是把旧文件当兜底、静默通过。
 */
const findFileContaining = (rels, pattern) => {
  for (const rel of rels) {
    const hit = readIfExists(rel)
    if (hit && pattern.test(hit.text)) return hit
  }
  return null
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** 取某个函数体（从 `marker` 到下一个顶层 `}` 之间的近似区间：用下一个 async function 或 EOF 收尾） */
function bodyOf(text, marker) {
  const start = text.indexOf(marker)
  if (start < 0) return { body: '', start: -1 }
  const rest = text.slice(start + marker.length)
  const nextTop = rest.search(/\n(?:export )?(?:async )?function |\n\/\*\* /)
  const body = nextTop < 0 ? rest : rest.slice(0, nextTop)
  return { body, start }
}

/** 去掉注释行（守卫要判"代码里有没有"，不能把讲历史的注释也算违规） */
const stripCommentLines = (text) =>
  text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join('\n')

/** 断言：patterns 在 text 中**首次出现的位置**必须严格递增 */
function assertOrder(label, text, patterns) {
  const idx = patterns.map((p) => {
    const i = text.search(p)
    return { name: String(p), i }
  })
  const missing = idx.filter((x) => x.i < 0)
  if (missing.length) {
    failures.push(`${label}：找不到 ${missing.map((m) => m.name).join(' / ')}（符号被改名？检查器需同步更新）`)
    return
  }
  for (let k = 1; k < idx.length; k++) {
    if (idx[k].i < idx[k - 1].i) {
      failures.push(
        `${label}：**顺序错误** —— 「${idx[k].name}」(第 ${lineOf(text, idx[k].i)} 行) 出现在「${idx[k - 1].name}」(第 ${lineOf(text, idx[k - 1].i)} 行) 之前`,
      )
    }
  }
}

// ---------- R1/R2：真实提交的顺序（门禁 → 建场次 → 成绩 → 明细）----------
// ⚠️ 2026-09-17 结构整理：`submitRealRun` 已从 `composables/useMpReal.ts` 搬到
//    `composables/real/submit.ts`（该文件只剩组装器，没有序列）。这里**依次尝试**新路径与旧路径；
//    两个都找不到 = 检查器失效 → **报失败**（提示"检查器需同步更新"），不许静默通过。
const REAL_SUBMIT_FILES = ['composables/real/submit.ts', 'composables/useMpReal.ts']
const realSubmit = readFirstExisting(REAL_SUBMIT_FILES)
if (!realSubmit) {
  failures.push(
    `找不到真实提交源文件（依次尝试：${REAL_SUBMIT_FILES.join(' / ')}）—— 检查器需同步更新（check-wiring.mjs）`,
  )
} else {
  // ⚠️ marker 必须带 `(`，否则会被 `submitRealRun_xxx` 这类同前缀名字骗过（自测发现的坑）
  const { body } = bodyOf(realSubmit.text, 'async function submitRealRun(')
  if (!body) failures.push(`${realSubmit.rel}：找不到 submitRealRun(（检查器已失效）`)
  else {
    assertOrder('真实提交顺序（门禁 → getRunBegin → saveScores → saveScoreDetail）', body, [
      /evaluateRunGate\(|gate\b/,
      /MpApiWrapper\.getRunBegin\(/,
      /MpApiWrapper\.saveScores\(/,
      /MpApiWrapper\.saveScoreDetail\(/,
    ])
  }
}

// ---------- R3：E33 复发守卫 —— 真包没有的 3 个字段不得再出现 ----------
const SOURCE_FILES = [
  'utils/mp/submitPayload.ts',
  'utils/mp/runData.ts',
  'composables/useMpReal.ts',
  // ⚠️ 2026-09-17 结构整理新增：真实链路的共享状态 / 只读侧 / 写侧（E33 守卫必须跟着代码搬家，
  //    否则"字段又回来了"会藏在拆分出去的新文件里）
  'composables/real/state.ts',
  'composables/real/data.ts',
  'composables/real/submit.ts',
  'composables/useMpDemo.ts',
  // ⚠️ 本次结构整理新增：演示/跑步机链路的共享状态、成绩记录、跑步引擎
  //    （E33 守卫必须跟着代码搬家，否则"字段又回来了"会藏在拆分出去的新文件里）
  'composables/demo/state.ts',
  'composables/demo/records.ts',
  'composables/demo/runner.ts',
  'src/mp/envelope.ts',
  'src/mp/types.ts',
  'src/wrappers/MpApiWrapper.ts',
]
const FORBIDDEN_FIELDS = ['gyroscope', 'accelerometer', 'cheatCode']
for (const rel of SOURCE_FILES) {
  const text = read(rel)
  if (!text) continue
  // ⚠️ 先剥掉注释行再判：允许注释里讲历史，但不允许**代码里**出现这些字段。
  //    也不能只匹配行首 —— `{ gyroscope: [] }` 这种行内字面量同样要抓到（自测发现的坑）。
  const code = stripCommentLines(text)
  for (const field of FORBIDDEN_FIELDS) {
    if (new RegExp(`\\b${field}\\s*:`, 'm').test(code)) {
      failures.push(`${rel}：代码里出现 \`${field}:\` —— **E33 复发**！真包明细只有 pointList/scantronId/token 三个字段`)
    }
  }
}

// ---------- R4：明细报文只能有一个构造出口 ----------
// ① 真正"构造"明细的两个地方必须走构造器（真实侧 = real/submit.ts，旧路径 useMpReal.ts 兜底；
//    演示预览侧 = demo/runner.ts，旧路径 useMpDemo.ts 兜底 —— 按**内容**在候选里依次找，
//    两个候选都没有 = 检查器失效 → **报失败**并提示"检查器需同步更新"，绝不静默通过）；
// ② 页面层不得内联声明明细报文类型（只允许截取预览）。
const DEMO_BUILDER_FILES = ['composables/demo/runner.ts', 'composables/useMpDemo.ts']
const demoDetailBuilder = findFileContaining(DEMO_BUILDER_FILES, /buildScoreDetailRequest\(/)
const demoScoreBuilder = findFileContaining(DEMO_BUILDER_FILES, /buildScoreRequest\(/)
if (!demoDetailBuilder) {
  failures.push(
    `演示预览的明细报文必须走 \`buildScoreDetailRequest()\` 单一构造器（否则 E33 那类"预览与实发不一致"会复发）` +
      `：依次尝试 ${DEMO_BUILDER_FILES.join(' / ')} 都没找到该构造器 —— 检查器需同步更新（check-wiring.mjs）`,
  )
}
if (!demoScoreBuilder) {
  failures.push(
    `演示预览的成绩报文必须走 \`buildScoreRequest()\`（此前是手抄 18 字段，会与实发漂移 —— E33 同类风险；2026-09-17 B 轮已统一）` +
      `：依次尝试 ${DEMO_BUILDER_FILES.join(' / ')} 都没找到该构造器 —— 检查器需同步更新（check-wiring.mjs）`,
  )
}
const DETAIL_BUILDERS = [realSubmit, demoDetailBuilder].filter(Boolean)
for (const { rel, text } of DETAIL_BUILDERS) {
  if (!/buildScoreDetailRequest\(/.test(text)) {
    failures.push(`${rel}：提交/预览明细时必须走 \`buildScoreDetailRequest()\` 单一构造器（否则 E33 那类"预览与实发不一致"会复发）`)
  }
}
const PAGE_FILES = ['pages/run.vue', 'pages/index.vue', 'pages/records.vue']
for (const rel of PAGE_FILES) {
  const text = read(rel)
  if (!text) continue
  if (/MpScoreDetailRequest[^=]*=\s*\{/.test(text)) {
    failures.push(`${rel}：页面里**内联声明**了明细报文 —— 必须交给 \`buildScoreDetailRequest()\`（页面只做展示）`)
  }
}

// ---------- R5：成绩报文也必须走单一构造器（B 轮已统一，故这里是**硬断言**）----------
// ⚠️ 本次结构整理：演示预览的成绩构造出口已搬到 `composables/demo/runner.ts`（上面已按候选顺序
//    解析成 `demoScoreBuilder`；两个候选都没有时上面已报失败 —— 这里不会静默通过）。
const realHasBuilder = realSubmit ? /buildScoreRequest\(/.test(realSubmit.text) : false
if (realSubmit && !realHasBuilder) {
  failures.push(`${realSubmit.rel}：提交成绩必须走 \`buildScoreRequest()\`（单一构造出口）`)
}
if (demoScoreBuilder && !/buildScoreRequest\(/.test(demoScoreBuilder.text)) {
  failures.push(`${demoScoreBuilder.rel}：预览成绩报文必须走 \`buildScoreRequest()\`（单一构造出口）`)
}

// ---------- R6：分层规则（D 轮 2026-09-17 建立；层次定义见 HANDOVER §3.1）----------
// 允许的依赖方向：
//   契约层 `src/mp/**`    —— 纯数据/纯函数，**零框架依赖**；**不得**依赖算法层
//   算法层 `utils/mp/**`  —— 纯函数；只能从契约层取**类型**（`import type`）
//   装配层 `composables|components|pages|layouts` —— 可依赖契约层 + 算法层
//   服务端 `server/**`    —— 只依赖契约层 + 算法层 + server 自身；**不得**拉前端装配层
// 反向（装配层不得 import server/）同样禁止。
const listDir = (rel) => {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return []
  const out = []
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, e.name)
      const childRel = `${prefix}/${e.name}`
      if (e.isDirectory()) walk(child, childRel)
      else if (/\.(ts|vue|mjs)$/.test(e.name)) out.push(childRel)
    }
  }
  walk(abs, rel)
  return out
}

const CONTRACT_FILES = listDir('src/mp')
const ALGO_FILES = listDir('utils/mp')
const SERVER_FILES = listDir('server')
const FRONT_FILES = [...listDir('composables'), ...listDir('components'), ...listDir('pages'), ...listDir('layouts')]

/** 逐条规则：返回违规说明数组 */
const layerViolations = []
const checkLayer = (rel, text) => {
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`
    const isContractOrAlgo = CONTRACT_FILES.includes(rel) || ALGO_FILES.includes(rel)
    // L1：契约层不得依赖算法层
    if (CONTRACT_FILES.includes(rel) && /from\s+['"][^'"]*utils\/mp/.test(line)) {
      layerViolations.push(`${at} 契约层(src/mp)**依赖了算法层**(utils/mp) —— 方向必须单向`)
    }
    // L2：算法层只能从契约层取类型
    if (ALGO_FILES.includes(rel) && /from\s+['"][^'"]*src\/mp/.test(line) && !/^\s*import\s+type\b/.test(line)) {
      layerViolations.push(`${at} 算法层(utils/mp)从契约层取值时必须写成 \`import type\`（只取类型，避免运行期耦合）`)
    }
    // L3：纯逻辑层零框架依赖
    if (isContractOrAlgo && /from\s+['"](vue|vue-router|#app|nuxt)['"]|useState\(|useRuntimeConfig\(/.test(line)) {
      layerViolations.push(`${at} 纯逻辑层出现了框架运行时依赖（vue/#app/useState/useRuntimeConfig）—— 它必须能离线单测`)
    }
    // L4：纯逻辑层不得拉装配层/服务端
    if (isContractOrAlgo && /from\s+['"][^'"]*(composables|pages|components|layouts|server)\//.test(line)) {
      layerViolations.push(`${at} 纯逻辑层依赖了装配层/服务端 —— 必须保持"零依赖可测"`)
    }
    // L5：服务端不得拉前端装配层
    if (SERVER_FILES.includes(rel) && /from\s+['"][^'"]*(composables|components|pages|layouts)\//.test(line)) {
      layerViolations.push(`${at} 服务端依赖了前端装配层 —— server 只应依赖 契约层/算法层/自身`)
    }
    // L6：前端不得直接拉服务端模块
    if (FRONT_FILES.includes(rel) && /from\s+['"][^'"]*server\//.test(line)) {
      layerViolations.push(`${at} 前端直接 import 了 server/ 模块 —— 应通过接口（/api/**）而非直接依赖`)
    }
  })
}
for (const rel of [...CONTRACT_FILES, ...ALGO_FILES, ...SERVER_FILES, ...FRONT_FILES]) {
  const text = read(rel)
  if (text) checkLayer(rel, text)
}
failures.push(...layerViolations)

// L7：上游路径前缀必须**单一来源**（代理不得自己再声明一份）
const PROXY_REL = 'server/api/mp/[...slug].ts'
const proxyText = read(PROXY_REL)
if (proxyText) {
  if (/const\s+KNOWN_PREFIXES\s*=/.test(proxyText)) {
    failures.push(`${PROXY_REL}：又自己声明了 KNOWN_PREFIXES —— 前缀的唯一来源是 \`src/mp/constants.ts\` 的 MP_PATH_PREFIXES（D 轮收口）`)
  }
  if (!/MP_PATH_PREFIXES/.test(proxyText)) {
    failures.push(`${PROXY_REL}：没有使用 \`MP_PATH_PREFIXES\`（检查器需同步更新，或代理改写回了本地数组）`)
  }
}
const constantsText = read('src/mp/constants.ts')
if (constantsText && !/export const MP_PATH_PREFIXES\s*=\s*\[[^\]]*MP_API_PREFIX[^\]]*MP_WXAPI_PREFIX[^\]]*\]/.test(constantsText)) {
  failures.push('src/mp/constants.ts：`MP_PATH_PREFIXES` 必须由 MP_API_PREFIX / MP_WXAPI_PREFIX 推导出来（单一来源）')
}

// ---------- R7/R8：错误处理与空值纪律（C 轮 2026-09-17；约定见 HANDOVER §3.2）----------
// R7 模板空值：**可空状态**在模板里必须 `?.` 取值，或被**祖先 `v-if` 守卫**。
//    E27 的成因正是"把 ref 默认值从有值改成 null，却没检查模板里的裸取值" —— 渲染期抛错会中断整棵树 ⇒ 整页黑屏。
//    这里用一个**栈式模板解析**（记录每个元素的 v-if 守卫）来精确判定"是否已被祖先守卫"。
// R8 catch 留痕：`catch {}` 完全空 → 违规。允许静默的**必须写明注释**（注释就是"为什么可以吞"的留痕）。

const NULLABLE_DECL_RE =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useState|ref|shallowRef|computed|useMemo)\s*<[^>]*\|\s*(?:null|undefined)[^>]*>/g
const nullableNames = new Map()
for (const rel of [...listDir('composables'), ...listDir('src')]) {
  if (!rel.endsWith('.ts')) continue
  const text = read(rel)
  for (const m of text.matchAll(NULLABLE_DECL_RE)) {
    const line = text.slice(0, m.index).split('\n').length
    if (!nullableNames.has(m[1])) nullableNames.set(m[1], `${rel}:${line}`)
  }
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr'])
const TAG_RE = /<(\/?)([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g

/** 在给定守卫集合下，找出一段模板文本里的"裸取值"（可空状态后面直接跟点） */
const bareAccesses = (text, guards) => {
  const out = []
  for (const name of nullableNames.keys()) {
    if (guards.has(name)) continue
    const re = new RegExp(`(?<![\\w$.])${name}(?!\\?)(?!\\s*&&)(?!\\s*\\|\\|)\\.`, 'g')
    for (const m of text.matchAll(re)) out.push({ name, index: m.index })
  }
  return out
}

const nullViolations = []
for (const rel of [...listDir('pages'), ...listDir('components'), ...listDir('layouts')]) {
  if (!rel.endsWith('.vue')) continue
  const text = read(rel)
  const start = text.indexOf('<template>')
  const end = text.lastIndexOf('</template>')
  if (start < 0 || end < 0) continue
  const tpl = text.slice(start, end)
  const baseLine = text.slice(0, start).split('\n').length // 行号偏移
  const stack = [] // { tag, guards:Set }
  let last = 0
  for (const m of tpl.matchAll(TAG_RE)) {
    // ① 标签之间的文本节点：只看祖先守卫
    const textNode = tpl.slice(last, m.index)
    const ancestorGuards = new Set(stack.flatMap((f) => [...f.guards]))
    for (const bad of bareAccesses(textNode, ancestorGuards)) {
      const line = baseLine + tpl.slice(0, last + bad.index).split('\n').length - 1
      nullViolations.push(`${rel}:${line} 模板里裸取可空状态 \`${bad.name}.\`（声明于 ${nullableNames.get(bad.name)}）—— 必须写成 \`${bad.name}?.\` 或被祖先 \`v-if\` 守卫`)
    }
    last = m.index + m[0].length

    const [full, closing, tag, attrs, selfClose] = m
    if (closing) {
      // 闭合：弹到匹配的那个（容错）
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break }
      }
      continue
    }
    // ② 该标签自己的属性里若裸取可空状态：它自己的 v-if 也算守卫
    const ownGuards = new Set()
    for (const g of attrs.matchAll(/v-(?:else-)?if\s*=\s*"([^"]*)"|v-(?:else-)?if\s*=\s*'([^']*)'/g)) {
      const expr = g[1] ?? g[2] ?? ''
      for (const name of nullableNames.keys()) if (new RegExp(`\\b${name}\\b`).test(expr)) ownGuards.add(name)
    }
    const allGuards = new Set([...ancestorGuards, ...ownGuards])
    for (const bad of bareAccesses(attrs, allGuards)) {
      const line = baseLine + tpl.slice(0, m.index + full.indexOf(attrs) + bad.index).split('\n').length - 1
      nullViolations.push(`${rel}:${line} 属性绑定里裸取可空状态 \`${bad.name}.\`（声明于 ${nullableNames.get(bad.name)}）—— 必须写成 \`${bad.name}?.\` 或被祖先 \`v-if\` 守卫`)
    }
    if (!selfClose && !VOID_TAGS.has(tag)) stack.push({ tag, guards: ownGuards })
  }
  // 收尾文本
  const tail = tpl.slice(last)
  const tailGuards = new Set(stack.flatMap((f) => [...f.guards]))
  for (const bad of bareAccesses(tail, tailGuards)) {
    const line = baseLine + tpl.slice(0, last + bad.index).split('\n').length - 1
    nullViolations.push(`${rel}:${line} 模板里裸取可空状态 \`${bad.name}.\`（声明于 ${nullableNames.get(bad.name)}）`)
  }
}
failures.push(...nullViolations)

/** 允许"完全空 catch"的文件（每条必须写原因） */
const ALLOW_EMPTY_CATCH = new Map([
  ['tests/mp/logger.test.ts', '测试收尾清理，失败不影响结论（文件内已注明）'],
])
for (const rel of [...listDir('composables'), ...listDir('src'), ...listDir('server'), ...listDir('utils')]) {
  if (!rel.endsWith('.ts')) continue
  if (ALLOW_EMPTY_CATCH.has(rel)) continue
  const text = read(rel)
  for (const m of text.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) {
    const line = text.slice(0, m.index).split('\n').length
    failures.push(`${rel}:${line} 出现了**完全空的 catch** —— 请求/业务路径必须留痕（写日志或状态）；确实"尽力而为"的副作用必须在括号里写明注释说明为什么可以吞`)
  }
}

// ---------- R10：全局提示必须走 `useNotice()` 单一契约（2026-09-18，1.1.9）----------
// 起因：提示函数的签名原先在 7 个页面/组件里**各自内联声明**（`inject<(msg, color?) => void>(...)`），
// 新增一个可选参数就要改 7 处、漏一处就是 `Expected 1-2 arguments, but got 3`（1.1.9 真踩到）。
// 判据：装配层不得再出现 `inject('showSnackbar'`（字符串键已废弃，改由 `NOTICE_KEY` 提供）；
//       并且 `app.vue` 必须真的 provide 那个键（否则调用方拿到的永远是兜底空实现 ⇒ 点了没反应、还没报错）。
{
  // 注意：`listDir` 给出的相对路径以 `/` 开头（如 `/pages/index.vue`），且不含根目录的 `app.vue`
  const frontFiles = [...listDir('pages'), ...listDir('components'), ...listDir('layouts')]
  for (const rel of frontFiles) {
    const text = read(rel)
    // ⚠️ 别写 `inject\s*<[^>]*>` —— 泛型里含 `=>`（`<(...) => void>`），`[^>]*` 会在 `=` 后就停下匹配不上
    //    （R10 自测第一次就是被这个正则坑了：注入了违规却"通过"）。这里用码点区间 + 关键字双重判据。
    if (/inject\s*(?:<[\s\S]{0,200}?>)?\s*\(\s*['"]showSnackbar['"]/.test(text)) {
      failures.push(`${rel}：仍在用废弃的字符串注入键 \`inject('showSnackbar')\` —— 请改用 \`useNotice()\`（composables/useNotice.ts）`)
    }
  }
  const appText = read('app.vue')
  if (appText && !/provide\(\s*NOTICE_KEY/.test(appText)) {
    failures.push("app.vue：没有用 `provide(NOTICE_KEY, ...)` 提供全局提示（调用方必须走 useNotice()，键的唯一来源是 composables/useNotice.ts）")
  }
  const noticeContract = read('composables/useNotice.ts')
  if (noticeContract && !/export const NOTICE_KEY/.test(noticeContract)) {
    failures.push('composables/useNotice.ts：缺少 `export const NOTICE_KEY`（检查器需同步更新）')
  }
}

// ---------- R9：夜间停用的**适用面**（2026-09-17 用户澄清口径）----------
// 夜间 22:30~06:00 **只停「真实提交」**；本地模拟/预览必须照旧可用。
// 曾经的错法：把 `gateStatus.blockedBy === 'night'` 也挂在「开始跑步」按钮的 disabled 上 ⇒ 夜里连模拟都点不了。
{
  const runPageText = read('pages/run.vue') ?? ''
  const startBtn = runPageText.match(/:disabled="([^"]*)"[\s\S]{0,160}?开始跑步/)
  if (!startBtn) {
    failures.push('pages/run.vue：找不到「开始跑步」按钮的 disabled 绑定（检查器需同步更新）')
  } else if (/night/.test(startBtn[1])) {
    failures.push('「开始跑步」按钮被夜间时段拦住了 —— 夜间**只停真实提交**，本地模拟必须可用（用户 2026-09-17 澄清）')
  }
  const submitBtn = runPageText.match(/:disabled="([^"]*gateStatus[^"]*)"/)
  if (!submitBtn) {
    failures.push('pages/run.vue：「真实提交」按钮的 disabled 里必须仍含门禁（gateStatus.*）—— 夜间/风控都要拦得住')
  }
}

// ---------- 报告 ----------
console.log('=== check-wiring：接线与契约检查（源码级）===\n')
console.log(
  `📄 已检查：${SOURCE_FILES.length} 个源文件 + ${DETAIL_BUILDERS.length} 个明细构造点 + ${PAGE_FILES.length} 个页面` +
    ` + 分层规则（契约 ${CONTRACT_FILES.length} / 算法 ${ALGO_FILES.length} / 服务端 ${SERVER_FILES.length} / 装配 ${FRONT_FILES.length} 个文件）` +
    ` + 空值纪律（可空状态 ${nullableNames.size} 个）`,
)
if (warnings.length) {
  console.log(`\n⚠️  警告 ${warnings.length} 条（不阻断 CI）：`)
  for (const w of warnings) console.log('   - ' + w)
}
if (failures.length) {
  console.log(`\n❌ 失败 ${failures.length} 条：`)
  for (const f of failures) console.log('   - ' + f)
  process.exit(1)
}
console.log('\n✅ 接线契约全部满足：门禁在写操作前、顺序正确、无 E33 复发字段、**成绩与明细都只有单一构造出口**。')
