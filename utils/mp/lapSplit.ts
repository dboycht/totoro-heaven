/**
 * **按圈切段**（纯函数，有单测）—— 轨迹预览"每圈一色 / 点某一圈隐藏"的判据来源。
 *
 * ## 为什么要单独抽出来
 * 切圈逻辑原来埋在 `RunTrajectoryPreview.vue` 的 computed 里，改一处要看整个组件；
 * 抽成纯函数后可以钉住三条最容易错的判据（见下），组件只负责画。
 *
 * ## 三条判据（都有单测）
 *   ① **第 1 圈从 `startIndex` 开始**（用户 2026-11-03 要求："轨迹第 1 圈必须从起跑点开始"）：
 *      设了进场点时，轨迹前几个点是"从进场点走到起跑点"的直线，**不能算进第 1 圈**；
 *      `startIndex` 之前的点单独作为 `leadIn` 返回（界面画成"进场段（不计圈）"）。
 *   ② `lapLengthM <= 0` 或点太少 ⇒ 退化成**一整段**（`laps = [{lap: 0, pts}]`，`leadIn = []`），
 *      与旧行为逐点一致（旧数据没有进场段、也可能没有一圈长度）。
 *   ③ 跨圈那一步的**交界点同时属于相邻两圈**（`pts[i]` 既收尾上一圈又起头下一圈）——
 *      否则每圈之间会裂开一道缝，多圈叠在一起时看着像断线。
 */

export interface LapPoint {
  latitude: number
  longitude: number
}

export interface LapSegment {
  /** 0 基圈号（显示时 +1） */
  lap: number
  pts: LapPoint[]
}

export interface LapSplit {
  /** 第 1 圈之前的点（进场段；`startIndex = 0` 时为空） */
  leadIn: LapPoint[]
  /** 按圈切好的段（`lapLengthM <= 0` 时只有一段、`lap: 0`） */
  laps: LapSegment[]
  /** 实际用于切圈的长度（米；0 = 没切） */
  lapLengthM: number
  /** 实际开始计数的下标（= 进场段点数） */
  startIndex: number
}

/** 两点的近似地面距离（米）—— 与预览里其它读数同一套等距近似 */
const meters = (a: LapPoint, b: LapPoint): number => {
  const mPerDegLat = 111320
  const mLng = 111320 * Math.cos(((a.latitude + b.latitude) / 2) * (Math.PI / 180))
  return Math.hypot((b.latitude - a.latitude) * mPerDegLat, (b.longitude - a.longitude) * mLng)
}

/**
 * 把一条轨迹按 `lapLengthM` 切成一圈一段。
 *
 * @param points     整条轨迹（含进场段）
 * @param lapLengthM 一圈长度（米）；`<= 0` ⇒ 不切（只返回一整段）
 * @param startIndex 第 1 圈从第几个点开始（= 进场段点数）；越界会被夹到合法范围
 */
export function splitLapsByLength(
  points: LapPoint[],
  lapLengthM: number,
  startIndex = 0,
): LapSplit {
  const all = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) : []
  const lapM = Number(lapLengthM)
  const idx = Math.max(0, Math.min(all.length, Math.round(Number(startIndex) || 0)))
  const leadIn = all.slice(0, idx)
  const body = all.slice(idx)
  /** ② 退化：没长度 / 点太少 ⇒ 一整段（`lap: 0`） */
  if (!(lapM > 0) || body.length < 2) {
    return { leadIn, laps: [{ lap: 0, pts: body }], lapLengthM: lapM > 0 ? lapM : 0, startIndex: idx }
  }
  const laps: LapSegment[] = []
  let acc = 0
  let curLap = 0
  let cur: LapPoint[] = [body[0]!]
  for (let i = 1; i < body.length; i++) {
    acc += meters(body[i - 1]!, body[i]!)
    const lap = Math.floor(acc / lapM)
    if (lap !== curLap) {
      /** ③ 交界点两边都要有（否则圈与圈之间裂开一道缝） */
      cur.push(body[i]!)
      laps.push({ lap: curLap, pts: cur })
      cur = [body[i]!]
      curLap = lap
    } else {
      cur.push(body[i]!)
    }
  }
  if (cur.length > 1) laps.push({ lap: curLap, pts: cur })
  return { leadIn, laps, lapLengthM: lapM, startIndex: idx }
}
