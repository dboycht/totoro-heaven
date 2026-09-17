/**
 * 请求层 `MpApiWrapper` 关键路径单测（2026-09-17 补 —— 健壮化 A「安全网」）
 *
 * 为什么需要它：这是**所有真实请求的唯一出口**，承载三件最容易写错的事：
 *   ① 鉴权头**必须始终发**（无 token 时 `Bearer null`，否则被鉴权过滤器 401 拦下 —— `ERROR.md` E16）；
 *   ② 多租户基址走 `x-mp-upstream` 头（写错就变成"任意主机转发"—— E28 的 SSRF 面）；
 *   ③ 判定与解包必须走 `envelope.ts` + `MP_ENDPOINTS[key].payload`（禁止全局兜底）。
 * 在本文件出现之前，这三件事**一条单测都没有**（只有浏览器脚本间接覆盖）。
 *
 * 手法：用**假 client** 替换 ky 实例（只实现 `.get` / `.post`），从而在**不联网**的前提下
 * 跑真实 `rawRequest()` → `judgeMpResponse()` → `unwrapMpResponse()` 全链路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MP_RETRY_CONFIG, MpApiWrapper, MP_DEFAULT_BASE_URL } from '../../src/wrappers/MpApiWrapper.ts'
import { MP_ENDPOINTS, MP_HOST, MP_UPSTREAM_HEADER } from '../../src/mp/types.ts'
import { isFaceNotRegistered } from '../../src/mp/envelope.ts'

interface ClientCall {
  method: 'GET' | 'POST'
  url: string
  opts: Record<string, unknown>
}

/** 假响应（只实现 rawRequest 用到的 `status` 与 `text()`） */
const jsonReply = (body: unknown, status = 200) => ({ status, text: async () => JSON.stringify(body) })
const rawReply = (raw: string, status = 200) => ({ status, text: async () => raw })

/** 替换 ky 实例为假 client；返回调用记录与还原函数（务必在 finally 里还原） */
function stubClient(reply: (call: ClientCall) => unknown) {
  const calls: ClientCall[] = []
  const original = (MpApiWrapper as unknown as { client: unknown }).client
  const wrap = (method: 'GET' | 'POST') => async (url: string, opts: Record<string, unknown>) => {
    const call: ClientCall = { method, url, opts }
    calls.push(call)
    return await reply(call)
  }
  ;(MpApiWrapper as unknown as { client: unknown }).client = { get: wrap('GET'), post: wrap('POST') }
  return { calls, restore: () => { (MpApiWrapper as unknown as { client: unknown }).client = original } }
}

/** 每个用例前清掉学校清单缓存（模块级单例，会跨用例串味） */
const resetCache = () => { MpApiWrapper.clearSchoolListCache() }

// ---------- ① 鉴权头：无 token 也必须发 `Bearer null` ----------

test('请求层：无 token 时 Authorization 必须是 `Bearer null`（不是省略该头）', async () => {
  const { calls, restore } = stubClient(() => jsonReply({ status: '00', body: [1] }))
  try {
    await MpApiWrapper.call('schoolList', {})
    assert.equal(calls.length, 1)
    assert.equal((calls[0].opts.headers as Record<string, string>).Authorization, 'Bearer null')
  } finally { restore() }
})

test('请求层：有 token 时 Authorization 用 `Bearer <token>`', async () => {
  const { calls, restore } = stubClient(() => jsonReply({ status: '00', obj: { snCode: 'x' } }))
  try {
    await MpApiWrapper.getStudentInfoByToken({ token: '  abc123  ' })
    assert.equal((calls[0].opts.headers as Record<string, string>).Authorization, 'Bearer abc123')
  } finally { restore() }
})

// ---------- ② 按端点元数据选方法 + 多租户基址头 ----------

test('请求层：按 MP_ENDPOINTS 的方法发请求（GET 走 get、POST 走 post）', async () => {
  const { calls, restore } = stubClient(() => jsonReply({ status: '00', obj: { snCode: 'x' } }))
  try {
    assert.equal(MP_ENDPOINTS.studentInfoByToken.method, 'GET')
    assert.equal(MP_ENDPOINTS.runBegin.method, 'POST')

    await MpApiWrapper.getStudentInfoByToken({ token: 't' })
    assert.equal(calls[0].method, 'GET')

    await MpApiWrapper.getRunBegin(
      { runType: 0, version: 'v', phoneInfo: 'p', paperId: 'paper', lineId: 'line', faceBase64: '' },
      { token: 't' },
    )
    assert.equal(calls[1].method, 'POST')
  } finally { restore() }
})

