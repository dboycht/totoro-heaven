/**
 * 信封判定与负载解包测试
 *
 * 用例全部取自 **2026-09-11 真实抓包**（`_mp-analyze/开跑前实测结论.md`）与
 * 源码逐端点表（`_mp-analyze/深挖/D-配置与归档数据模型.md` §0.3），
 * 覆盖旧实现出错的三处：状态码三轨、负载逐端点漂移、登录过期的真实判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBearerValue,
  hasBusinessPayload,
  isFaceNotRegistered,
  isMpExpired,
  isMpOk,
  isStudentUnregistered,
  judgeMpResponse,
  looksLikeTokenExpired,
  parsePayloadSpec,
  unwrapMpResponse,
} from '../../src/mp/envelope.ts'
import { MP_ENDPOINTS } from '../../src/mp/types.ts'

// ---------- Authorization：无 token 也必须发 ----------

test('buildBearerValue：有 token 用 token，无 token 发 Bearer null', () => {
  assert.equal(buildBearerValue('WXXCXh-abc'), 'Bearer WXXCXh-abc')
  assert.equal(buildBearerValue(''), 'Bearer null')
  assert.equal(buildBearerValue(undefined), 'Bearer null')
  assert.equal(buildBearerValue(null), 'Bearer null')
  assert.equal(buildBearerValue('   '), 'Bearer null')
})

// ---------- 负载规格解析 ----------

test('parsePayloadSpec：none/top 无字段', () => {
  assert.deepEqual(parsePayloadSpec('none'), [])
  assert.deepEqual(parsePayloadSpec('top'), [])
})

test('parsePayloadSpec：字段 / 兜底链 / 下标', () => {
  assert.deepEqual(parsePayloadSpec('obj'), [{ field: 'obj' }])
  assert.deepEqual(parsePayloadSpec('data|body|list|obj'), [
    { field: 'data' },
    { field: 'body' },
    { field: 'list' },
    { field: 'obj' },
  ])
  assert.deepEqual(parsePayloadSpec('getSunrunPaperResponseList#0'), [
    { field: 'getSunrunPaperResponseList', index: 0 },
  ])
})

// ---------- 负载解包（逐端点漂移） ----------

test('unwrap：obj / body / data 三种落点各取各的', () => {
  assert.deepEqual(unwrapMpResponse({ status: '00', obj: { a: 1 } }, 'obj'), { a: 1 })
  assert.equal(unwrapMpResponse({ status: '00', body: '1' }, 'body'), '1')
  assert.deepEqual(unwrapMpResponse({ status: '00', data: [1, 2] }, 'data'), [1, 2])
})

test('unwrap：裸顶层端点直接返回整个响应（getRunBegin 的 scantronId 在顶层）', () => {
  const res = { status: '00', code: '0', scantronId: 'sunrunId20260911217' }
  const data = unwrapMpResponse<{ scantronId?: string }>(res, 'top')
  assert.equal(data?.scantronId, 'sunrunId20260911217')
})

test('unwrap：selectSunRunDayScantronList 的兜底链 data??body??list??obj', () => {
  const spec = 'data|body|list|obj'
  assert.deepEqual(unwrapMpResponse({ list: [{ id: 'x' }] }, spec), [{ id: 'x' }])
  assert.deepEqual(unwrapMpResponse({ obj: [{ id: 'y' }] }, spec), [{ id: 'y' }])
  // data 优先
  assert.deepEqual(unwrapMpResponse({ data: [{ id: 'd' }], body: [{ id: 'b' }] }, spec), [{ id: 'd' }])
  assert.equal(unwrapMpResponse({}, spec), undefined)
})

test('unwrap：取顶层数组第 0 项；空数组视为无负载', () => {
  assert.deepEqual(unwrapMpResponse({ getSunrunPaperResponseList: [{ taskId: 't1' }] }, 'getSunrunPaperResponseList#0'), {
    taskId: 't1',
  })
  assert.equal(unwrapMpResponse({ getSunrunPaperResponseList: [] }, 'getSunrunPaperResponseList#0'), undefined)
})

test('unwrap：payload 为 none 时永远 undefined', () => {
  assert.equal(unwrapMpResponse({ status: '00', body: { a: 1 } }, 'none'), undefined)
})

test('unwrap：裸数组响应原样返回（systemporductList）', () => {
  const arr = [{ id: 1 }, { id: 2 }]
  assert.deepEqual(unwrapMpResponse(arr, 'top'), arr)
})

// ---------- 状态码三轨 ----------

test('判定：status "00" 成功（sunrun 系列）', () => {
  const v = judgeMpResponse({ status: '00' }, 'none')
  assert.equal(v.ok, true)
  assert.equal(v.kind, 'ok')
})

test('判定：code 0 / "0" 成功（serverlist、mornSign、getRunBegin）', () => {
  assert.equal(judgeMpResponse({ code: 0 }, 'none').ok, true)
  assert.equal(judgeMpResponse({ code: '0' }, 'none').ok, true)
})

test('判定：status/code "200" 也算成功（人脸系列的真实判据）', () => {
  assert.equal(judgeMpResponse({ code: '200' }, 'none').ok, true)
  assert.equal(judgeMpResponse({ status: '200' }, 'none').ok, true)
})

test('判定：header.bizCode == 0 成功（新式信封）', () => {
  const v = judgeMpResponse({ header: { bizCode: 0 }, body: { a: 1 } }, 'body')
  assert.equal(v.ok, true)
})

test('判定：登录过期是 header.bizCode == -199（不是 401）', () => {
  const res = { header: { bizCode: -199, msg: '登录过期，请重新登录！' } }
  const v = judgeMpResponse(res, 'top')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'expired')
  assert.equal(v.code, '-199')
  assert.equal(v.message, '登录过期，请重新登录！')
  assert.equal(isMpExpired(res), true)
})

test('判定：业务失败码（01 / 1 / -11 / 888 / -6001）都归 business', () => {
  for (const res of [
    { status: '01', msg: '该校区阳光跑任务未设置或无匹配任务，异常！' },
    { code: '1', msg: '失败' },
    { status: '-11', code: '1', message: '记录提交异常' },
    { status: '01', msg: '学生人脸数据为空，请补充', code: '888' },
    { code: '-6001', message: '学生未注册' },
  ]) {
    const v = judgeMpResponse(res, 'none')
    assert.equal(v.ok, false, `应判失败：${JSON.stringify(res)}`)
    assert.equal(v.kind, 'business')
  }
})

test('判定：状态码冲突时按源码的 OR 语义（任一成功码即成功）', () => {
  // 小程序源码：人脸系列 `"00"!=status && 0!=code && "200"!=code` → 三者全不满足才失败；
  // `sunRunExercises` 也是「新版看 status / 旧版看 code」。故这里刻意保持 OR 语义，勿改成 fail-closed。
  assert.equal(judgeMpResponse({ status: '00', code: '1' }, 'none').ok, true)
  assert.equal(judgeMpResponse({ status: '200' }, 'none').ok, true)
})

test('判定：响应为空 / 非对象 → system、unknown', () => {
  assert.equal(judgeMpResponse(null, 'top').kind, 'system')
  assert.equal(judgeMpResponse(undefined, 'top').kind, 'system')
  assert.equal(judgeMpResponse('oops', 'top').kind, 'unknown')
})

test('判定：无状态码但有负载 → 放行（源码大量端点不判定状态）', () => {
  const v = judgeMpResponse({ obj: { id: 1 } }, 'obj')
  assert.equal(v.ok, true)
})

test('判定：状态成功但负载为空 → empty（getSunrunArch 的「没有阳光跑任务！」）', () => {
  const v = judgeMpResponse({ status: '00', msg: '没有阳光跑任务！' }, 'top')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'empty')
  assert.equal(v.message, '没有阳光跑任务！')
})

test('判定：payload 为 none 的端点不做负载非空校验（submitAppeal 只回 status）', () => {
  assert.equal(judgeMpResponse({ status: '00' }, 'none').ok, true)
  assert.equal(judgeMpResponse({ status: '00' }, 'top').ok, false)
})

/**
 * ⚠️ 标题更正（2026-09-17）：原标题写的是"→ empty"，但断言恰恰相反 —— 会误导读者以为
 * 「空数组应当判 empty」从而去"修"实现。**实际语义是刻意的，两条要分清**：
 *   - **具名字段（`body`）**：**有该字段就算有负载**（`[]` 也算）→ 空数组判 **ok**；
 *     调用方自己看数组长度（如 schoolList / termList）。
 *   - **具名字段 + 下标（`body#0`）**：取不到第 0 项 → 无负载 → 判 **empty**
 *     （`getSunrunPaper` 这类"任务未设置"走的正是这条）。
 */
