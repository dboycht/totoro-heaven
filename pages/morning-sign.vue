<template>
  <div>
    <!-- 顶部说明：这是**另一个产品子系统**（与阳光跑并列），只做只读 -->
    <v-alert type="info" variant="flat" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-clock-check-outline</v-icon>早操签到（只读）
      </div>
      <div class="text-body-2">
        这里只帮你<b>看懂签到任务</b>：任务时段、需要签几次、点位在哪、范围多大，以及今天签了几次。
        <b>不会替你提交签到</b> —— 提交需要"人到现场扫码"才能成立（详见下方说明）。
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

          <v-alert type="warning" variant="tonal" density="compact" class="mt-3">
            <div class="font-weight-bold">为什么这里不提供"一键签到"</div>
            <div class="text-caption mt-1">
              厂商的签到靠两件事证明"你人到了现场"：<b>定位落在点位</b>{{ offsetRangeText }}，以及
              <b>你扫到点位上贴的二维码</b>（小程序拿扫码结果与服务端下发的期望值<b>本地比对</b>，不等就报"无效二维码！"）。
              服务端把"期望二维码内容"一起下发给了客户端 —— 直接拿它当"扫码结果"提交，就等于
              <b>跳过"人到现场"这一步</b>，那是利用对方校验的设计缺陷，本项目不做（也与"只做校园跑"的定位不符）。
              <br />所以：<b>二维码请你到现场扫</b>；这个页面负责让你提前知道"什么时候、去哪、签几次"。
            </div>
          </v-alert>
        </template>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 早操签到（**只读**）页 —— 2026-09-18
 *
 * 定位：与「阳光跑」并列的另一个产品子系统（`SYSTEM_PRODUCT-20210615000003`）。
 * **我校（南航）实测返回"本学校无需签到"**，所以本页对多数人是"未开启"；对**需要签到的同学（大一）**，
 * 它把"时段 / 需签次数 / 点位 / 范围"摊开，省得他们翻小程序。
 *
 * ⚠️ **只读红线**：不实现 `morningExercises`（提交）。理由见页面里的提示与
 * `composables/useMpMorningSign.ts` 顶部注释（`qrCode` = 服务端下发的期望值，
 * 拿它当扫码结果提交 = 跳过到场校验；HANDOVER §7）。
 */
import { distanceMeters, mornSignProgressText, type MornSignResult } from '~/utils/mp/morningSign'

const { task: state, status, error, loadMornSignTask } = useMpMorningSign()
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
      let best = Number.POSITIVE_INFINITY
      let name = ''
      for (const p of task.value!.signPointList) {
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

useHead({ title: '早操签到 · 龙猫天堂' })
</script>