test('请求层：给了 baseUrl 就带 `x-mp-upstream` 头；没给则不带', async () => {
  const { calls, restore } = stubClient(() => jsonReply({ status: '00', obj: { snCode: 'x' } }))
  try {
    await MpApiWrapper.getStudentInfoByToken({ token: 't', baseUrl: 'https://school.example.edu' })
    assert.equal((calls[0].opts.headers as Record<string, string>)[MP_UPSTREAM_HEADER], 'https://school.example.edu')

    await MpApiWrapper.getStudentInfoByToken({ token: 't' })
    assert.equal((calls[1].opts.headers as Record<string, string>)[MP_UPSTREAM_HEADER], undefined)
  } finally { restore() }
})

// ---------- ③ 传输层异常 → 统一 system 判定 ----------

test('请求层：空响应 / 非 JSON / 抛错 三种传输异常都判成 kind=system 且 ok=false', async () => {
  const cases: Array<{ name: string; reply: () => unknown; expect: RegExp }> = [
    { name: '空响应', reply: () => rawReply('   '), expect: /空响应/ },
    { name: '非 JSON', reply: () => rawReply('<html>502</html>', 502), expect: /不是 JSON/ },
    { name: '网络异常', reply: () => { throw new TypeError('fetch failed') }, expect: /fetch failed/ },
  ]
  for (const c of cases) {
    const { calls, restore } = stubClient(c.reply)
    try {
      const res = await MpApiWrapper.call('schoolList', {})
      assert.equal(res.ok, false, c.name)
      assert.equal(res.kind, 'system', c.name)
      assert.match(res.message, c.expect, c.name)
      assert.equal(calls.length, 1, c.name)
    } finally { restore() }
  }
})

// ---------- ④ 判定透传（最易写错的两条：登录过期判据 / 建档门槛） ----------

test('请求层：`header.bizCode == -199` 必须判成 expired（不是 401、也不是业务失败）', async () => {
  const { restore } = stubClient(() => jsonReply({ header: { bizCode: -199 }, body: {} }))
  try {
    const res = await MpApiWrapper.call('schoolList', {})
    assert.equal(res.ok, false)
    assert.equal(res.kind, 'expired')
  } finally { restore() }
})

test('请求层：`getRunBegin` 回 code=888（未建档）→ business 且被 isFaceNotRegistered 识别', async () => {
  const { restore } = stubClient(() =>
    jsonReply({ status: '01', code: '888', msg: '学生人脸数据为空，请补充' }))
  try {
    const res = await MpApiWrapper.getRunBegin(
      { runType: 0, version: 'v', phoneInfo: 'p', paperId: 'paper', lineId: 'line', faceBase64: '' },
      { token: 't' },
    )
    assert.equal(res.ok, false)
    assert.equal(res.kind, 'business')
    assert.equal(isFaceNotRegistered(res), true)
  } finally { restore() }
})

// ---------- ⑤ 负载按端点规格解包（禁止全局兜底） ----------

test('请求层：负载按该端点规格解包 —— schoolList 取 body；`body` 有字段即算有负载', async () => {
  {
    const { restore } = stubClient(() => jsonReply({ status: '00', body: [{ schoolCode: '98765' }] }))
    try {
      const res = await MpApiWrapper.call<Array<{ schoolCode: string }>>('schoolList', {})
      assert.equal(res.ok, true)
      assert.equal(res.data?.[0]?.schoolCode, '98765')
    } finally { restore() }
  }
  {
    // ⚠️ **既有语义（本轮不改，属"判定逻辑"）**：具名字段规格下「字段存在但为空数组」判 **ok**
    //    （有字段 = 有负载），不是 empty；只有「字段缺失/为 null」或「带 #下标且取不到」才判 empty。
    //    这条在 `envelope.test.ts` 的「负载规格语义」用例里有更完整的说明。
    //    这里把它**钉在请求层**，防止有人改动判定层后没人发现。
    const { restore } = stubClient(() => jsonReply({ status: '00', body: [] }))
    try {
      const res = await MpApiWrapper.call('schoolList', {})
      assert.equal(res.ok, true)
      assert.deepEqual(res.data, [])
    } finally { restore() }
  }
  {
    // 字段缺失 → 无负载 → empty
    const { restore } = stubClient(() => jsonReply({ status: '00', code: '0' }))
    try {
      const res = await MpApiWrapper.call('schoolList', {})
      assert.equal(res.ok, false)
      assert.equal(res.kind, 'empty')
    } finally { restore() }
  }
})

