<template>
  <div>
    <!-- 顶部说明：这是**另一个产品子系统**（与阳光跑并列）。
         ⚠️ 2026-09-19 起本页**不再只是只读** —— 加了"提交签到"（用户明确要求）。横幅必须与事实一致，
            否则就是误导（这里刚从"（只读）/ 不会替你提交签到"改成现在的写法）。 -->
    <v-alert type="info" variant="flat" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-clock-check-outline</v-icon>早操签到
      </div>
      <div class="text-body-2">
        这里帮你<b>看懂签到任务</b>：任务时段、需要签几次、点位在哪、范围多大，以及今天签了几次。
        页面下方还有一个<b>「提交签到」</b>按钮（<b>只在时段内可点、由你本人按、点一次发一次</b>）——
        它会<b>跳过"扫码"那一步</b>，性质与注意事项都写在下面，请自己决定用不用。
      </div>
    </v-alert>

    <v-card>
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <span class="text-subtitle-1">签到任务</span>
        <v-chip v-if="status === 'ready'" size="small" color="success" variant="tonal">需要签到</v-chip>
        <v-chip v-else-if="status === 'unavailable'" size="small" variant="tonal">未开启</v-chip>
        <v-spacer />
        <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" :loading="status === 'loading'" @click="reload">
          重新读取
        </v-btn>
      </v-card-title>

      <v-card-text>
        <v-alert v-if="status === 'error'" type="error" variant="tonal" density="compact" class="mb-3">
          {{ error }}
        </v-alert>
        <div v-else-if="status === 'loading'" class="d-flex align-center ga-2 text-body-2">
          <v-progress-circular indeterminate size="18" />正在读取早操签到任务…
        </div>
        <v-alert v-else-if="status === 'idle'" type="info" variant="tonal" density="compact" class="mb-3">
          还没读取。点右上「重新读取」拉一次（需要真实 token 与学号）。
        </v-alert>

        <!-- 未开启：这是**正常返回**（我校实测「本学校无需签到！」），不要当成错误 -->
        <v-alert v-else-if="status === 'unavailable'" type="success" variant="tonal" density="compact" class="mb-3">
          <div class="font-weight-bold">当前账号没有早操签到任务</div>
          <div class="text-caption mt-1">{{ unavailableMessage }}</div>
        </v-alert>

        <template v-else-if="task">
          <v-row dense>
            <v-col cols="12" md="6">
              <v-list density="compact" class="pa-0">
                <v-list-item title="签到时段" :subtitle="task.startTime || '—'" prepend-icon="mdi-clock-start" />
                <v-list-item title="结束时段" :subtitle="task.endTime || '—'" prepend-icon="mdi-clock-end" />
                <v-list-item title="任务有效期" :subtitle="`${task.startDate || '—'} ~ ${task.endDate || '—'}`" prepend-icon="mdi-calendar-range" />
              </v-list>
            </v-col>
            <v-col cols="12" md="6">
              <v-list density="compact" class="pa-0">
                <v-list-item title="今日进度" :subtitle="progressText" prepend-icon="mdi-progress-check" />
                <v-list-item title="允许范围" :subtitle="rangeText" prepend-icon="mdi-map-marker-radius" />
                <v-list-item title="最小间隔" :subtitle="intervalText" prepend-icon="mdi-timer-sand" />
              </v-list>
            </v-col>
          </v-row>

          <div class="d-flex flex-wrap align-center ga-2 mt-3 mb-1">
            <span class="text-subtitle-2">签到点位（{{ task.signPointList.length }} 个）</span>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-crosshairs-gps" :loading="locating" @click="locate">
              定位看距离
            </v-btn>
            <span v-if="myDistanceText" class="text-caption text-medium-emphasis">{{ myDistanceText }}</span>
          </div>
          <v-table density="compact">
            <thead>
              <tr>
                <th>点位</th>
                <th>坐标</th>
                <th>点位 id</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in task.signPointList" :key="p.pointId">
                <td class="text-body-2">{{ p.pointName }}</td>
                <td class="text-caption">{{ p.latitude || '—' }}, {{ p.longitude || '—' }}</td>
                <td class="text-caption text-medium-emphasis">{{ p.pointId || '—' }}</td>
              </tr>
            </tbody>
          </v-table>

          <!-- ⚠️ 提交区：**用户显式要求实现**（2026-09-19），刻意做成最窄形态：
               只在服务端下发的时段内可点、点一次发一次、不重试、没有定时器、没有后台常驻。
               界面如实写明它跳过了"扫码"这一步 —— 不粉饰。 -->
          <v-alert type="warning" variant="tonal" density="compact" class="mt-3">
            <div class="font-weight-bold">关于「提交签到」（本页唯一会写服务器的动作）</div>
            <div class="text-caption mt-1">
              厂商的签到要证明"你人到了现场"：<b>定位落在点位</b>{{ offsetRangeText }} + <b>扫到点位上贴的二维码</b>
              （小程序拿扫码结果与服务端下发的期望值<b>本地比对</b>）。
              下面的提交<b>省掉了"扫码"这一步</b>（用服务端下发的期望值填 `qrCode`）——
              这是应你的要求实现的，页面上标明，不粉饰。
              <br />约束：<b>只在 {{ task.startTime }}–{{ task.endTime }} 内可点</b>、<b>点一次发一次</b>、
              <b>失败不重发</b>、<b>没有定时器、没有后台常驻</b>。
            </div>
          </v-alert>

          <v-row dense class="mt-2">
            <v-col cols="12" md="6">
              <v-select
                v-model="selectedPointId"
                :items="pointItems"
                item-title="title"
                item-value="value"
                label="签到点位"
                density="compact"
                hide-details
                :disabled="submitting"
              />
            </v-col>
            <v-col cols="12" md="6" class="d-flex flex-column justify-center ga-1">
              <v-btn
                color="primary"
                block
                prepend-icon="mdi-map-marker-check"
                :disabled="!canSubmit"
                :loading="submitting"
                @click="confirmOpen = true"
              >
                提交签到
              </v-btn>
              <div class="text-caption" :class="windowState.inside ? 'text-success' : 'text-medium-emphasis'">
                {{ windowState.reason }}
              </div>
            </v-col>
          </v-row>

          <v-alert v-if="lastOutcome" :type="lastOutcome.accepted ? 'success' : 'error'" variant="tonal" density="compact" class="mt-2">
            <div class="font-weight-bold">
              {{ lastOutcome.accepted ? '服务端已接受签到' : '服务端拒绝' }}
              <span v-if="lastPointName" class="text-caption">（{{ lastPointName }}）</span>
            </div>
            <div v-if="lastOutcome.message" class="text-caption mt-1">{{ lastOutcome.message }}</div>
            <v-expansion-panels v-if="lastOutcome.raw" variant="accordion" class="mt-1">
              <v-expansion-panel>
                <v-expansion-panel-title class="text-caption">服务端原始响应</v-expansion-panel-title>
                <v-expansion-panel-text>
                  <pre class="text-caption" style="white-space: pre-wrap; word-break: break-all">{{ lastOutcome.raw }}</pre>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-alert>
        </template>
      </v-card-text>
    </v-card>

    <!-- 显式确认：提交是"替你在服务端记一次到场"，必须由本人点 -->
    <v-dialog v-model="confirmOpen" max-width="520">
      <v-card>
        <v-card-title class="text-subtitle-1">确认提交签到？</v-card-title>
        <v-card-text class="text-body-2">
          <div>账号：<b>{{ accountLabel }}</b></div>
          <div>点位：<b>{{ selectedPointLabel }}</b></div>
          <div>提交时间：<b>{{ previewSignDate }}</b>（真实时间，不做伪造）</div>
          <div class="mt-2 text-warning">
            ⚠️ 这一步<b>不会替你扫码</b>：二维码用的是服务端下发的期望值。
            服务端对"是否本人到场"的判定完全依赖客户端，所以它会照收 —— 这由你决定。
          </div>
          <div class="text-caption mt-1 text-medium-emphasis">只会发送一次，失败不会自动重发。</div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmOpen = false">取消</v-btn>
          <!-- ⚠️ 2026-09-20 审计修复：`loading` 在 Vuetify 3 里**不会禁用按钮**（只置 aria-busy/tabindex=-1）
               ⇒ 这是"会写服务端"的确认按钮，必须同时给 `:disabled`（跑步页的真实提交按钮就是这个写法）。 -->
          <v-btn color="primary" variant="flat" :disabled="submitting" :loading="submitting" @click="doSubmit">
            确认提交
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 早操签到页 —— 2026-09-18 只读版；**2026-09-19 按用户明确要求加了"提交"**
 *
 * 定位：与「阳光跑」并列的另一个产品子系统（`SYSTEM_PRODUCT-20210615000003`）。
 * 页面把"时段 / 需签次数 / 点位 / 范围"摊开；窗口判定**完全用服务端下发的 `startTime/endTime`**，
 * 不硬编码（不同校区/年级可能不同；已实测"同账号连读两次一致、服务端按 token 认人"）。
 *
 * ⚠️ **关于提交（如实标注，不粉饰）**：厂商靠"定位在范围内 + 扫点位二维码"证明人到现场，
 *    而 `qrCode` 是服务端下发的期望值（小程序只做本地比对）⇒ 提交时填下发值就**跳过了扫码**。
 *    这是**用户 2026-09-19 明确要求**的越线实现，刻意做成最窄形态：
 *    **只在窗口内可点、点一次发一次、不重试、无定时器、无后台**。加密与上游请求都在服务端
 *    （`/api/local/mornsign-submit`），token 不进浏览器可见状态。
 */
