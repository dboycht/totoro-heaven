// Unit-test the track math against known-good values, independent of the emulator.
//
// 这份脚本验的是 TrackMath.kt 里那套**从官方小程序 v73 逆向出来的算法**。
// 它跑在 Node 上（纯数学、不依赖安卓），所以能在没有真机的情况下先把"算法对不对"钉死。
//
// ⚠️ 写这类验证脚本时**踩过三个坑**（2026-11-02，都已修，留作判据）：
//  1. **生成坐标必须与被测代码共用同一套球面常数**。haversine 用 R = 6371 km，
//     对应 1 度纬度 = 111194.9 m；先前用 111320 m/度 生成、用 haversine 量，
//     0.112% 的系统偏差让 84.39 m 直道量成 84.30 m。
//     ⇒ 判据：验证脚本与被测代码的常数必须同源，否则红的是脚本不是代码。
//  2. **几何必须闭合**。先前弧段公式写错、首尾不接，一圈量出 444 m（理论 398 m），
//     且点数越多越长（收敛到 449.5 m）—— 这个"不收敛"就是要查的指纹。
//     ⇒ 判据：折线近似曲线的长度必须**随采样加密而收敛到理论值**，否则是几何写错。
//  3. **断言要先手算**。1225 s / 3.2 km = 382.81 s/km ⇒ 源码用 Math.floor ⇒ 6'22"，
//     先前写成 6'23"（按四舍五入想）是断言错。
import { readFileSync } from 'node:fs'

const R = 6371e3
const toRad = (d) => (d * Math.PI) / 180
const M_PER_DEG_LAT = (R * Math.PI) / 180 // 与 haversine 自洽（111194.9 m）

function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * (2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)))
}

function pointToSegmentDistance(plat, plng, alat, alng, blat, blng) {
  const dx = blat - alat, dy = blng - alng
  const lenSq = dx * dx + dy * dy
  let t = -1
  if (lenSq !== 0) t = ((plat - alat) * dx + (plng - alng) * dy) / lenSq
  let clat, clng
  if (t < 0) { clat = alat; clng = alng }
  else if (t > 1) { clat = blat; clng = blng }
  else { clat = alat + t * dx; clng = alng + t * dy }
  return distanceMeters(plat, plng, clat, clng)
}

function similarity(route, user, step = 5, tol = 25) {
  if (route.length < 2 || user.length < 2) return 0
  let matched = 0, checked = 0
  for (let i = 0; i < route.length - 1; i++) {
    const [alat, alng] = route[i], [blat, blng] = route[i + 1]
    let steps = Math.max(1, Math.ceil(distanceMeters(alat, alng, blat, blng) / step))
    for (let s = 0; s < steps; s++) {
      const r = s / steps
      const plat = alat + (blat - alat) * r
      const plng = alng + (blng - alng) * r
      let minDist = Infinity
      for (let j = 0; j < user.length - 1; j++) {
        const d = pointToSegmentDistance(plat, plng, user[j][0], user[j][1], user[j + 1][0], user[j + 1][1])
        if (d < minDist) minDist = d
        if (minDist <= tol) break
      }
      if (minDist <= tol) matched++
      checked++
    }
  }
  return checked === 0 ? 0 : matched / checked
}

function paceText(elapsedSeconds, km) {
  if (km <= 0 || elapsedSeconds <= 0) return "0'00\""
  let pace = elapsedSeconds / 60 / km
  if (!Number.isFinite(pace) || pace <= 0) return "0'00\""
  if (pace > 99) pace = 99
  const m = Math.floor(pace)
  const s = Math.floor(60 * (pace - m))
  return `${m}'${String(s).padStart(2, '0')}"`
}

function kcalText(km) {
  if (!Number.isFinite(km) || km <= 0) return '0.00'
  return (55 * km * 1.036).toFixed(2)
}

function kmText(meters) {
  return (meters / 1000).toFixed(2)
}

// ---------- 造一条闭合的 400 m 标准跑道 ----------
const cLat = 32.0412, cLng = 118.7231
const straights = 84.39, radius = 36.5
const mLat = 1 / M_PER_DEG_LAT
const mLng = 1 / (M_PER_DEG_LAT * Math.cos(toRad(cLat)))
const perim = 2 * straights + 2 * Math.PI * radius

function stadium(samples) {
  const pts = []
  const half = Math.PI * radius
  for (let k = 0; k < samples; k++) {
    const d = (k / samples) * perim
    let lat, lng
    if (d < straights) {
      lat = cLat + d * mLat; lng = cLng - radius * mLng
    } else if (d < straights + half) {
      const a = (d - straights) / radius - Math.PI / 2
      lat = cLat + straights * mLat + Math.cos(a) * radius * mLat
      lng = cLng + Math.sin(a) * radius * mLng
    } else if (d < 2 * straights + half) {
      const dd = d - straights - half
      lat = cLat + straights * mLat - dd * mLat; lng = cLng + radius * mLng
    } else {
      const a = (d - 2 * straights - half) / radius + Math.PI / 2
      lat = cLat + Math.cos(a) * radius * mLat
      lng = cLng + Math.sin(a) * radius * mLng
    }
    pts.push([lat, lng])
  }
  pts.push(pts[0])
  return pts
}

