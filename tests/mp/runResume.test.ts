/**
 * 「跨进程续跑」纯逻辑单测（2026-10-08 用户要求）
 *
 * 这里钉三件事（都是"不改代码就会静默出事"的那类）：
 *   ① 🔒 **落盘边界**：token / 轨迹点 / 学号**绝不允许**进落盘文件（用户 2026-10-08 拍板）；
 *   ② **恢复得太晚不许硬发**：用任务自己的时长区间判，判不出来时用本地宽限（不是厂商要求）；
 *   ③ **坏数据一律安全降级**（磁盘上的文件可能被手改/是旧版本），绝不抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FORBIDDEN_PERSIST_KEYS,
  PENDING_SUBMIT_RESUME_KEY,
  PERSISTED_SUBMIT_MAX_AGE_MS,
  PERSISTED_SUBMIT_VERSION,
  RESUME_GRACE_SECONDS,
  assertNoSensitiveKeys,
  checkResumeLinePoints,
  decideResume,
  isPersistedJobExpired,
  linePointCountOf,
  normalizeLinePoints,
  parsePendingResume,
  parsePersistedSubmitJob,
  resumeSummaryText,
  serializePendingResume,
  stripForbiddenKeysDeep,
  stripVerdictIdentity,
  toPersistedSubmitJob,
  withLinePoints,
  withVerdictIdentity,
  type PersistedSubmitJob,
} from '../../utils/mp/runResume.ts'

const T0 = Date.UTC(2026, 9, 8, 2, 0, 0) // 任意基准时刻

/** 一份"输入"（形状与作业输入一致：**含** token / snCode / points，看落盘会不会把它们带出去） */
const inputFixture = (over: Record<string, unknown> = {}) => ({
  id: 'run-abc',
  startedAt: T0,
  plannedSeconds: 1168,
  scantronId: 'sunrunId202610081234',
  baseUrl: 'https://wxxcx.xtotoro.com',
  context: {
    schoolCode: 'NUAA',
    task: { taskId: 'sunrunTaskPaper-1', minTime: 10, maxTime: 25 },
    line: { lineId: 'sunrunLine-1', pointName: '东操场' },
    paperId: 'sunrunTaskPaper-1',
    km: 3.3,
    durationSeconds: 1168,
    fitDegree: 0.98,
    runType: 0 as const,
  },
  verdictRequest: {
    projectName: '阳光跑',
    monthId: '202610',
    termId: 'term-1',
    paperId: '',
    stuNumber: '161900101',
    snCode: '161900101',
    pageNumber: 1,
    rowNumber: 1000,
  },
  meta: { km: 3.3, lineName: '东操场', runTypeLabel: '阳光跑' },
  ...over,
})

// ---------- ① 落盘边界（本模块最重要的一条） ----------
test('落盘：token / 轨迹点 / 学号**一律不进**落盘文件', () => {
  const job = toPersistedSubmitJob({
    ...inputFixture(),
    // 故意把敏感项混进上下文（模拟"将来有人图省事整个 input 传进来"）
    context: {
      ...inputFixture().context,
      token: 'gho_SECRETTOKEN0123456789',
      snCode: '161900101',
      points: [
        { latitude: 31.9, longitude: 118.78 },
        { latitude: 31.9001, longitude: 118.7801 },
      ],
    } as never,
    token: 'gho_SECRETTOKEN0123456789',
    snCode: '161900101',
  } as never)

  const text = JSON.stringify(job)
  for (const bad of ['gho_SECRETTOKEN0123456789', '161900101', 'latitude']) {
    assert.equal(text.includes(bad), false, `落盘文件里不该出现「${bad}」`)
  }
  // 结构上也不该有这些键
  for (const key of ['token', 'snCode', 'points']) {
    assert.equal(text.includes(`"${key}"`), false, `落盘文件里不该出现键「${key}」`)
  }
  // ✅ 该留的还在
  assert.equal(job.scantronId, 'sunrunId202610081234')
  assert.equal(job.context.km, 3.3)
  assert.equal(job.context.schoolCode, 'NUAA')
  assert.equal(job.plannedSeconds, 1168)
  assert.equal(job.version, PERSISTED_SUBMIT_VERSION)
})