// ---------- ⑥ 多租户基址解析与缓存 ----------

test('请求层：resolveSchoolBaseUrl 命中该校 domainUrl', async () => {
  resetCache()
  const { calls, restore } = stubClient(() => jsonReply({ status: '00', body: [
    { schoolCode: '98765', domainUrl: 'https://wxxcx.xtotoro.com' },
    { schoolCode: '10289', domainUrl: 'https://zhygp.just.edu.cn' },
  ] }))
  try {
    assert.equal(await MpApiWrapper.resolveSchoolBaseUrl('10289'), 'https://zhygp.just.edu.cn')
    assert.equal(calls.length, 1)
  } finally { restore(); resetCache() }
})

test('请求层：学校清单有 30 分钟缓存（第二次不重复请求），clear 后重拉', async () => {
  resetCache()
  const { calls, restore } = stubClient(() => jsonReply({ status: '00', body: [
    { schoolCode: '98765', domainUrl: 'https://wxxcx.xtotoro.com' },
  ] }))
  try {
    await MpApiWrapper.resolveSchoolBaseUrl('98765')
    await MpApiWrapper.resolveSchoolBaseUrl('98765')
    assert.equal(calls.length, 1, '第二次命中缓存，不应再发请求')

    MpApiWrapper.clearSchoolListCache()
    await MpApiWrapper.resolveSchoolBaseUrl('98765')
    assert.equal(calls.length, 2, '清缓存后必须重拉')
  } finally { restore(); resetCache() }
})

test('请求层：清单拉取失败 / 学校不在清单里 → 返回 undefined（调用方回落共享域）', async () => {
  resetCache()
  {
    const { restore } = stubClient(() => jsonReply({ status: '01', msg: '拉取失败' }))
    try {
      assert.equal(await MpApiWrapper.resolveSchoolBaseUrl('98765'), undefined)
    } finally { restore(); resetCache() }
  }
  {
    const { restore } = stubClient(() => jsonReply({ status: '00', body: [
      { schoolCode: '98765', domainUrl: 'https://wxxcx.xtotoro.com' },
    ] }))
    try {
      assert.equal(await MpApiWrapper.resolveSchoolBaseUrl('99999'), undefined)
    } finally { restore(); resetCache() }
  }
})

test('请求层：默认基址就是共享域常量', () => {
  assert.equal(MP_DEFAULT_BASE_URL, MP_HOST)
})

// ---------- ⑦ 接线契约：写操作绝不重试 ----------

test('接线契约：重试只允许 GET；写操作端点必须是 POST；unBindInfo 的 GET 例外被显式固定', () => {
  assert.deepEqual(MP_RETRY_CONFIG.methods, ['get'], '重试名单里出现非 GET 就可能重复提交')
  assert.equal(MP_RETRY_CONFIG.limit, 1)

  // 这些是**非幂等写操作**：一旦被重试就可能重复提交 / 重复建档
  for (const key of ['saveScores', 'saveScoreDetail', 'faceCheckSave', 'submitshoujidaka', 'morningExercises']) {
    assert.equal(MP_ENDPOINTS[key as keyof typeof MP_ENDPOINTS].method, 'POST', `${key} 必须是 POST`)
  }

  // ⚠️ 已知例外：`unBindInfo`（解绑账号，真写操作）用 **GET** 表达 → 会被上面的 retry 规则重试。
  //    我们只在用户明确登出时调用它，风险低；这里**故意断言这个事实**，
  //    防止后来者据此推断"GET 一定只读"而把别的写操作也做成 GET。
  assert.equal(MP_ENDPOINTS.unBindInfo.method, 'GET')
})