import { distanceMeters, mornSignProgressText, type MornSignResult } from '~/utils/mp/morningSign'
import { evaluateMornSignWindow, formatShanghaiDateTime } from '~/utils/mp/mornSignSubmit'

const { task: state, status, error, submitting, loadMornSignTask, submitMornSign } = useMpMorningSign()
const { profile: realProfile } = useMpReal()
const showSnackbar = useNotice()

/**
 * 进入本页时**自动读一次**（只读）。
 * ⚠️ 之所以放在页面里而不是导航栏：早操签到导航项是**常驻**的，若在导航栏探测就等于
 * "每次打开应用都白打一次接口"；放在这里 = 只有真正想看的人才产生这次请求。
 */
onMounted(() => {
  if (status.value === 'idle') void loadMornSignTask()
})

/** 归一化结果的窄化：`kind==='ok'` 时才有 task */
const norm = computed(() => state.value)
const task = computed(() => (norm.value?.kind === 'ok' ? norm.value.task : null))
const unavailableMessage = computed(() => (norm.value?.kind === 'unavailable' ? norm.value.message : ''))

const progressText = computed(() => {
  const t = task.value
  if (!t) return '—'
  const base = mornSignProgressText(t)
  const need = Number(t.dayNeedSignCount)
  const done = Number(t.dayCompSignCount)
  if (Number.isFinite(need) && Number.isFinite(done) && done >= need && need > 0) return `${base}（今日已完成）`
  return base
})

