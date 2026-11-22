<template>
  <v-card height="100%">
    <v-card-title class="d-flex align-center">
      <v-icon color="primary" class="mr-2">mdi-account-key-outline</v-icon>
      会话与真实 token
    </v-card-title>
    <v-card-subtitle>真实链路只认 token：留空则走演示数据</v-card-subtitle>
    <v-card-text>
      <v-text-field
        :model-value="manualToken"
        label="真实 token（从抓包的 Authorization: Bearer 后面复制）"
        density="comfortable"
        hint="只存在本机；不打印、不入库、不提交"
        persistent-hint
        class="mb-4"
        @update:model-value="emit('update:manualToken', $event)"
      />

      <div class="d-flex align-center flex-wrap ga-2 mb-3">
        <v-btn
          color="primary"
          prepend-icon="mdi-cloud-download-outline"
          :loading="realStatus === 'loading'"
          @click="emit('load-real')"
        >
          读取真实账号与任务
        </v-btn>
        <v-btn
          color="success"
          prepend-icon="mdi-radar"
          :loading="tokenScanState.running"
          :disabled="isMac"
          @click="emit('token-scan')"
        >
          一键获取 token
        </v-btn>
        <v-btn variant="text" prepend-icon="mdi-flask-outline" @click="emit('enable-demo')">载入演示数据（试界面）</v-btn>
        <v-btn v-if="isLoggedIn" variant="text" prepend-icon="mdi-logout" @click="emit('logout')">清除会话</v-btn>
        <v-btn variant="text" color="warning" prepend-icon="mdi-broom" @click="emit('clear-all')">
          清空本机数据
        </v-btn>
      </div>
      <v-alert v-if="isMac" type="info" variant="tonal" density="compact" class="mt-2">
        Mac 版暂不支持「一键获取 token」（扫描器只支持 Windows 微信客户端）——
        请直接在上面粘贴 token，再点「读取真实账号与任务」。
      </v-alert>

      <!-- 一键获取 token 的状态（扫描中 / 验活 / 就绪 / 失败） -->
      <v-alert
        v-if="tokenScanState.phase === 'scanning' || tokenScanState.phase === 'validating'"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        <div class="d-flex align-center ga-2">
          <v-progress-circular indeterminate size="20" />
          <span>{{ tokenScanState.message }}</span>
        </div>
        <div class="text-caption mt-1">
          请确认：电脑版微信已打开并登录「龙猫体育锻炼」（扫描器只读它自己的进程内存，不需要管理员）。
        </div>
      </v-alert>
      <v-alert
        v-else-if="tokenScanState.phase === 'ready' && acquiredThisVisit"
        type="success"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        ✅ 已获取 token：{{ tokenScanState.masked }} —— 会话已写入，正在读取真实数据…
      </v-alert>
      <v-alert v-else-if="tokenScanState.phase === 'error'" type="error" variant="tonal" density="compact" class="mt-2">
        {{ tokenScanState.message }}
        <div class="text-caption mt-1">
          仍不行就回到「抓包粘贴」路线：Fiddler 抓一条 <code>wxxcx.xtotoro.com</code> 请求，把
          <code>Authorization: Bearer …</code> 粘到上面的输入框。
        </div>
      </v-alert>

      <!-- ⚠️ 2026-09-17 修：这两个徽章原本直接跟在 v-alert 后面（inline 元素紧跟块级提示），
           在"提示文字换行 + 卡片内边距"时会出现<b>徽章压住提示框底边</b>的重叠。
           改成独立一行 flex 容器 + 明确上边距，跟谁都不挤。 -->
      <div v-if="isLoggedIn || realStatus === 'ready'" class="d-flex flex-wrap align-center ga-2 mt-3">
        <v-chip v-if="isLoggedIn" color="success" variant="tonal" size="small">
          <v-icon start size="14">mdi-account-check</v-icon>
          真实会话
        </v-chip>
        <v-chip v-if="realStatus === 'ready'" color="success" variant="tonal" size="small">
          <v-icon start size="14">mdi-database-check-outline</v-icon>
          真实任务已就绪
        </v-chip>
        <!-- 🆕 2026-11-21（用户要求 + 验收口径）：本轮显式获取成功后才给「复制 token」——
             缓存恢复态（重开页面 mp_session 自动恢复）不算"获取到"，不给复制入口；
             🔒 剪贴板是用户自己的传递通道，事件日志只记动作、不含 token 本体，不打印、不落盘的纪律不变 -->
        <v-btn v-if="acquiredThisVisit" size="small" variant="text" prepend-icon="mdi-content-copy" @click="copyToken">
          复制 token
        </v-btn>
      </div>

      <v-alert v-if="realStatus === 'error'" type="error" variant="tonal" density="compact" class="mt-3">
        {{ realError }}
      </v-alert>
      <v-alert v-else-if="manualToken.trim() && !isRealSession" type="info" variant="tonal" density="compact" class="mt-3">
        已填入 token —— 点「读取真实账号与任务」即可校验并拉取真实数据（自动识别学校；非已验证学校会被拒绝）。
      </v-alert>

      <!-- 上次读取的会话：<b>刷新后不自动恢复</b>（默认干净），这里给显式入口。
           📌 2026-09-18 最终语义（用户确认）：**用缓存里的 token 重建会话 → 自动重新读取**
           （账号/任务/线路/开关全部刷新，并沿用上次选中的线路）。token 存在这份缓存里，
           所以即使 `mp_session` 被清（退出登录/清浏览器数据）也能救回来。 -->
      <v-alert v-if="hasCachedTask && !realTask" type="info" variant="tonal" density="compact" class="mt-3">
        <div class="text-body-2">本机存有<b>上次读取的会话</b>：{{ cachedTaskLabel }}</div>
        <div class="text-caption mt-1">
          <template v-if="cacheHasToken">
            已保存 token（<code>{{ cacheTokenMask }}</code>）—— 点下面会用它<b>重建会话并自动重新读取</b>
            （账号 / 任务 / 线路 / 开关全部刷新，并沿用上次选中的线路）。
          </template>
          <template v-else>
            点下面会<b>用本机 token 重新读取一遍</b>（账号 / 任务 / 线路 / 开关全部刷新）。
          </template>
        </div>
        <div v-if="!isRealSession && !cacheHasToken" class="text-caption mt-1 text-warning">
          ⚠️ 本机当前没有可用 token（这份缓存也是旧版本存的、不含 token）——
          <template v-if="isMac">请先粘贴 token 并点「读取真实账号与任务」，之后再点「恢复」</template>
          <template v-else>请先点上方「一键获取 token」，之后再点「恢复」</template>；
          <b>新版本此后会把 token 一起存下来</b>，以后就能一键恢复。
        </div>
        <div class="d-flex flex-wrap ga-2 mt-2">
          <v-btn size="small" variant="tonal" prepend-icon="mdi-history" @click="emit('restore-cached')">
            {{ cacheHasToken ? '恢复（重建会话并读取）' : '恢复（用 token 重新读取）' }}
          </v-btn>
          <!-- ⚠️ 2026-09-19：**删掉这里的第二个「一键获取 token」** ——
               本卡片工具栏里那个是**无条件常显**的（同一个按钮），这里再来一份属**重复元素**（用户指出
               "检查一下别的地方有没有这种重复性元素"）。指引文字保留（把用户指向同一个按钮），
               但不再放第二个按钮。 -->
          <v-btn size="small" variant="text" prepend-icon="mdi-delete-outline" @click="emit('clear-cached')">
            忽略并清除
          </v-btn>
        </div>
      </v-alert>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import type { MpSunrunTask } from '~/src/mp/types'

