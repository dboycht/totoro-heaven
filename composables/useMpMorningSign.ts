/**
 * 早操签到 —— `useMpMorningSign()`
 *
 * ## 读取侧
 * 读**任务与点位**（`getMornSignPaper`）。
 * 签到记录端点（`getMornSignArchDetail`）已在契约层与 wrapper 里登记，但**尚无消费者**
 * （页面没做"签到历史"）—— 所以别把注释写成"读了记录"（2026-09-18 审计指出过）。
 *
 * ## ⚠️ 写入侧：`submitMornSign`（2026-09-19 新增，**用户明确要求**）
 * `morningExercises` 的入参是 RSA 加密的 `encryptParams`，其中 `qrCode` 用的是**服务端下发的期望值** ——
 * 而厂商的签到本意是"扫到点位上贴的二维码"，`qrCode` 只是客户端做**本地比对**用的期望值
 * ⇒ 填下发值提交 = **跳过"到场扫码"这一步**（原 `HANDOVER.md §7` 红线）。
 * 因此这部分刻意做成**最窄形态**：**按钮由用户按、只在服务端下发的时段内可点、点一次发一次、
 * 不重试、无定时器、无后台常驻**；界面与文档都如实标注越线性质，不粉饰。
 * 加密与上游请求都在**服务端**（`/api/local/mornsign-submit`）⇒ token 不进浏览器可见状态。
 *
 * 支持范围：与阳光跑一致（共享域 + 无风控校验）。窗口**完全取自服务端返回**（不硬编码）；
 * 实测：同账号连读两次一致、服务端按 token 认人（改 `stuNumber` 参数不影响返回）。
 */
import { MpApiWrapper } from '~/src/wrappers/MpApiWrapper'
import { normalizeMornSignPaper, type MornSignResult } from '~/utils/mp/morningSign'
import type { MornSignSubmitOutcome } from '~/utils/mp/mornSignSubmit'
import { logInfo, logWarn } from './useEventLog'
import { useRealState } from './real/state'
import { useMpSession } from './useMpSession'

export function useMpMorningSign() {
  const { session } = useMpSession()
  const { profile } = useRealState()

  /** 归一化后的签到任务（null = 还没读过） */
  const task = useState<MornSignResult | null>('mpMornSignTask', () => null)
  /** 读取状态（界面据此显示"读取中 / 未开启 / 已读到"） */
  const status = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('mpMornSignStatus', () => 'idle')
  const error = useState('mpMornSignError', () => '')

  const token = () => String(session.value?.token ?? '')

  /** 读签到任务与点位（只读） */
  async function loadMornSignTask(): Promise<boolean> {
    const t = token()
    /**
     * 学号来源优先级：**真实档案（profile）→ 会话里的 userInfo.snCode**。
     * ⚠️ 必须有这个兜底：用户可能"只抓了 token 还没点过读取真实数据"，
     *    此时 profile 为空，但会话里往往已经有 snCode（登录时写入）——
     *    没有兜底就会出现"明明有 token 却提示缺少学号"（2026-09-18 实测踩到）。
     */
    const fromProfile = String(profile.value?.snCode ?? '')
    const fromSession = String(session.value?.userInfo?.snCode ?? '')
    const sn = fromProfile || fromSession
    if (!t || t.startsWith('demo-')) {
      status.value = 'error'
      error.value = '需要真实 token 才能读取早操签到（演示 token 不能查真实数据）'
      return false
    }
    if (!sn) {
      status.value = 'error'
      error.value = '缺少学号（snCode）—— 请先在工作台「一键获取 token」或「读取真实账号与任务」，之后再点「重新读取」'
      return false
    }
    status.value = 'loading'
    error.value = ''
    const res = await MpApiWrapper.getMornSignPaper(
      { stuNumber: sn, token: t },
      { token: t, baseUrl: session.value?.baseUrl },
    )
    if (!res.ok) {
      status.value = 'error'
      error.value = `读取早操签到失败：${res.message}`
      logWarn('real', '读取早操签到任务失败', { message: res.message })
      return false
    }
    const norm = normalizeMornSignPaper(res.data)
    task.value = norm
    if (norm.kind === 'ok') {
      status.value = 'ready'

      logInfo('real', '读到早操签到任务', {
        points: norm.task.signPointList.length,
        need: norm.task.dayNeedSignCount,
        done: norm.task.dayCompSignCount,
        window: `${norm.task.startTime}~${norm.task.endTime}`,
      })
    } else {
      // ⚠️ "本学校无需签到"走这里：**不是错误**，界面按"未开启"展示
      status.value = 'unavailable'

      logInfo('real', '早操签到未开启（服务端明确返回）', { message: norm.message })
    }
    return true
  }

  /**
   * **提交签到**（用户单击触发；**不重试、不自动**）。
   *
   * ⚠️ 这是本项目里**唯一**会"替用户完成签到"的动作，由用户 2026-09-19 明确要求实现，
   *    且刻意做成最窄形态：**按钮由用户按、只发一次、失败不重发**。它跳过了厂商的"扫码"环节
   *    （`qrCode` 用服务端下发的期望值）—— 界面与文档都如实标注了这一点。
   *
   * 加密与上游请求都在**服务端**（`/api/local/mornsign-submit`）：token 不进浏览器可见状态。
   * 成功后会**重读一次任务**，让界面上的"已签/需签"立刻反映真实状态。
   */
  const submitting = useState('mpMornSignSubmitting', () => false)

  async function submitMornSign(pointId: string): Promise<MornSignSubmitOutcome & { ok: boolean }> {
    if (submitting.value) return { accepted: false, message: '正在提交中，请勿重复点击', raw: '', ok: false }
    const t = token()
    const fromProfile = String(profile.value?.snCode ?? '')
    const fromSession = String(session.value?.userInfo?.snCode ?? '')
    const sn = fromProfile || fromSession
    if (!t || t.startsWith('demo-')) return { accepted: false, message: '需要真实 token 才能提交', raw: '', ok: false }
    if (!sn) return { accepted: false, message: '缺少学号（snCode）', raw: '', ok: false }
    if (!pointId) return { accepted: false, message: '请先选择签到点位', raw: '', ok: false }

    submitting.value = true
    try {
      /**
       * 带上该点位的**签到区域配置**（「签到区域编辑」页设置的；没有则服务端用默认圆盘抖动）。
       * ⚠️ 配置只影响**坐标**的生成方式；点位标识（taskId/pointId/qrCode）由服务端从任务里取，**一律原样**。
       */
      const zone = useMornSignZone().get(pointId)
      const res = await $fetch<{
        ok: boolean
        accepted: boolean
        message: string
        raw: string
        pointName?: string
        signDate?: string
      }>('/api/local/mornsign-submit', {
        method: 'POST',
        body: { snCode: sn, token: t, pointId, phoneInfo: navigator?.userAgent, zone },
      })
      logInfo('real', '早操签到提交结果', {
        accepted: res.accepted,
        pointId,
        message: res.message,
        signDate: res.signDate,
      })
      // 成功/失败都重读一次：让"已签 x / 需签 y"与真实状态一致（只读）
      if (res.accepted) {
        await loadMornSignTask()
      }
      return { accepted: res.accepted, message: res.message, raw: res.raw, ok: res.ok }
    } catch (err) {
      const message = (err as Error)?.message || '提交请求失败'
      logWarn('real', '早操签到提交异常', { message, pointId })
      return { accepted: false, message, raw: '', ok: false }
    } finally {
      submitting.value = false
    }
  }

  return { task, status, error, submitting, loadMornSignTask, submitMornSign }
}