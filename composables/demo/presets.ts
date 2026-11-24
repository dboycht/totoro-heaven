/**
 * **演示模式的「本机预设」**（2026-11-24，演示模式补齐）
 *
 * ## 为什么要有这个文件
 * `enableDemo()` 原先只注入任务与线路，**不写本机路线库** ⇒ 演示模式下：
 *   · 跑步页「开始跑步」是灰的（`canStart` 要求当前任务线路在本机库里配置过）；
 *   · 「真实路径」的预设分组、「随机选一条」、本机真实路径列表全是空的。
 *
 * ## 两条纪律
 *   ① **只进内存**：预设 id 一律 `demo-preset-*`（`DEMO_TRACK_ID_PREFIX`），
 *      `useTrackLibrary.persist()` 落盘时按它剔除；退出演示 / 刷新即消失，真实模式永远看不到。
 *   ② **不碰报文**：演示预设只决定"本机几何"，`lineId` 仍是演示线路 id，
 *      提交口径一个字都不变（守卫 R14 不变）。
 *
 * 数据源在契约层 `src/mp/demo.ts`（纯数据），本文件只做装配（调算法层构造草稿）。
 */
import { DEMO_LINES, DEMO_REAL_PATH_RUNS } from '~/src/mp/demo'
import { buildRealPathPresetDraft, extractOneLap, pathLengthM, type RealPathPoint } from '~/utils/mp/realPath'
import type { LatLng } from '~/utils/mp/routeSimilarity'

/** 一条演示预设的草稿（形状就是 `useTrackLibrary.upsert` 的入参；id 固定、带演示前缀） */
export interface DemoPresetDraft {
  id: string
  lineId: string
  lineName: string
  outer: LatLng[]
  inner: LatLng[]
  presetName: string
  freeShape?: { kind: 'curve'; points: RealPathPoint[] }
  realPath?: {
    date: string
    scoreId: string
    km: number | null
    usedTime: string
    fitDegree: number | null
    sourcePoints: number
    lapLengthM: number | null
    exportedAt: string
  }
}

/** 把一圈点按质心收一点，当"内圈占位几何"（与真实路径草稿同一个思路：外圈够点就行） */
const shrink = (points: LatLng[], ratio: number): LatLng[] => {
  const nums = (Array.isArray(points) ? points : [])
    .map((p) => ({ latitude: Number(p?.latitude), longitude: Number(p?.longitude) }))
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
  if (nums.length < 3) return nums
  const lat = nums.reduce((s, p) => s + p.latitude, 0) / nums.length
  const lng = nums.reduce((s, p) => s + p.longitude, 0) / nums.length
  return nums.map((p) => ({
    latitude: Number((lat + (p.latitude - lat) * ratio).toFixed(6)),
    longitude: Number((lng + (p.longitude - lng) * ratio).toFixed(6)),
  }))
}

/**
 * 演示预设全集（3 条）：
 *   · 1 条手绘跑道 → 环校线（覆盖「程序预设」分组与跑道类界面）；
 *   · 2 条真实路径 → 操场线（覆盖「真实路径」分组与「随机选一条」，两条才有随机意义）。
 * 两条演示线路因此都"配置过" ⇒ 跑步页「开始跑步」可点。
 */
export function demoPresetDrafts(): DemoPresetDraft[] {
  const out: DemoPresetDraft[] = []
  const loopLine = DEMO_LINES[0]
  if (loopLine && loopLine.pointList.length >= 3) {
    out.push({
      id: 'demo-preset-drawn-1',
      lineId: String(loopLine.pointId),
      lineName: String(loopLine.pointName ?? ''),
      outer: loopLine.pointList.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
      inner: shrink(loopLine.pointList, 0.96),
      presetName: '演示 · 环校跑道',
    })
  }
  DEMO_REAL_PATH_RUNS.forEach((run, i) => {
    const points: RealPathPoint[] = run.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))
    const lap = extractOneLap(points, { tolM: 25, minM: 200 })
    const draft = buildRealPathPresetDraft({
      points,
      lineId: String(run.lineId),
      lineName: String(run.lineName),
      presetName: String(run.presetName),
      meta: {
        date: String(run.date),
        scoreId: String(run.scoreId),
        km: run.km,
        usedTime: String(run.usedTime),
        fitDegree: run.fitDegree,
        sourcePoints: points.length,
        lapLengthM: lap.length < points.length ? Math.round(pathLengthM(lap)) : null,
        exportedAt: '2026-11-24T08:00:00.000Z',
      },
    })
    out.push({ id: `demo-preset-real-${i + 1}`, ...draft })
  })
  return out
}