test('负载规格语义：`body` 有字段即视为有负载（true）；`body#0` 空数组取不到下标（false）', () => {
  assert.equal(hasBusinessPayload({ body: [] }, 'body'), true)
  assert.equal(hasBusinessPayload({ body: null }, 'body'), false)
  assert.equal(hasBusinessPayload({ body: [] }, 'body#0'), false)
})

// ---------- 真实抓包报文回归 ----------

test('真实报文：getRunBegin 未建档 → business + isFaceNotRegistered', () => {
  const res = { status: '01', msg: '学生人脸数据为空，请补充', code: '888' }
  const v = judgeMpResponse(res, MP_ENDPOINTS.runBegin.payload)
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'business')
  assert.equal(isFaceNotRegistered(v), true)
})

test('真实报文：getRunBegin 建档后 → ok，scantronId 可取', () => {
  const res = { status: '00', code: '0', scantronId: 'sunrunId20260911217' }
  const v = judgeMpResponse(res, MP_ENDPOINTS.runBegin.payload)
  assert.equal(v.ok, true)
  assert.equal(unwrapMpResponse<{ scantronId: string }>(res, MP_ENDPOINTS.runBegin.payload)?.scantronId, 'sunrunId20260911217')
})

test('真实报文：sunRunExercises 被拒（status -11 / code 1）', () => {
  const res = { status: '-11', message: '记录提交异常', code: '1' }
  const v = judgeMpResponse(res, MP_ENDPOINTS.saveScores.payload)
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'business')
  assert.equal(v.message, '记录提交异常')
})

