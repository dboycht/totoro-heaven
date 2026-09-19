/**
 * 早操签到（`mornSign/*`）的**纯数据层**（2026-09-18 新增）
 *
 * 为什么单独抽出来：响应字段全是"可空字符串"（`null` 也能来），且**"本学校无需签到"是正常返回**——
 * 判定与归一化必须能**离线单测**，不能让页面去猜。
 *
 * ⚠️ 本项目只做**只读**（读任务/点位）；`morningExercises` 那个**写**端点不实现，
 *    原因见 `src/mp/models.ts` 的 `MpMornSignTask` 注释（`qrCode` 是服务端下发的期望值，
 *    拿它当"扫码结果"提交等于跳过"人到现场"的校验 —— HANDOVER §7 红线）。
 */
import type { MpMornSignPoint, MpMornSignTask } from '~/src/mp/types'

/** 归一化结果：要么"该功能未开启"，要么给出完整任务 */
export type MornSignResult =
  | { kind: 'unavailable'; message: string }
  | { kind: 'ok'; task: MpMornSignTask }

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/**
 * 把 `getMornSignPaper` 的响应归一化成 `MornSignResult`。
 *
 * 判定顺序（**实测口径**：我校返回 `message='本学校无需签到！'` + `code:'1'` + `signPointList:null`）：
 *   ① `status !== '00'` ⇒ 调用层失败（这里保守地当作"未开启"并带上原始消息）；
 *   ② `signPointList` 不是非空数组 ⇒ **该学校/该账号未开启签到**，把服务端消息原样透出；
 *   ③ 否则 ⇒ 归一化任务与点位（缺字段给空串，绝不编造）。
 */
export function normalizeMornSignPaper(raw: unknown): MornSignResult {
  const r = (raw ?? {}) as Record<string, unknown>
  const status = str(r.status)
  const message = str(r.message) || str(r.msg)
  const points = Array.isArray(r.signPointList) ? r.signPointList : []

  if (status !== '00') {
    return { kind: 'unavailable', message: message || `接口未返回成功（status=${status || '空'}）` }
  }
  if (points.length === 0) {
    // 我校就是这样：status='00' 但没有任何点位 ⇒ 未开启，不是错误
    return { kind: 'unavailable', message: message || '当前账号没有早操签到任务。' }
  }

  return {
    kind: 'ok',
    task: {
      signType: str(r.signType),
      startDate: str(r.startDate),
      endDate: str(r.endDate),
      startTime: str(r.startTime),
      endTime: str(r.endTime),
      offsetRange: str(r.offsetRange),
      dayNeedSignCount: str(r.dayNeedSignCount) || '0',
      dayCompSignCount: str(r.dayCompSignCount) || '0',
      minTimeInterval: str(r.minTimeInterval) || '0',
      signPointList: points.map((p) => {
        const o = (p ?? {}) as Record<string, unknown>
        return {
          taskId: str(o.taskId),
          pointId: str(o.pointId),
          pointName: str(o.pointName) || '未命名点位',
          latitude: str(o.latitude),
          longitude: str(o.longitude),
          qrCode: str(o.qrCode),
        } satisfies MpMornSignPoint
      }),
    },
  }
}

/** 当日进度文案（`已签 x / 需要 y`；缺值时不硬凑） */
export function mornSignProgressText(task: MpMornSignTask): string {
  const need = Number(task.dayNeedSignCount)
  const done = Number(task.dayCompSignCount)
  if (!Number.isFinite(need) || need <= 0) return `今日已签 ${task.dayCompSignCount || 0} 次`
  return `今日已签 ${Number.isFinite(done) ? done : 0} / ${need} 次`
}

/**
 * 两点球面距离（米，等距近似）——用于"我到点位还有多远"的粗略提示。
 * ⚠️ 只用于**界面提示**；真正的到场校验由服务端按点位坐标+范围做，我们不做任何判断。
 */
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const mPerDegLat = 111320
  const mLng = 111320 * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180))
  return Math.hypot((bLat - aLat) * mPerDegLat, (bLng - aLng) * mLng)
}
