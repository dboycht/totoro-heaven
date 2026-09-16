/**
 * 「发现新版本」检查（2026-09-16 用户要求：提示"请用新版本、别用老版本"）
 *
 * - 启动后查一次 GitHub 最新 Release（`api.github.com`，6 秒超时、**失败静默**）；
 * - 结果缓存到 sessionStorage（12 小时内不重复请求）；
 * - 只有"最新版 **确实比当前版本新**"才提示；解析失败一律当"没有新版本"（保守，见 version.ts 的测试）；
 * - 用户可「忽略本次」（localStorage 记一天）。
 *
 * ⚠️ 隐私：只向 GitHub API 发一个 GET（不带任何本机数据/token）；失败不影响任何功能。
 */
import { isNewerVersion } from '~/utils/mp/version'

const REPO = 'dboycht/totoro-heaven'
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`
export const REPO_URL = `https://github.com/${REPO}`
const CACHE_KEY = 'totoro_update_check_v1'
const DISMISS_KEY = 'totoro_update_dismiss_v1'
/**
 * 缓存"新鲜期"：超过就**宁可重查**，也不给用户一个旧结论
 * （2026-09-16 教训：原来 12 小时内直接信缓存，会让"刚发布的新版本"在用户界面里显示成旧版本）
 */
const FRESH_MS = 30 * 60 * 1000
const DISMISS_TTL_MS = 24 * 3600 * 1000

/** 单例状态 */
const state = reactive({
  /** 最新发布 tag（如 "1.1.6"；未查到为空串） */
  latest: '',
  /** 是否发现新版本（比当前版本新） */
  hasUpdate: false,
  checking: false,
  /** 检查失败原因（界面直接展示；成功时为空串） */
  error: '',
  /** 上次检查完成时间（毫秒；0 = 还没查过）—— 用缓存时是**缓存时间**，界面才能诚实显示 */
  checkedAt: 0,
  /** 本次结果是否来自缓存（界面据此提示"点立即检测刷新"） */
  fromCache: false,
})

let started = false
let inflight: Promise<void> | null = null

/** 连不上 GitHub 时的提示（用户 2026-09-16 指定要点：检查网络 + 看看是不是有新仓库） */
const CANNOT_CONNECT_HINT =
  '无法连接到 GitHub（可能需要科学上网，或被防火墙/代理拦截）。请检查网络后重试；' +
  '若一直连不上，也请去 GitHub 搜一下本项目名，确认「仓库是否已改名 / 迁移到新仓库」。'

async function runCheck(currentVersion: string, opts: { force?: boolean } = {}): Promise<void> {
  if (!import.meta.client) return
  if (inflight) return inflight // 并发去重：同时只跑一次
  if (!opts.force && started) return // 自动检查每次会话只做一次；手动（force）随时可跑
  state.checking = true
  state.error = ''

  const task = (async () => {
    try {
      if (opts.force) {
        // 手动检测：忽略"已忽略"与缓存，强制重新请求
        try {
          localStorage.removeItem(DISMISS_KEY)
        } catch {
          /* 忽略 */
        }
      } else {
        // 1) 被"忽略"过且未过期 → 不提示（但仍标记已查过）
        try {
          const d = Number(localStorage.getItem(DISMISS_KEY) || 0)
          if (d && Date.now() - d < DISMISS_TTL_MS) {
            state.checkedAt = Date.now()
            return
          }
        } catch {
          /* 忽略 */
        }
        // 2) 缓存命中且未过期 → 直接用缓存（⚠️ 超过 FRESH_MS 视为"陈旧"，宁可重查也不给旧结论）
        let cached: { at: number; latest: string } | null = null
        try {
          const raw = sessionStorage.getItem(CACHE_KEY)
          if (raw) cached = JSON.parse(raw) as { at: number; latest: string }
        } catch {
          /* 忽略 */
        }
        if (cached && Date.now() - cached.at < FRESH_MS) {
          state.latest = cached.latest
          state.hasUpdate = isNewerVersion(cached.latest, currentVersion)
          state.checkedAt = cached.at // ← 用**缓存时间**，界面才能诚实显示"N 分钟前"
          state.fromCache = true
          return
        }
      }

      // 3) 查 GitHub 最新 Release（只读，不带任何本机数据）
      let res: Response
      try {
        res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(8000),
        })
      } catch {
        // 网络层失败（DNS/超时/被拦/断网）
        state.error = CANNOT_CONNECT_HINT
        state.checkedAt = Date.now()
        return
      }
      if (!res.ok) {
        state.error =
          res.status === 404
            ? 'GitHub 上找不到这个仓库（可能已改名 / 迁移到新仓库）。请去 GitHub 搜一下本项目名，确认新仓库地址。'
            : `GitHub 返回 HTTP ${res.status}，暂时无法确认最新版本。请稍后点「立即检测」重试。`
        state.checkedAt = Date.now()
        return
      }
      const json = (await res.json().catch(() => null)) as { tag_name?: string } | null
      const latest = json?.tag_name ?? ''
      if (!latest) {
        state.error = 'GitHub 响应里没有版本号（仓库可能已改名 / 迁移）。请确认新仓库地址。'
        state.checkedAt = Date.now()
        return
      }
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), latest }))
      } catch {
        /* 忽略 */
      }
      state.latest = latest
      state.hasUpdate = isNewerVersion(latest, currentVersion)
      state.checkedAt = Date.now()
      state.fromCache = false
    } finally {
      state.checking = false
      started = true
    }
  })()

  // ⚠️ 必须"先赋值、再在 await 之后清理"：缓存的路径是同步完成的，
  //    若把 inflight=null 写在 task 的 finally 里，会被这行赋值覆盖 → inflight 永远非空
  //    → 之后「立即检测」全部被 `if (inflight) return` 挡掉（2026-09-16 真实 bug）。
  inflight = task
  try {
    await task
  } finally {
    if (inflight === task) inflight = null
  }
}

/** 忽略本次（24 小时内不再提示） */
function dismissUpdate(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    /* 忽略 */
  }
  state.hasUpdate = false
}

export function useUpdateCheck() {
  const appConfig = useAppConfig()
  const appVersion = computed(() => String(appConfig.version || 'dev'))
  return {
    ...toRefs(state),
    appVersion,
    releasesUrl: RELEASES_URL,
    repoUrl: REPO_URL,
    checkForUpdate: () => runCheck(appVersion.value),
    /** 手动「立即检测」：忽略缓存与"已忽略"，强制重新请求 */
    forceCheck: () => runCheck(appVersion.value, { force: true }),
    dismissUpdate,
  }
}