const track = stadium(400)
let lapLen = 0
for (let i = 1; i < track.length; i++) lapLen += distanceMeters(track[i-1][0], track[i-1][1], track[i][0], track[i][1])

const results = []
const check = (name, got, ok) => results.push([name, got, ok])

// ---- 距离 ----
check('84.39m 直道量距', `${distanceMeters(cLat, cLng, cLat + straights * mLat, cLng).toFixed(2)} m`,
  Math.abs(distanceMeters(cLat, cLng, cLat + straights * mLat, cLng) - straights) < 0.05)
check('400m 跑道一圈', `${lapLen.toFixed(1)} m`, Math.abs(lapLen - perim) / perim < 0.005)
check('一圈折合 km', `${kmText(lapLen)} km`, kmText(lapLen) === '0.40')

// ---- 收敛性：加密采样必须收敛（用来抓几何错误） ----
const lens = [100, 400, 1600].map((n) => {
  const t = stadium(n)
  let s = 0
  for (let i = 1; i < t.length; i++) s += distanceMeters(t[i-1][0], t[i-1][1], t[i][0], t[i][1])
  return s
})
check('采样加密收敛（100→1600 点偏差 <0.2%）', `${lens.map((x) => x.toFixed(1)).join(' / ')}`,
  Math.abs(lens[2] - lens[0]) / lens[0] < 0.002)

// ---- 配速 / 卡路里（口径逐字取自源码） ----
check("3.2km / 1225s 配速", paceText(1225, 3.2), paceText(1225, 3.2) === "6'22\"")
check("6'10\"/km 反算（3.31km 用时 1225s）", paceText(1225, 3.31), paceText(1225, 3.31) === "6'10\"")
check('零公里配速', paceText(100, 0), paceText(100, 0) === "0'00\"")
check('配速上限 99 分', paceText(100000, 1), paceText(100000, 1) === "99'00\"")
check('3.2km 卡路里', kcalText(3.2), kcalText(3.2) === '182.34')

// ---- 拟合度 ----
check('同一轨迹', similarity(track, track).toFixed(3), similarity(track, track) > 0.999)

// 容差边界：整条平移 25 m 仍算命中，30 m 开始掉分（实测拐点，容差就是 25 m）
const at25 = track.map(([a, b]) => [a + 25 * mLat, b])
const at30 = track.map(([a, b]) => [a + 30 * mLat, b])
check('平移 25m（恰在容差上）', similarity(track, at25).toFixed(3), similarity(track, at25) > 0.99)
check('平移 30m（刚出容差）', similarity(track, at30).toFixed(3), similarity(track, at30) < 0.95)

// ⚠️ 整条平移**不会**让拟合度归零：参考线上下两条直道只隔 73 m，
//    平移后参考线弧段上的采样点仍能命中"另一条直道"。归零要 ~200 m。
//    这是算法固有性质（不是 bug），写成断言钉住，免得以后有人"修"错东西。
const at200 = track.map(([a, b]) => [a + 200 * mLat, b])
check('平移 200m 才归零（算法固有性质）', similarity(track, at200).toFixed(3), similarity(track, at200) < 0.01)

// 只跑半条 ≈ 0.62（不是 0.5 —— 这是算法 + 操场形状的固有性质，实测确认过，不是 bug）：
//   跑道上下两条直道相距 2×36.5 = 73 m，而容差是 25 m；跑完前半程后，
//   参考线"直道 2 + 弧 2"上的采样点仍有一部分落在**已跑过的弧 1/直道 1 的端点**附近，
//   于是它们也被记成命中 ⇒ 命中率高于 0.5。
//   逐段实测：直道1 = 1.00、弧1 = 0.69、直道2 = 0.18、弧2 更低。
//   ⇒ 判据：这条只能按**实测值区间**钉住（0.60~0.65），不能按"直觉的 0.5"写，
//     否则被测的明明是正确实现，红的是断言。
const halfTrack = track.slice(0, Math.floor(track.length / 2))
const halfScore = similarity(track, halfTrack)
check('只跑半条（实测 0.625，非 0.5）', halfScore.toFixed(3), halfScore > 0.60 && halfScore < 0.66)

// 轨迹抖动（真实 GPS 都有的噪声）：±3 m 随机抖动应仍接近满分
let seed = 42
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const noisy = track.map(([a, b]) => [a + (rnd() - 0.5) * 6 * mLat, b + (rnd() - 0.5) * 6 * mLng])
check('±3m 噪声（真实 GPS 幅度）', similarity(track, noisy).toFixed(3), similarity(track, noisy) > 0.95)

// 退化输入必须返回 0 且不抛
check('空参考线', String(similarity([], track)), similarity([], track) === 0)
check('单点轨迹', String(similarity(track, [[cLat, cLng]])), similarity(track, [[cLat, cLng]]) === 0)

let bad = 0
for (const [name, got, ok] of results) {
  if (!ok) bad++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} = ${got}`)
}
console.log(bad === 0 ? `\nALL PASS (${results.length} 条)` : `\n${bad} FAILED`)
process.exit(bad === 0 ? 0 : 1)
