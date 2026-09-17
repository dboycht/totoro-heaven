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
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKER = join(ROOT, 'scripts', 'check-wiring.mjs')

/** 检查器会读到的路径（与 check-wiring.mjs 保持一致） */
const NEEDED = [
  'composables/useMpReal.ts',
  'composables/useMpDemo.ts',
  'pages/run.vue',
  'pages/index.vue',
  'pages/records.vue',
  'utils/mp/submitPayload.ts',
  'utils/mp/runData.ts',
  'src/mp/envelope.ts',
  'src/mp/types.ts',
  'src/wrappers/MpApiWrapper.ts',
]

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
    const file = join(dir, 'composables/useMpReal.ts')
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

  // ---------- 注入 3：明细不走单一构造器 ----------
  {
    const dir = copyBase()
    const file = join(dir, 'composables/useMpDemo.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/buildScoreDetailRequest\(/g, 'inlineDetailBuilder('), 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push('明细不再走构造器但检查器仍然通过（单一出口守卫失效）')
    else if (!out.includes('buildScoreDetailRequest')) failures.push(`报错信息不是预期的：\n${out}`)
  }

  // ---------- 注入 4：成绩报文退回"手抄"（B 轮统一的反向守卫）----------
  {
    const dir = copyBase()
    const file = join(dir, 'composables/useMpDemo.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/buildScoreRequest\(/g, 'handWrittenScore('), 'utf8')
    const { code, out } = run(dir)
    if (code === 0) failures.push('成绩报文不再走构造器但检查器仍然通过（单一出口守卫失效）')
    else if (!out.includes('buildScoreRequest')) failures.push(`报错信息不是预期的：\n${out}`)
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('=== check-wiring 自测（注入违规定验证）===\n')
if (failures.length) {
  console.log(`❌ 自测失败 ${failures.length} 条：`)
  for (const f of failures) console.log('   - ' + f)
  process.exit(1)
}
console.log('✅ 自测通过：基线通过、4 类注入（E33 复发 / 顺序错乱 / 绕过明细构造器 / 绕过成绩构造器）都被抓到且退出码非 0。')
