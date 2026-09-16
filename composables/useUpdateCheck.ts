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
const CACHE_TTL_MS = 12 * 3600 * 1000
const DISMISS_TTL_MS = 24 * 3600 * 1000

/** 单例状态 */
const state = reactive({
  /** 最新发布 tag（如 "1.1.6"；未查到为空串） */
  latest: '',
  /** 是否发现新版本（比当前版本新） */
  hasUpdate: false,
  checking: false,
})

let started = false

async function checkForUpdate(currentVersion: string): Promise<void> {
  if (!import.meta.client || started || state.checking) return
  started = true
  state.checking = true
  try {
    // 1) 被"忽略"过且未过期 → 不提示
    try {
      const d = Number(localStorage.getItem(DISMISS_KEY) || 0)
      if (d && Date.now() - d < DISMISS_TTL_MS) return
    } catch {
      /* 忽略 */
    }
    // 2) 缓存命中且未过期 → 直接用缓存
    let cached: { at: number; latest: string } | null = null
    try {
      const raw = sessionStorage.getItem(CACHE_KEY)
      if (raw) cached = JSON.parse(raw) as { at: number; latest: string }
    } catch {
      /* 忽略 */
    }
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      state.latest = cached.latest
      state.hasUpdate = isNewerVersion(cached.latest, currentVersion)
      return
    }
    // 3) 查 GitHub 最新 Release（只读，不带任何本机数据）
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return
    const json = (await res.json().catch(() => null)) as { tag_name?: string } | null
    const latest = json?.tag_name ?? ''
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), latest }))
    } catch {
      /* 忽略 */
    }
    state.latest = latest
    state.hasUpdate = isNewerVersion(latest, currentVersion)
  } catch {
    /* 网络失败/被墙 → 静默，不提示 */
  } finally {
    state.checking = false
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
    checkForUpdate: () => checkForUpdate(appVersion.value),
    dismissUpdate,
  }
}
