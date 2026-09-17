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
import { readFileSync, existsSync } from 'node:fs'
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
// ① 真正"构造"明细的两个地方必须走构造器（真实侧 = real/submit.ts，旧路径 useMpReal.ts 兜底）；
// ② 页面层不得内联声明明细报文类型（只允许截取预览）。
const DETAIL_BUILDERS = [realSubmit, readIfExists('composables/useMpDemo.ts')].filter(Boolean)
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
const demoPath = read('composables/useMpDemo.ts')
const realHasBuilder = realSubmit ? /buildScoreRequest\(/.test(realSubmit.text) : false
const demoHasBuilder = /buildScoreRequest\(/.test(demoPath)
if (realSubmit && !realHasBuilder) {
  failures.push(`${realSubmit.rel}：提交成绩必须走 \`buildScoreRequest()\`（单一构造出口）`)
}
if (!demoHasBuilder) {
  failures.push('composables/useMpDemo.ts：预览成绩报文必须走 `buildScoreRequest()`' +
    '（此前是手抄 18 字段，会与实发漂移 —— E33 同类风险；2026-09-17 B 轮已统一）')
}

// ---------- 报告 ----------
console.log('=== check-wiring：接线与契约检查（源码级）===\n')
console.log(`📄 已检查：${SOURCE_FILES.length} 个源文件 + ${DETAIL_BUILDERS.length} 个明细构造点 + ${PAGE_FILES.length} 个页面`)
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