/** 工作台「会话与真实 token」卡：token 录入 / 读取真实数据 / 一键获取 token / 演示入口 / 上次任务恢复 */
defineProps<{
  manualToken: string
  isLoggedIn: boolean
  realStatus: 'idle' | 'loading' | 'ready' | 'error'
  realError: string
  isRealSession: boolean
  tokenScanState: { running: boolean; phase: 'idle' | 'scanning' | 'validating' | 'ready' | 'error'; message: string; masked: string }
  hasCachedTask: boolean
  cachedTaskLabel: string
  /** 缓存里是否存了 token（决定"恢复"能否真正重建会话）+ 它的掩码（仅供显示） */
  cacheHasToken: boolean
  cacheTokenMask: string
  /** 🆕 2026-11-21：本轮（页面加载以来）是否**显式获取成功**过（读取/恢复/一键获取）——
   *  恢复态（重开页面自动恢复的旧会话）不算 ⇒ 「复制 token」与「已获取」横幅都不出现 */
  acquiredThisVisit: boolean
  realTask: MpSunrunTask | null
}>()

const emit = defineEmits<{
  'update:manualToken': [value: string]
  'load-real': []
  'token-scan': []
  'enable-demo': []
  logout: []
  'clear-all': []
  'restore-cached': []
  'clear-cached': []
}>()

/** 🆕 2026-11-22 Mac 门控：一键获取（内存扫描器）只支持 Windows ⇒ Mac 上按钮灰禁、提示走粘贴路线。
 *  判据来自 UA（SSR 同口径，见 useClientPlatform.ts）——只是 UI 引导，不是安全边界；
 *  服务端 `/api/local/token-scan/start` 另有 `tokenScanSupportedOn(process.platform)` 硬闸。 */
const { isMac } = useClientPlatform()

/** 会话 token（与页面同源：useMpSession 是单例状态）——复制动作取值用；显不显示由 acquiredThisVisit 判 */
const { token: sessionToken } = useMpSession()
const showNotice = useNotice()

/** 复制当前会话 token 到剪贴板（用户 2026-11-21 要求；剪贴板属用户自己的传递通道，
 *  🔒 事件日志只记动作、绝不写 token 本体——「不打印、不落盘」纪律不变） */
const copyToken = async () => {
  const t = sessionToken.value?.trim()
  if (!t) return
  try {
    await navigator.clipboard.writeText(t)
    showNotice('token 已复制到剪贴板', 'success')
    logInfo('ui', '复制 token 到剪贴板（内容不入日志）')
  } catch {
    showNotice('复制失败：浏览器没给剪贴板权限（localhost 下通常可用）', 'error')
  }
}
</script>
