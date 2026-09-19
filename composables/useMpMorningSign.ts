/**
 * 早操签到（**只读侧**）—— `useMpMorningSign()`
 *
 * 只做两件事：读签到任务与点位（`getMornSignPaper`）、读签到记录（`getMornSignArchDetail`）。
 *
 * ⚠️ **不实现任何写操作**（`morningExercises`）：该端点的入参是 RSA 加密的 `encryptParams`，
 *    里面要求填 `qrCode` —— 而 `qrCode` 是**服务端下发的期望值**，小程序拿"你扫到的码"与它做
 *    **本地字符串比对**来证明"人到了现场"。把下发值当扫码结果提交 = 跳过到场校验，
 *    属 `HANDOVER.md §7` 的「不使用服务端漏洞」红线（同结论见 `第三方9_17-早签模块分析.md` §5.2/§11）。
 *
 * 支持范围：与阳光跑一致（共享域 + 无风控校验）。**我校实测返回"本学校无需签到"**，
 * 因此本模块的定位是"给需要签到的同学看任务"（大一），不需要的人会看到明确的"未开启"提示。
 */
import { MpApiWrapper } from '~/src/wrappers/MpApiWrapper'
import { normalizeMornSignPaper, type MornSignResult } from '~/utils/mp/morningSign'
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
  /** 上次读取时刻（毫秒） */
  const loadedAt = useState('mpMornSignLoadedAt', () => 0)
  /**
   * 本账号是否需要签到（**供导航项决定是否显示**）。
   * 只在真正读过一次之后才为 true，避免给不需要的人加导航项。
   */
  const required = useState('mpMornSignRequired', () => false)

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
    loadedAt.value = Date.now()
    if (norm.kind === 'ok') {
      status.value = 'ready'
      required.value = true
      logInfo('real', '读到早操签到任务', {
        points: norm.task.signPointList.length,
        need: norm.task.dayNeedSignCount,
        done: norm.task.dayCompSignCount,
        window: `${norm.task.startTime}~${norm.task.endTime}`,
      })
    } else {
      // ⚠️ "本学校无需签到"走这里：**不是错误**，界面按"未开启"展示
      status.value = 'unavailable'
      required.value = false
      logInfo('real', '早操签到未开启（服务端明确返回）', { message: norm.message })
    }
    return true
  }

  return { task, status, error, loadedAt, required, loadMornSignTask }
}