test('落盘：判定入参去掉学号，但保留月份/学期/分页', () => {
  const job = toPersistedSubmitJob(inputFixture() as never)
  assert.deepEqual(job.verdictRequest, {
    projectName: '阳光跑',
    monthId: '202610',
    termId: 'term-1',
    paperId: '',
    pageNumber: 1,
    rowNumber: 1000,
  })
  assert.equal('snCode' in job.verdictRequest, false)
  assert.equal('stuNumber' in job.verdictRequest, false)
})

test('落盘：恢复时能把学号补回判定入参（口径与 buildVerdictRequest 一致）', () => {
  const back = withVerdictIdentity({ monthId: '202610' }, '161900101')
  assert.equal(back.snCode, '161900101')
  assert.equal(back.stuNumber, '161900101')
  assert.equal(back.monthId, '202610')
})

test('抛错闸：嵌套里出现敏感键必须被拦下（含大小写/下划线变体）', () => {
  for (const key of ['token', 'snCode', 'SN_CODE', 'stuNumber', 'points', 'pointList']) {
    assert.throws(
      () => assertNoSensitiveKeys({ a: { b: { [key]: 'x' } } }),
      /不允许出现敏感键/,
      `键「${key}」应当被拦下`,
    )
  }
  // 反向：正常对象不许误报
  assert.doesNotThrow(() => assertNoSensitiveKeys({ a: { km: 3.3, monthId: '202610', schoolCode: 'NUAA' } }))
})

test('落盘：敏感键清单本身覆盖 token / 学号 / 轨迹点三类', () => {
  const keys = FORBIDDEN_PERSIST_KEYS.map((k) => k.toLowerCase())
  for (const must of ['token', 'sncode', 'stunumber', 'points', 'pointlist']) {
    assert.equal(keys.includes(must), true, `清单里应当有「${must}」`)
  }
})

// ---------- ② 解析：坏数据一律 null ----------
test('解析：坏数据 / 缺字段 / 版本不符一律 null（绝不抛）', () => {
  const good = JSON.stringify(toPersistedSubmitJob(inputFixture() as never))
  assert.ok(parsePersistedSubmitJob(good))

  const bads: unknown[] = [
    null,
    undefined,
    123,
    '',
    'not json',
    '[]',
    JSON.stringify({ ...JSON.parse(good), version: 999 }),
    JSON.stringify({ ...JSON.parse(good), id: '' }),
    JSON.stringify({ ...JSON.parse(good), scantronId: '' }),
    JSON.stringify({ ...JSON.parse(good), startedAt: 0 }),
    JSON.stringify({ ...JSON.parse(good), plannedSeconds: 0 }),
    JSON.stringify({ ...JSON.parse(good), context: { ...JSON.parse(good).context, km: 0 } }),
    JSON.stringify({ ...JSON.parse(good), context: undefined }),
  ]
  for (const bad of bads) {
    assert.equal(parsePersistedSubmitJob(bad), null, `${String(bad).slice(0, 60)} 应当解析成 null`)
  }
})

test('解析：磁盘文件被手改出学号 ⇒ 也解析成 null（第二道闸在读取侧也生效）', () => {
  const o = JSON.parse(JSON.stringify(toPersistedSubmitJob(inputFixture() as never)))
  o.verdictRequest.snCode = '161900101'
  assert.equal(parsePersistedSubmitJob(JSON.stringify(o)), null)
})