const rangeText = computed(() => {
  const r = task.value?.offsetRange ?? ''
  return r ? `${r} 米（圆形范围）` : '—'
})
const offsetRangeText = computed(() => {
  const r = task.value?.offsetRange ?? ''
  return r ? `（本次为 ${r} 米）` : ''
})
const intervalText = computed(() => {
  const v = task.value?.minTimeInterval ?? ''
  if (!v || v === '0') return '—'
  return `${v}（单位以服务端为准，未实测确认）`
})

/**
 * 「离点位多远」——**只在用户主动点击时**才请求定位（不在进入页面时自动弹权限框）。
 *
 * ⚠️ 2026-09-18 审计：这段原本**只写不读**（实现了却没入口、`distanceMeters` 也白导入），
 * 属不可达代码；现在把入口接上（模板里的「定位看距离」按钮）。
 * ⚠️ 定位在**非安全上下文**（HTTP 且非 localhost）不可用 —— 打包成 EXE 后是 `http://localhost`，
 * 属于安全上下文，可用；若用户拒绝授权则给出提示，**不影响查看任务**。
 * ⚠️ 这里**只做提示**：真正"是否在范围内"的校验由服务端按点位坐标 + 范围做，我们不做判断。
 */
const myDistanceText = ref('')
const locating = ref(false)
const locate = () => {
  if (!task.value?.signPointList.length) return
  if (!navigator.geolocation) {
    myDistanceText.value = '本环境不支持定位 —— 不影响查看任务'
    return
  }
  locating.value = true
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locating.value = false
      // ⚠️ 2026-09-19 审计 L1：原用 `task.value!`（异步回调里的非空断言）——
      //    期间若任务被重读/变成"未开启"，这里会抛 TypeError、距离提示静默消失。
      //    改成先取一份快照并判空（拿不到就什么都不做）。
      const list = task.value?.signPointList
      if (!list?.length) return
      let best = Number.POSITIVE_INFINITY
      let name = ''
      for (const p of list) {
        const lat = Number(p.latitude)
        const lng = Number(p.longitude)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        const d = distanceMeters(pos.coords.latitude, pos.coords.longitude, lat, lng)
        if (d < best) {
          best = d
          name = p.pointName
        }
      }
      myDistanceText.value = Number.isFinite(best)
        ? `你离「${name}」约 ${Math.round(best)} 米（仅供参考；是否在范围内由服务端判定）`
        : '点位坐标不完整，算不出距离'
    },
    () => {
      locating.value = false
      myDistanceText.value = '拿不到定位（未授权或本环境不支持）——不影响查看任务'
    },
    { enableHighAccuracy: true, timeout: 8000 },
  )
}