test('真实报文：登录响应 token 在顶层', () => {
  const res = {
    status: '00',
    code: '0',
    token: 'WXXCXh-EXAMPLE-TOKEN',
    teacherType: '0',
    adminType: '0',
  }
  const v = judgeMpResponse(res, MP_ENDPOINTS.lesseeServerByNewDecode.payload)
  assert.equal(v.ok, true)
  assert.equal((v.ok ? unwrapMpResponse<{ token: string }>(res, 'top')?.token : ''), 'WXXCXh-EXAMPLE-TOKEN')
})

test('真实报文：学生未注册 -6001', () => {
  const v = judgeMpResponse({ code: '-6001', message: '学生未注册' }, 'none')
  assert.equal(isStudentUnregistered(v), true)
})

test('真实报文：selectSunRunStartConfiguration 的人脸开关在 body', () => {
  const res = { status: '00', body: { sunrunPointShowOff: '1', sunrunStartFace: '0', sunrunPointRandom: '0' } }
  const v = judgeMpResponse(res, MP_ENDPOINTS.sunRunStartConfiguration.payload)
  assert.equal(v.ok, true)
  const body = unwrapMpResponse<Record<string, string>>(res, MP_ENDPOINTS.sunRunStartConfiguration.payload)
  assert.equal(body?.sunrunStartFace, '0')
  assert.equal(body?.sunrunPointRandom, '0')
})

test('真实报文：getCameraConfig 的 flag 在 body（2026-09-15 修正，E30）', () => {
  // 依据小程序源码：CameraConfigFlag: t.body?.flag（逐字）；摄像头列表在同级 data[]
  const res = {
    status: '00',
    body: { flag: false },
    data: [{ pointPoleTime: 30, cameraPoleTime: 30, cameraPoleDistance: 10 }],
  }
  assert.equal(MP_ENDPOINTS.cameraConfig.payload, 'body', 'cameraConfig 的负载位置必须是 body（曾误标 top）')
  const v = judgeMpResponse(res, MP_ENDPOINTS.cameraConfig.payload)
  assert.equal(v.ok, true)
  const body = unwrapMpResponse<{ flag?: boolean }>(res, MP_ENDPOINTS.cameraConfig.payload)
  assert.equal(body?.flag, false, 'body.flag 应能取到（false = 未启用摄像头杆）')
  // 反向锁定：拿整个响应当负载时取不到 flag（这正是修复前的错误读法）
  const asTop = unwrapMpResponse<{ flag?: boolean }>(res, 'top')
  assert.equal(asTop?.flag, undefined, 'top 层没有 flag —— 说明旧读法必然拿到 undefined')
})

