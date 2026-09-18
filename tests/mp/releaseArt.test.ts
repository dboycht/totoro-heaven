/**
 * 版本信息（`src/mp/releaseArt.ts`）的**用户可见文本**契约（2026-09-18 新增，1.1.9）
 *
 * 为什么要有：这些字符串会**原样**显示在「版本信息」页（Vue 插值不渲染 markdown），
 * 而 1.1.9 就真的踩过一次 —— 我在写 1.1.9 更新日志时手写了 `**重点**` 与反引号，
 * 上线后用户看到的会是**字面的星号与反引号**（同 `ERROR.md` **E44**）。
 * 判据（可执行）：`VERSION_ENTRIES` 的 title / highlights / note 里**不得出现** markdown 标记。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VERSION_ENTRIES, VERSION_ADVICE, channelText, versionArtPath } from '../../src/mp/releaseArt.ts'

type Entry = (typeof VERSION_ENTRIES)[number]
const allUserFacing = (e: Entry): string[] => [e.version, e.date, e.title, ...e.highlights, ...(e.note ? [e.note] : [])]

test('releaseArt：用户可见文本里**不得出现 markdown 标记**（星号成对 / 反引号 / 井号标题）', () => {
  for (const e of VERSION_ENTRIES) {
    for (const s of allUserFacing(e)) {
      assert.ok(!s.includes('**'), `v${e.version} 出现 markdown 粗体标记 **：${s}`)
      assert.ok(!s.includes('`'), `v${e.version} 出现反引号：${s}`)
      assert.ok(!/^\s*#{1,6}\s/.test(s), `v${e.version} 出现 markdown 标题标记：${s}`)
    }
  }
})

test('releaseArt：条目结构自洽（版本唯一、日期格式、渠道合法、要点非空）', () => {
  const seen = new Set<string>()
  for (const e of VERSION_ENTRIES) {
    assert.ok(!seen.has(e.version), `版本重复：${e.version}`)
    seen.add(e.version)
    assert.match(e.version, /^\d+\.\d+\.\d+$/, `版本号格式：${e.version}`)
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `日期格式：${e.version} -> ${e.date}`)
    assert.ok(e.channel === 'preview' || e.channel === 'stable', `渠道非法：${e.version} -> ${e.channel}`)
    assert.ok(e.title.trim().length > 0, `标题为空：${e.version}`)
    assert.ok(e.highlights.length > 0, `更新要点为空：${e.version}`)
    for (const h of e.highlights) assert.ok(h.trim().length > 0, `更新要点有空白项：${e.version}`)
  }
})

test('releaseArt：**最新版本排在最前**且未发布项一律标 planned（展示顺序依赖数组顺序）', () => {
  const nums = VERSION_ENTRIES.filter((e) => !e.planned).map((e) => e.version.split('.').map(Number))
  for (let i = 1; i < nums.length; i++) {
    const a = nums[i - 1]!
    const b = nums[i]!
    const newer = a[0]! * 10000 + a[1]! * 100 + a[2]! > b[0]! * 10000 + b[1]! * 100 + b[2]!
    assert.ok(newer, `数组顺序不是"新在前"：${a.join('.')} 在 ${b.join('.')} 之前`)
  }
})

test('releaseArt：1.1.9 条目存在且自称"当前版本"时不再回退（1.1.9 上线当天就是回退了才被发现）', () => {
  const e = VERSION_ENTRIES.find((x) => x.version === '1.1.9')
  assert.ok(e, '缺少 1.1.9 条目 —— 页面会回退显示 1.1.8')
  assert.equal(e!.planned, undefined, '1.1.9 不该标 planned')
  assert.equal(e!.channel, 'preview')
  assert.equal(e!.date, '2026-09-18')
})

test('releaseArt：贺图路径与渠道文案是"单一来源"，改口径只改这一处', () => {
  assert.equal(versionArtPath('1.1.9'), '/version-art/1.1.9')
  assert.equal(channelText('preview'), '预览测试版')
  assert.equal(channelText('stable'), '建议使用（正式版）')
  assert.match(VERSION_ADVICE.recommended, /^\d+\.\d+\.\*$/)
})