const reload = async () => {
  const ok = await loadMornSignTask()
  if (ok && status.value === 'unavailable') showSnackbar('当前账号没有早操签到任务（服务端明确返回）', 'info')
  else if (ok) showSnackbar('已读取早操签到任务', 'success')
  else showSnackbar(error.value || '读取失败', 'error')
}

// ---------------- 提交（本页唯一会写服务器的动作） ----------------

/** 点位下拉：默认选第一个（服务端返回的顺序） */
const selectedPointId = ref('')
const pointItems = computed(() =>
  (task.value?.signPointList ?? []).map((p) => ({
    title: `${p.pointName || '未命名点位'}（${p.pointId}）`,
    value: p.pointId,
  })),
)
const selectedPoint = computed(() => task.value?.signPointList.find((p) => p.pointId === selectedPointId.value) ?? null)
const selectedPointLabel = computed(() => selectedPoint.value?.pointName || '（未选择）')

/** 任务变化时把选中点位修正到仍存在的那个（第三方也这么做：保留选择，失效则回落第一个） */
watch(
  () => task.value?.signPointList.map((p) => p.pointId).join(','),
  () => {
    const list = task.value?.signPointList ?? []
    if (!list.some((p) => p.pointId === selectedPointId.value)) selectedPointId.value = list[0]?.pointId ?? ''
  },
  { immediate: true },
)

/** 窗口状态：**完全取自服务端下发的 startTime/endTime**，每分钟刷新一次展示 */
const nowTick = ref(Date.now())
const windowState = computed(() => evaluateMornSignWindow(task.value, nowTick.value))
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tickTimer = setInterval(() => (nowTick.value = Date.now()), 30_000)
})
onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
})

/** 能否提交：任务有、点位有、**在窗口内**、未在提交中；另外"今天已签够"就不再允许 */
const alreadyDone = computed(() => {
  const t = task.value
  if (!t) return false
  const need = Number(t.dayNeedSignCount)
  const done = Number(t.dayCompSignCount)
  return Number.isFinite(need) && need > 0 && Number.isFinite(done) && done >= need
})
const canSubmit = computed(
  () => Boolean(task.value && selectedPointId.value) && windowState.value.inside && !alreadyDone.value && !submitting.value,
)

const confirmOpen = ref(false)
const previewSignDate = computed(() => formatShanghaiDateTime(nowTick.value))
const accountLabel = computed(() => {
  const p = realProfile.value
  const sn = String(p?.snCode ?? '')
  return sn ? `${sn}${p?.studentName ? ` ${p.studentName}` : ''}` : '（未读取账号）'
})

/** 最近一次提交结果（如实在界面展示原文） */
const lastOutcome = ref<{ accepted: boolean; message: string; raw: string } | null>(null)
const lastPointName = ref('')

const doSubmit = async () => {
  const pointId = selectedPointId.value
  if (!pointId) return
  confirmOpen.value = false
  /**
   * ⚠️ 2026-09-19 审计 M3：**确认时要复查一次**——用户可能在窗口内打开确认框、拖到窗口外才点确认，
   * 而确认按钮只判"是否正在提交"，`canSubmit` 已不参与 ⇒ 不复查就会发出一次注定被拒的写请求。
   * （服务端端点也补了同样的复查，这里是第一道。）
   */
  if (!windowState.value.inside) {
    lastOutcome.value = { accepted: false, message: `未提交：${windowState.value.reason}`, raw: '' }
    showSnackbar(`未提交：${windowState.value.reason}`, 'warning')
    return
  }
  if (alreadyDone.value) {
    lastOutcome.value = { accepted: false, message: '未提交：今日已签满', raw: '' }
    showSnackbar('未提交：今日已签满', 'warning')
    return
  }
  const res = await submitMornSign(pointId)
  lastOutcome.value = { accepted: res.accepted, message: res.message, raw: res.raw }
  lastPointName.value = selectedPointLabel.value
  if (res.accepted) showSnackbar('服务端已接受签到', 'success')
  // ⚠️ 审计 M8：`ok === false` 表示**本地校验就没发请求**（不是服务端拒绝）—— 提示语必须区分，
  //    否则用户会以为"服务端拒了"，从而去排查服务端/网络方向（误导）。
  else if (!res.ok) showSnackbar(res.message || '未提交（本地校验未通过）', 'warning')
  else showSnackbar(`服务端拒绝：${res.message || '未知原因'}`, 'error')
}

useHead({ title: '早操签到 · 龙猫天堂' })
</script>