test('过期判据：超过 24 小时即过期（免得永远挡住新的提交）', () => {
  const job = toPersistedSubmitJob(inputFixture() as never)
  assert.equal(isPersistedJobExpired(job, T0 + 60_000), false)
  assert.equal(isPersistedJobExpired(job, T0 + PERSISTED_SUBMIT_MAX_AGE_MS), false)
  assert.equal(isPersistedJobExpired(job, T0 + PERSISTED_SUBMIT_MAX_AGE_MS + 1), true)
})

// ---------- ③ 恢复判据 ----------
const task = { minTime: 10, maxTime: 25 } // 分钟（实测口径）

test('恢复：还没到原定提交时刻 ⇒ 接着等（等够剩余时间）', () => {
  const d = decideResume({ startedAt: T0, plannedSeconds: 1168, now: T0 + 300_000, task })
  assert.equal(d.action, 'wait')
  assert.equal(d.waitMs, 1168_000 - 300_000)
  assert.match(d.reason, /还没到原定提交时刻/)
})

test('恢复：已过原定时刻但仍在任务时长区间内 ⇒ 立即提交（时长按真实间隔算）', () => {
  // 计划 1168 秒 ≈ 19.5 分；在 22 分时重启 ⇒ 落在 10~25 分钟内 ⇒ 提交
  const d = decideResume({ startedAt: T0, plannedSeconds: 1168, now: T0 + 22 * 60_000, task })
  assert.equal(d.action, 'submit')
  assert.equal(d.waitMs, 0)
  assert.equal(d.elapsedSeconds, 22 * 60)
  assert.match(d.reason, /仍落在任务允许的时长区间内/)
})

test('恢复：超出任务时长区间 ⇒ 丢弃，不许硬发', () => {
  // 26 分钟 > maxTime 25 分钟
  const d = decideResume({ startedAt: T0, plannedSeconds: 1168, now: T0 + 26 * 60_000, task })
  assert.equal(d.action, 'discard')
  assert.match(d.reason, /已超出任务允许的时长区间/)
  assert.match(d.reason, /不提交/)
})

test('恢复：还没到任务最短时长（提前太久）也算超窗 ⇒ 丢弃', () => {
  // 计划只有 100 秒，但任务要求至少 10 分钟（600 秒）⇒ 不该发一条 100 秒的记录
  const d = decideResume({ startedAt: T0, plannedSeconds: 100, now: T0 + 200_000, task })
  assert.equal(d.action, 'discard')
  assert.equal(d.elapsedSeconds, 200)
})

test('恢复：minTime/maxTime 是字符串也能读懂（单位推断复用 taskRules）', () => {
  const d = decideResume({
    startedAt: T0,
    plannedSeconds: 1168,
    now: T0 + 20 * 60_000,
    task: { minTime: '10', maxTime: '25' },
  })
  assert.equal(d.action, 'submit')
})

test('恢复：min/max 写反了也按区间处理（不因字段顺序判错）', () => {
  const d = decideResume({ startedAt: T0, plannedSeconds: 1168, now: T0 + 20 * 60_000, task: { minTime: 25, maxTime: 10 } })
  assert.equal(d.action, 'submit')
})

test('恢复：任务**没下发**行程区间 ⇒ 用本地宽限，且绝不假装是任务要求', () => {
  const noWindow = { taskId: 'sunrunTaskPaper-1' }
  // 计划 1168 + 宽限 300 = 1468 秒
  const ok = decideResume({ startedAt: T0, plannedSeconds: 1168, now: T0 + (1168 + RESUME_GRACE_SECONDS) * 1000, task: noWindow })
  assert.equal(ok.action, 'submit')
  assert.match(ok.reason, /任务未下发行程区间/)
  assert.match(ok.reason, /本地宽限/)

  const late = decideResume({
    startedAt: T0,
    plannedSeconds: 1168,
    now: T0 + (1168 + RESUME_GRACE_SECONDS + 1) * 1000,
    task: noWindow,
  })
  assert.equal(late.action, 'discard')
  assert.match(late.reason, /已超本地宽限/)
})