test('真实报文：getCameraConfig 未传 lineId 时服务端报"入参路线id为空！"', () => {
  // 9-14 探针的真实 dump（status 01）—— 提醒：这条端点的 lineId 是必填，缺了不会报 HTTP 错
  const res = { status: '01', message: '入参路线id为空！', body: null, data: null, wxLoginStatus: 0 }
  const v = judgeMpResponse(res, MP_ENDPOINTS.cameraConfig.payload)
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'business')
})

test('looksLikeTokenExpired：识别两种真实表达（-199 拦截 / status 01 + "失效"）', () => {
  // ① 新式拦截：header.bizCode == -199
  assert.equal(looksLikeTokenExpired({ header: { bizCode: -199 } }), true)
  assert.equal(looksLikeTokenExpired({ header: { bizCode: 0 } }), false)
  // ② 业务失败 + 文案含"失效"（GetStudentInfoByToken 2026-09-15 实测）
  assert.equal(looksLikeTokenExpired({ status: '01', code: '1', msg: 'token失效，注册失败' }), true)
  assert.equal(looksLikeTokenExpired({ status: '00', msg: 'token失效，注册失败' }), false, 'status=00 不是失败')
  // 不含"失效/过期"的业务失败 → false
  assert.equal(looksLikeTokenExpired({ status: '01', message: '入参路线id为空！' }), false)
  assert.equal(looksLikeTokenExpired(null), false)
  assert.equal(looksLikeTokenExpired(undefined), false)
})

test('真实报文：学校清单负载在 body（/wxapi 端点）', () => {
  const res = { body: [{ schoolCode: '98765', schoolName: '南京航空航天大学', domainUrl: 'https://wxxcx.xtotoro.com' }] }
  const v = judgeMpResponse(res, MP_ENDPOINTS.schoolList.payload)
  assert.equal(v.ok, true)
  const list = unwrapMpResponse<{ schoolCode: string; domainUrl: string }[]>(res, MP_ENDPOINTS.schoolList.payload)
  assert.equal(list?.[0]?.domainUrl, 'https://wxxcx.xtotoro.com')
})

test('真实报文：systemporductList 是裸数组', () => {
  assert.equal(isMpOk([{ id: 1 }], 'top'), true)
})

// ---------- 端点元数据表自检 ----------

test('元数据表：每项都有合法路径 / 方法 / 负载规格', () => {
  const entries = Object.entries(MP_ENDPOINTS)
  assert.ok(entries.length >= 50, `端点表条目过少：${entries.length}`)
  for (const [key, meta] of entries) {
    assert.ok(meta.path.startsWith('/'), `${key}: path 必须以 / 开头`)
    assert.ok(['GET', 'POST'].includes(meta.method), `${key}: 方法非法 ${meta.method}`)
    assert.equal(typeof meta.payload, 'string')
    assert.equal(typeof meta.needToken, 'boolean')
    if (meta.payload !== 'none' && meta.payload !== 'top') {
      const fields = parsePayloadSpec(meta.payload)
      assert.ok(fields.length > 0, `${key}: 负载规格解析为空`)
      for (const field of fields) assert.ok(field.field.length > 0, `${key}: 空字段名`)
    }
  }
})

test('元数据表：登录前必调的 7 个端点标记为免鉴权', () => {
  const anonymous = Object.entries(MP_ENDPOINTS)
    .filter(([, meta]) => !meta.needToken)
    .map(([key]) => key)
    .sort()
  assert.deepEqual(anonymous, [
    'bindLogin',
    'firstConfiguration',
    'lesseeServerByNewDecode',
    'schoolList',
    'selectSunRunStudent',
    'studentInfo',
    'verificationCode',
  ])
})

test('元数据表：GET 端点只有少数几个（其余一律 POST）', () => {
  const gets = Object.entries(MP_ENDPOINTS)
    .filter(([, meta]) => meta.method === 'GET')
    .map(([key]) => key)
    .sort()
  assert.deepEqual(gets, ['ossAccessId', 'studentInfoByToken', 'systemporductList', 'unBindInfo'])
})
