/**
 * 「子进程回传地址」的纯函数测试（2026-09-20，`ERROR.md` E59）
 *
 * 为什么值得单测：这行代码**写死过一个地址族**，代价是「一键获取 token」整个功能在
 * "dev 只监听 `::1`"时静默失效（界面报"扫描器未回传结果（退出码 1）"，看起来像被杀软拦截）。
 * 判据：**回传 origin 的地址族必须跟请求来的地址族一致**，且 `localhost` 要归一成 IPv4 字面量
 * （子进程少一次名字解析）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_HOST_RE, localCallbackOrigin } from '../../server/utils/tokenScanState.ts'

test('localCallbackOrigin：跟着**服务实际绑定**的地址族走（这是 E59 的正解）', () => {
  // 绑 IPv4 回环：两种写法（127.0.0.1 / localhost）都用 IPv4 字面量
  assert.equal(localCallbackOrigin('127.0.0.1:3000', '3000', '127.0.0.1'), 'http://127.0.0.1:3000')
  assert.equal(localCallbackOrigin('localhost:3000', '3000', '127.0.0.1'), 'http://127.0.0.1:3000')
  // ⭐ 绑 IPv6 回环：**即使页面是用 localhost 打开的**，回传也必须走 [::1]（否则回传必失败）
  assert.equal(localCallbackOrigin('localhost:3000', '3000', '::1'), 'http://[::1]:3000')
  assert.equal(localCallbackOrigin('[::1]:4000', '3000', '[::1]'), 'http://[::1]:4000')
  // 绑所有接口（0.0.0.0 / ::）⇒ IPv4 回环最稳
  assert.equal(localCallbackOrigin('127.0.0.1:3000', '3000', '0.0.0.0'), 'http://127.0.0.1:3000')
  assert.equal(localCallbackOrigin('127.0.0.1:3000', '3000', '::'), 'http://127.0.0.1:3000')
})

test('localCallbackOrigin：绑定未知时**跟请求同族**，Host 缺失/非本机则回落 IPv4 回环', () => {
  // dev 场景：`devServer.host` 不会写进环境变量 ⇒ boundHost 为空
  assert.equal(localCallbackOrigin('localhost:3000', '3000', ''), 'http://127.0.0.1:3000')
  assert.equal(localCallbackOrigin('[::1]:3000', '3000', ''), 'http://[::1]:3000')
  assert.equal(localCallbackOrigin('127.0.0.1', '3000', ''), 'http://127.0.0.1:3000')
  assert.equal(localCallbackOrigin('', '3000', ''), 'http://127.0.0.1:3000')
  assert.equal(localCallbackOrigin(null, '3000', ''), 'http://127.0.0.1:3000')
  assert.equal(localCallbackOrigin(undefined, '3000', ''), 'http://127.0.0.1:3000')
  // 非本机 Host 一律回落 IPv4 回环（绝不去连外部域名）
  assert.equal(localCallbackOrigin('evil.example.com:3000', '3000', ''), 'http://127.0.0.1:3000')
  assert.equal(localCallbackOrigin('192.168.1.9:3000', '3000', ''), 'http://127.0.0.1:3000')
  // 端口非法（非数字）时用 fallback，不产出 `http://127.0.0.1:undefined`
  assert.equal(localCallbackOrigin('127.0.0.1:abc', '3000', ''), 'http://127.0.0.1:3000')
  assert.equal(localCallbackOrigin('[::1]', 4123, ''), 'http://[::1]:4123')
})

test('LOCAL_HOST_RE：只认回环三种写法（与 assertLocalRequest 共用同一份判据）', () => {
  for (const ok of ['127.0.0.1', '127.0.0.1:3000', 'localhost', 'localhost:3000', '[::1]', '[::1]:3000']) {
    assert.ok(LOCAL_HOST_RE.test(ok), `应允许：${ok}`)
  }
  for (const bad of ['', '0.0.0.0:3000', 'example.com', '127.0.0.2:3000', '::1', '[::2]:3000', 'localhost.evil.com']) {
    assert.ok(!LOCAL_HOST_RE.test(bad), `应拒绝：${bad}`)
  }
})