test('恢复：任务体缺失 / 畸形也不抛（按"没下发区间"处理）', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.doesNotThrow(() => decideResume({ startedAt: T0, plannedSeconds: 1168, now: T0 + 1200_000, task: bad }))
  }
})

// ---------- ④ 界面文案 ----------
test('摘要文案：带场次号与里程，且不含 markdown 标记', () => {
  const job = toPersistedSubmitJob(inputFixture() as never) as PersistedSubmitJob
  const text = resumeSummaryText(job, T0 + 60_000)
  assert.match(text, /sunrunId202610081234/)
  assert.match(text, /3\.30 km/)
  assert.match(text, /继续这笔提交/)
  assert.match(text, /不自动重试/)
  assert.equal(text.includes('**'), false, '用户可见文案不许有 markdown 星号')
  assert.equal(text.includes('##'), false)
  assert.equal(text.includes('`'), false)
})

// ---------- ⑤ 浏览器侧续跑载荷（恢复时要补交的那几样） ----------
test('浏览器载荷：往返一致；坏数据一律 null', () => {
  const payload = {
    jobId: 'run-abc',
    scantronId: 'sunrunId202610081234',
    startedAt: T0,
    snCode: '161900101',
    points: [
      { latitude: 31.9, longitude: 118.78 },
      { latitude: 31.9001, longitude: 118.7801 },
    ],
    /** 🆕 E76：官方线路点列（**厂商原样是字符串坐标**，往返必须逐字保留） */
    linePointList: [
      { longitude: '119.480801', latitude: '31.373201', time: null },
      { longitude: '119.480747', latitude: '31.373476', time: null },
    ],
    at: T0 + 1000,
  }
  const back = parsePendingResume(serializePendingResume(payload))
  assert.deepEqual(back, payload)

  for (const bad of [
    null,
    '',
    'nope',
    '{}',
    JSON.stringify({ ...payload, jobId: '' }),
    JSON.stringify({ ...payload, points: [] }),
    JSON.stringify({ ...payload, points: [{ latitude: 'x', longitude: 1 }] }),
    JSON.stringify({ ...payload, linePointList: 'nope' }),
    JSON.stringify({ ...payload, linePointList: [{ latitude: 'x', longitude: 1 }] }),
  ]) {
    assert.equal(parsePendingResume(bad), null, `${String(bad).slice(0, 50)} 应当解析成 null`)
  }
})

test('浏览器载荷：**不含 token**（token 现从会话取，少一份副本）', () => {
  const payload = {
    jobId: 'run-abc',
    scantronId: 'sunrunId202610081234',
    startedAt: T0,
    snCode: '161900101',
    points: [{ latitude: 31.9, longitude: 118.78 }],
    linePointList: [],
    at: T0,
    token: 'gho_SHOULD_NOT_BE_STORED',
  }
  const text = serializePendingResume(payload as never)
  assert.equal(text.includes('gho_SHOULD_NOT_BE_STORED'), false)
  assert.equal('token' in (parsePendingResume(text) as object), false)
})

test('浏览器载荷：存储键固定（改名会让老用户的未完成作业找不回来）', () => {
  assert.equal(PENDING_SUBMIT_RESUME_KEY, 'mp_pending_submit_v1')
})

// ---------- ⑥ 🔴 E76（2026-10-10 真实提交实测事故）的回归 ----------
/**
 * 一份**厂商原样**的任务对象（字段名/取值都照实拍报文，
 * 见 `%TEMP%\totoro-heaven-runtime\captures\c00024-getSunrunPaper-200.json`）。
 *
 * 关键：它带一个**字面键 `token`**（值恒为字符串 `"null"`），线路里带 `pointList`。
 * 修前 `toPersistedSubmitJob()` 会拿 `assertNoSensitiveKeys()` 去断言这两个合法对象 ⇒ 抛错；
 * 而它在服务端夹在"作业已登记"与"runJob 启动"之间 ⇒ **HTTP 500 + 僵尸作业**（E76）。
 */
