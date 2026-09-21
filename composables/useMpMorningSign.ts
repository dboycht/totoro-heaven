/**
 * 早操签到 —— `useMpMorningSign()`
 *
 * ## 读取侧
 * 读**任务与点位**（`getMornSignPaper`）+ **本月签到记录**（`getMornSignArchDetail`）。
 * ⚠️ 2026-09-21：记录这条链路此前**读不出数据** —— wrapper 只传了 `stuNumber`（缺 `termId`/`monthId`，
 * 服务端当"没指定学期/月份"⇒ 回空），且页面里没有展示区；现已按厂商口径补齐并加界面（本文件 `loadMornSignArch`）。
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
import {
  buildMornSignArchParams,
  normalizeMornSignArch,
  twoDigitMonth,
  type MornSignArchResult,
} from '~/utils/mp/mornSignArch'
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

  /**
   * 学号来源优先级：**真实档案（profile）→ 会话里的 userInfo.snCode**。
   * ⚠️ 必须有这个兜底：用户可能"只抓了 token 还没点过读取真实数据"，
   *    此时 profile 为空，但会话里往往已经有 snCode（登录时写入）——
   *    没有兜底就会出现"明明有 token 却提示缺少学号"（2026-09-18 实测踩到）。
   */
  const snCodeOf = (): string =>
    String(profile.value?.snCode ?? '') || String(session.value?.userInfo?.snCode ?? '')

  // ---------- 签到记录（本月）----------
  /** 归一化后的记录（null = 还没读过） */
  const arch = useState<MornSignArchResult | null>('mpMornSignArch', () => null)
  const archStatus = useState<'idle' | 'loading' | 'ready' | 'error'>('mpMornSignArchStatus', () => 'idle')
  const archError = useState('mpMornSignArchError', () => '')
  /** 当前查看的月份（两位，如 "09"） */
  const archMonth = useState<string>('mpMornSignArchMonth', () => twoDigitMonth())

  /**
   * 请求代序（2026-09-21 审计修复 B1）：连点「刷新」或连续切月时，**先发的慢响应不许覆盖后发的结果**
   * （否则界面会出现"8 月的标签 + 9 月的数据"这种张冠李戴）。每次请求取一个自增号，回来先比号。
   *
   * ⚠️ 2026-09-21 审计修复（S1）：它必须是**单例**（`useState`），不能是 composable 闭包变量 ——
   * `arch` 等状态是跨实例共享的，而闭包计数器每次调用都从 0 起；组件卸载再挂载时新旧请求可能拿到**相同**的号，
   * 旧实例的慢响应就会覆盖新月份的数据（判据失效）。
   */
  const archReqSeq = useState('mpMornSignArchReqSeq', () => 0)

  /**
   * 读「本月签到记录」（只读）。
   *
   * ⚠️ 2026-09-21 修：此前这条链路**读不出数据** —— ① wrapper 只传了 `stuNumber`（缺 `termId`/`monthId`，
   * 服务端当"没指定"⇒ 回空）；② 页面里根本没有展示区。
   * 现在按厂商口径补齐入参（学期取 `getTermList` 里的当前学期；月份两位），并归一化后给界面。
   *
   * ⚠️ 2026-09-21 审计修复：③ **进函数先清空上一条结果**（否则读失败时会把"上个月的数据"配新月份的标签显示）；
   * ④ **请求代序**（连点/连续切月时，先发的慢响应不许覆盖后发的结果）。
   */
  async function loadMornSignArch(month?: string): Promise<boolean> {
    const t = token()
    const sn = snCodeOf()
    // ③ 清空：失败/竞态时宁可显示"暂无"，也不许拿旧月份的数据冒充新月份
    arch.value = null
    if (!t || t.startsWith('demo-')) {
      archStatus.value = 'error'
      archError.value = '需要真实 token 才能读取签到记录（演示 token 不能查真实数据）'
      return false
    }
    if (!sn) {
      archStatus.value = 'error'
      archError.value = '缺少学号（snCode）—— 请先在工作台「一键获取 token」或「读取真实账号与任务」'
      return false
    }
    // ④ 请求代序：只有"最后一次发起的请求"才有资格写状态
    const seq = ++archReqSeq.value
    archStatus.value = 'loading'
    archError.value = ''
    const options = { token: t, baseUrl: session.value?.baseUrl }
    try {
      // ① 学期 id：与「查询判定」同口径（isActive === "1" 优先，否则取第一个）
      const terms = await MpApiWrapper.getTermList(options)
      const list = (terms.data as { id?: string; isActive?: string | number }[] | undefined) ?? []
      const activeTerm = list.find((x) => String(x.isActive) === '1') ?? list[0]
      const termId = String(activeTerm?.id ?? '')
      if (!termId) {
        if (seq !== archReqSeq.value) return false
        archStatus.value = 'error'
        archError.value = '读不到当前学期（getTermList 返回为空）—— 无法按学期查询记录'
        return false
      }
      // ② 记录：月份必须是两位字符串
      const m = month || archMonth.value
      archMonth.value = m
      const res = await MpApiWrapper.getMornSignArchDetail(buildMornSignArchParams({ snCode: sn, termId, month: m }), options)
      if (seq !== archReqSeq.value) return false // 已被更晚的请求取代，丢弃本次结果
      if (!res.ok) {
        /**
         * ⚠️ 审计修复：`kind === 'empty'` = **信封正常但服务端没下发业务字段** —— 对"该月没有记录"这种情况，
         * 它不是错误（厂商对空月可能就只回一个成功信封）⇒ 按"该月无记录"处理，而不是弹一条看不懂的失败提示。
         */
        if (res.kind === 'empty') {
          arch.value = normalizeMornSignArch({})
          archStatus.value = 'ready'
          archError.value = ''
          logInfo('mornsign', '该月签到记录为空（服务端未下发业务字段）', { month: m })
          return true
        }
        archStatus.value = 'error'
        archError.value = res.message || '读取签到记录失败'
        return false
      }
      arch.value = normalizeMornSignArch(res.data)
      archStatus.value = 'ready'
      logInfo('mornsign', '已读回签到记录', {
        month: m,
        records: arch.value.records.length,
        completed: arch.value.completed,
        required: arch.value.required,
      })
      return true
    } catch (err) {
      if (seq !== archReqSeq.value) return false
      archStatus.value = 'error'
      archError.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

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

  return {
    task,
    status,
    error,
    submitting,
    loadMornSignTask,
    submitMornSign,
    // 🆕 2026-09-21：签到记录（本月）—— 修掉"记录读不出数据"（入参缺 termId/monthId + 页面没做展示）
    arch,
    archStatus,
    archError,
    archMonth,
    loadMornSignArch,
  }
}