/**
 * **Web Mercator 投影单一来源的测试**（2026-11-05 整理轮）
 *
 * 背景：`lng2x/lat2y/x2lng/y2lat/TILE` 原先在「自由跑路径」「跑道编辑」「轨迹预览」
 * 三个组件里各内联一份逐字相同的实现；收敛到 `utils/mp/webMercator.ts` 后，
 * 这里钉住投影数学本身，保证"画与量是同一套坐标"：
 *   ① 瓦片常量与已知点（本初子午线/赤道在单瓦片正中、经度 ±180 落在 z=1 瓦片边缘）；
 *   ② 正反变换在整数与**小数**缩放级下都互逆（滚轮缩放是小数级 ⇒ 必须覆盖）；
 *   ③ 方向性：x 随经度递增、y 随纬度递减（北在上）；
 *   ④ 往返误差在浮点噪声量级内（不放大）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TILE, lng2x, lat2y, x2lng, y2lat } from '../../utils/mp/webMercator'

test('TILE 常量 = 256（与 OSM/Leaflet 惯例一致，三个组件共用）', () => {
  assert.equal(TILE, 256)
})

test('已知点：本初子午线/赤道在 z=0 单瓦片正中', () => {
  assert.equal(lng2x(0, 0), 0.5)
  assert.equal(lat2y(0, 0), 0.5)
})

test('已知点：z=1 时经度 ±180 落在 x=0 / x=2', () => {
  assert.equal(lng2x(-180, 1), 0)
  assert.equal(lng2x(180, 1), 2)
})

test('正反变换互逆（整数与小数缩放级；小数级是滚轮缩放的常态）', () => {
  const zooms = [13, 16, 17, 17.35, 22]
  for (const z of zooms) {
    for (let lng = -179.9; lng <= 179.9; lng += 45) {
      assert.ok(Math.abs(x2lng(lng2x(lng, z), z) - lng) < 1e-9, `x 往返 z=${z} lng=${lng}`)
    }
    for (let lat = -85; lat <= 85; lat += 17) {
      assert.ok(Math.abs(y2lat(lat2y(lat, z), z) - lat) < 1e-9, `y 往返 z=${z} lat=${lat}`)
    }
  }
})

test('方向性：x 随经度递增、y 随纬度递减（北在上）', () => {
  assert.ok(lng2x(119.4, 17) < lng2x(119.5, 17))
  assert.ok(lat2y(31.4, 17) > lat2y(31.5, 17))
})

test('往返误差不放大（墨卡托高纬仍 < 1e-6 度）', () => {
  for (const lat of [60, 75, 84]) {
    const z = 18
    assert.ok(Math.abs(y2lat(lat2y(lat, z), z) - lat) < 1e-6, `高纬往返 lat=${lat}`)
  }
})