const vendorTaskFixture = () => ({
  status: '00',
  code: '0',
  token: 'null',
  id: 'sunrunTaskPaper-20210918000004',
  paperId: 'sunrunTaskPaper-20210918000004',
  paperName: '天目湖阳光跑',
  mileage: '3.20',
  fitDegree: '0.60',
  minSpeed: '3',
  maxSpeed: '15',
  minTime: '10',
  maxTime: '25',
  offsetRange: '300',
  startTime: '06:00',
  endTime: '23:00',
  faceFlag: '0',
  ifHasRun: '0',
  detailId: null,
  runPointList: [
    {
      taskId: 'sunrunTaskPaper-20210918000004',
      pointId: 'sunrunLine-20210918000001',
      pointName: '天目湖-西操场',
      longitude: '119.4801785',
      latitude: '31.3737802',
      pointList: [
        { longitude: '119.480801', latitude: '31.373201', time: null },
        { longitude: '119.480747', latitude: '31.373476', time: null },
      ],
      signLongitude: null,
      signLatitude: null,
      signQrcode: null,
    },
  ],
})

const jobWithVendorTask = () => {
  const task = vendorTaskFixture()
  const line = task.runPointList[0]
  return toPersistedSubmitJob({
    ...(inputFixture() as Record<string, unknown>),
    context: { ...inputFixture().context, task, line },
  } as never)
}

test('🔴 E76 回归：厂商原样任务（token:"null"）与线路（pointList）**不得**让落盘抛错', () => {
  let job: PersistedSubmitJob | undefined
  assert.doesNotThrow(() => {
    job = jobWithVendorTask()
  }, '厂商原样数据是合法输入 —— 落盘只能"剔除越界键"，不许抛错')

  const text = JSON.stringify(job)
  /** ① 越界的东西一个都不许进磁盘 */
  assert.equal(text.includes('"token"'), false, '厂商任务里的 token 键不许落盘')
  assert.equal(text.includes('"pointList"'), false, '官方线路点列不许落盘')
  assert.equal(text.includes('119.480801'), false, '线路点坐标不许落盘')
  /** ② 该留的一个都不能少（判分与续跑都要用） */
  const keptLine = job!.context.line as Record<string, unknown>
  assert.equal(keptLine.pointId, 'sunrunLine-20210918000001')
  assert.equal(keptLine.pointName, '天目湖-西操场')
  assert.equal(keptLine.taskId, 'sunrunTaskPaper-20210918000004')
  const keptTask = job!.context.task as Record<string, unknown>
  assert.equal(keptTask.minTime, '10')
  assert.equal(keptTask.maxTime, '25')
  assert.equal(keptTask.paperName, '天目湖阳光跑')
  /** ③ 点列只留**个数**（续跑靠它核验"补交回来的就是那一份"） */
  assert.equal(job!.context.linePointCount, 2)
  assert.equal(linePointCountOf(job!.context.line), 0, '剔除之后线路里已经没有 pointList 了')
  /** ④ 落盘文本 ↔ 读回一致 */
  const back = parsePersistedSubmitJob(JSON.stringify(job))
  assert.ok(back)
  assert.equal(back!.context.linePointCount, 2)
  assert.equal(back!.scantronId, 'sunrunId202610081234')
})

test('落盘：越界键按**深度**剔除（含数组里的对象），且绝不改入参', () => {
  const src = {
    a: { token: 'x', keep: 1, nested: { points: [1, 2], ok: 'y' } },
    list: [{ snCode: 'z', name: 'n' }],
    arr: [1, 'two', null],
  }
  const out = stripForbiddenKeysDeep(src) as Record<string, unknown>
  assert.deepEqual(out, { a: { keep: 1, nested: { ok: 'y' } }, list: [{ name: 'n' }], arr: [1, 'two', null] })
  /** 剔除是"深拷贝"，入参不动 —— 报文用的是内存里的原件，绝不能被改花 */
  assert.equal((src.a as Record<string, unknown>).token, 'x')
  assert.deepEqual(((src.a as { nested: { points: number[] } }).nested).points, [1, 2])
  /** 剔除之后，第二道闸必过（它现在只可能抓到"将来有人漏剔"） */
  assert.doesNotThrow(() => assertNoSensitiveKeys(out))
})

