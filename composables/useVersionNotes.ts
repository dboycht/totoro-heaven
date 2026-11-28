/**
 * **「版本更新」弹窗的状态层**（2026-11-28）
 *
 * 用户口径："添加一个「版本更新」的弹窗；启动新版本的时候弹窗说明本次更新了什么；
 * 这个文本的内容我自己去写"——文案在 `public/version-notes/<版本>.md`（独立编辑器写），
 * 本文件只管三件事：**读文案、判断该不该弹、记住"这版已看过"**。
 *
 * 判据（用户选的口径"版本号变了才弹一次"）：
 *   · 本机存的"上次看过的版本"≠ 当前运行版本 ⇒ 弹；
 *   · 关掉时把当前版本写进本机（`localStorage` 的 `VERSION_NOTES_SEEN_KEY`）⇒ 同一版本不再弹；
 *   · 判定函数本身在纯模块 `utils/mp/versionNotes.ts` 的 `shouldShowVersionNotes`（有单测）。
 *
 * ⚠️ 为什么不用服务端记"已读"：这是**本机**的阅读状态（换台机器应该再弹一次），
 *    而且它跟版本号一一对应，本机存一个字符串就够了，不需要往服务端写任何东西。
 */
import { parseVersionNotes, shouldShowVersionNotes, type ParsedVersionNotes } from '~/utils/mp/versionNotes'

/** 「上次看过更新说明的版本」存在这里（换机器/清缓存 ⇒ 会再弹一次，符合预期） */
export const VERSION_NOTES_SEEN_KEY = 'totoro_version_notes_seen_v1'

export interface UseVersionNotesReturn {
  /** 当前运行版本（来自 `app.config.ts` → `package.json` 的 version） */
  version: Ref<string>
  /** 弹窗开关 */
  open: Ref<boolean>
  /** 这一版的文案（解析后的块序列） */
  notes: ComputedRef<ParsedVersionNotes>
  /** 文案原文（调试/诊断导出用） */
  raw: Ref<string>
  /** 弹窗关掉时调：把当前版本记成"已看过" */
  markSeen: () => void
}

export function useVersionNotes(): UseVersionNotesReturn {
  const appConfig = useAppConfig()
  const route = useRoute()
  const version = computed(() => String(appConfig.version || ''))
  const seen = ref<string | null>(null)
  const raw = ref('')
  const open = ref(false)
  const notes = computed(() => parseVersionNotes(raw.value))

  const eligible = () =>
    shouldShowVersionNotes({ version: version.value, seenVersion: seen.value, path: route.path })

  /** 读这一版的文案；404/网络错误一律当"没写"（不阻塞启动，绝不因为文案读不到就把应用卡住） */
  const loadNotes = async (): Promise<void> => {
    if (!version.value) return
    try {
      raw.value = (await $fetch(`/version-notes/${version.value}.md`, { responseType: 'text' })) as unknown as string
    } catch {
      raw.value = ''
    }
  }

  onMounted(async () => {
    try {
      seen.value = localStorage.getItem(VERSION_NOTES_SEEN_KEY)
    } catch {
      seen.value = null
    }
    if (!eligible()) return
    await loadNotes()
    open.value = true
  })

  /**
   * 彩蛋页 `/play` 上不弹（那里有自己的开场公告）；解锁后走到正式页面再弹。
   * 所以这里盯路由：一旦离开 `/play` 且这版还没看过 ⇒ 补弹一次。
   */
  watch(
    () => route.path,
    async () => {
      if (open.value || !eligible()) return
      await loadNotes()
      open.value = true
    },
  )

  const markSeen = () => {
    open.value = false
    seen.value = version.value
    try {
      localStorage.setItem(VERSION_NOTES_SEEN_KEY, version.value)
    } catch {
      /* 隐私模式/配额：内存里已记，只影响"下次启动还弹" —— 可静默 */
    }
  }

  return { version, open, notes, raw, markSeen }
}