test('续跑核验：官方线路点列**点数对得上**才放行', () => {
  const job = jobWithVendorTask()
  const supplied = vendorTaskFixture().runPointList[0]!.pointList
  assert.equal(checkResumeLinePoints(job, supplied), '', '点数一致 ⇒ 放行')

  assert.match(checkResumeLinePoints(job, [supplied[0]]), /对不上/, '少一个点 ⇒ 拒绝')
  assert.match(checkResumeLinePoints(job, [...supplied, supplied[0]]), /对不上/, '多一个点 ⇒ 拒绝')
  assert.match(checkResumeLinePoints(job, 'nope'), /已不可用/, '点列不可用 ⇒ 拒绝')
  assert.match(checkResumeLinePoints({ ...job, context: { ...job.context, linePointCount: -1 } } as never, supplied), /旧版落盘作业/)
})

test('续跑核验：服务端**未下发线路**（0 点）的任务，两边都空 ⇒ 照旧放行', () => {
  const noLineJob = toPersistedSubmitJob(inputFixture() as never) // 夹具的 line 没有 pointList
  assert.equal(noLineJob.context.linePointCount, 0)
  assert.equal(checkResumeLinePoints(noLineJob, []), '')
  assert.equal(checkResumeLinePoints(noLineJob, undefined), '')
})

test('续跑核验的拒绝文案是**用户可见**的 ⇒ 不许含 markdown 标记', () => {
  const job = jobWithVendorTask()
  const msgs = [
    checkResumeLinePoints(job, []),
    checkResumeLinePoints(job, 'nope'),
    checkResumeLinePoints({ ...job, context: { ...job.context, linePointCount: -1 } } as never, []),
  ]
  for (const m of msgs) {
    assert.ok(m.length > 0)
    for (const mark of ['**', '##', '`']) assert.equal(m.includes(mark), false, `拒绝文案不许含「${mark}」`)
  }
})

test('官方线路点列：装回时**逐字保留**（厂商字符串坐标不许被改成数字）', () => {
  const job = jobWithVendorTask()
  const supplied = vendorTaskFixture().runPointList[0]!.pointList
  const line = withLinePoints(job.context.line, supplied) as Record<string, unknown>
  assert.deepEqual(line.pointList, supplied)
  assert.equal(typeof (line.pointList as Record<string, unknown>[])[0]!.latitude, 'string', '字符串坐标必须原样留着')
  assert.equal(line.pointId, 'sunrunLine-20210918000001', '其余字段一个都不能丢')
  /** 未下发线路的任务（`line` 为空）⇒ 原样返回，不凭空造一个 pointList */
  assert.equal(withLinePoints(null, []), null)
  assert.equal(withLinePoints(undefined, []), undefined)
})

test('normalizeLinePoints：允许空数组（未下发线路），但坏点列一律拒绝', () => {
  assert.deepEqual(normalizeLinePoints([]), [])
  assert.equal(normalizeLinePoints(null), null)
  assert.equal(normalizeLinePoints('x'), null)
  assert.equal(normalizeLinePoints([{ latitude: 1 }]), null, '缺点位坐标 ⇒ 拒绝')
  assert.equal(normalizeLinePoints([{ latitude: '', longitude: 1 }]), null, '空串坐标 ⇒ 拒绝')
  assert.equal(normalizeLinePoints([{ latitude: '31.9', longitude: '118.78', time: null }])?.length, 1)
})
