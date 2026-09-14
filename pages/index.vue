<template>
  <div>
    <v-alert type="warning" variant="flat" class="mb-4" density="comfortable">
      <template #prepend>
        <v-icon>mdi-shield-alert-outline</v-icon>
      </template>
      <div class="font-weight-bold">支持范围：目前仅支持「南京航空航天大学」（schoolCode 98765）</div>
      <div class="text-body-2">
        真实打卡链路（读取任务 → 生成轨迹 → 真实提交）<strong>只为南航实现并实测通过</strong>。
        其他学校 —— 尤其是会弹「服务迁移升级通知」并跳转到<strong>学校专属小程序</strong>的学校 ——
        <strong>不在支持范围，请勿使用</strong>。非南航账号读取真实数据时会被直接拒绝。
      </div>
    </v-alert>

    <v-alert type="info" variant="tonal" class="mb-4" density="comfortable">
      <template #prepend>
        <v-icon>mdi-flask-outline</v-icon>
      </template>
      <div class="font-weight-bold">两种模式：演示模式（假数据）/ 真实模式（南航）</div>
      <div class="text-body-2">
        <b>演示模式</b>：数据全部来自 <code>src/mp/demo.ts</code>，只用来试界面，<b>不发任何网络请求</b>。<br />
        <b>真实模式</b>：把真实 token 粘进来 → 点「读取真实账号与任务」→ 拿到<b>真实任务约束与真实线路</b>，
        在「阳光跑」页用真实数据生成轨迹并可<b>真实提交</b>（提交前会先跑一遍自检）。
      </div>
    </v-alert>

    <v-row>
      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="d-flex align-center">
            <v-icon color="primary" class="mr-2">mdi-account-key-outline</v-icon>
            会话与真实 token
          </v-card-title>
          <v-card-subtitle>真实链路只认 token：留空则走演示数据</v-card-subtitle>
          <v-card-text>
            <v-text-field
              v-model="manualToken"
              label="真实 token（从抓包的 Authorization: Bearer 后面复制）"
              density="comfortable"
              hint="只存本机 localStorage；不打印、不入库、不提交"
              persistent-hint
              class="mb-4"
            />

            <div class="d-flex align-center flex-wrap ga-2 mb-3">
              <v-btn
                color="primary"
                prepend-icon="mdi-cloud-download-outline"
                :loading="realStatus === 'loading'"
                @click="doLoadReal"
              >
                读取真实账号与任务
              </v-btn>
              <v-btn variant="text" prepend-icon="mdi-flask-outline" @click="doLogin">只用演示数据</v-btn>
              <v-btn v-if="isLoggedIn" variant="text" prepend-icon="mdi-logout" @click="doLogout">清除会话</v-btn>
            </div>

            <v-chip v-if="isLoggedIn" :color="isRealSession ? 'success' : 'accent'" variant="tonal" size="small" class="mr-2">
              <v-icon start size="14">{{ isRealSession ? 'mdi-account-check' : 'mdi-flask-outline' }}</v-icon>
              {{ isRealSession ? '真实会话' : '演示会话' }}
            </v-chip>
            <v-chip v-if="realStatus === 'ready'" color="success" variant="tonal" size="small">
              <v-icon start size="14">mdi-database-check-outline</v-icon>
              真实任务已就绪
            </v-chip>

            <v-alert v-if="realStatus === 'error'" type="error" variant="tonal" density="compact" class="mt-3">
              {{ realError }}
            </v-alert>
            <v-alert v-else-if="manualToken.trim() && !isRealSession" type="info" variant="tonal" density="compact" class="mt-3">
              已填入 token —— 点「读取真实账号与任务」即可拉取真实数据（仅南航）。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="d-flex align-center flex-wrap ga-2">
            <v-icon color="secondary" class="mr-2">mdi-account-details-outline</v-icon>
            真实账号
            <v-spacer />
            <v-btn
              v-if="realStatus === 'ready'"
              size="small"
              variant="text"
              prepend-icon="mdi-refresh"
              :loading="realStatus === 'loading'"
              @click="doLoadReal"
            >
              刷新任务
            </v-btn>
          </v-card-title>
          <v-card-text>
            <template v-if="realProfileMasked">
              <v-list density="compact">
                <v-list-item title="学号 / 姓名" :subtitle="`${realProfileMasked.snCode} · ${realProfileMasked.studentName}`" prepend-icon="mdi-card-account-details-outline" />
                <v-list-item title="学校" :subtitle="realProfileMasked.schoolName" prepend-icon="mdi-school-outline" />
                <v-list-item title="校区（campusId）" :subtitle="realProfileMasked.campusId" prepend-icon="mdi-map-marker-outline" />
                <v-list-item title="班级" :subtitle="realProfileMasked.className || '—'" prepend-icon="mdi-account-group-outline" />
              </v-list>
            </template>
            <v-alert v-else type="info" variant="tonal" density="compact">
              还没读取真实账号。填入 token 后点左侧「读取真实账号与任务」。
            </v-alert>

            <v-divider class="my-3" />
            <div class="text-caption text-medium-emphasis mb-2">一票否决项（真实数据读取后自动查）</div>
            <v-list density="compact">
              <v-list-item
                title="开场人脸 sunrunStartFace"
                :subtitle="switchText(realSwitches?.sunrunStartFace, '开启（需实时拍脸）', '关闭')"
                prepend-icon="mdi-camera-outline"
              />
              <v-list-item
                title="随机抽查 sunrunPointRandom"
                :subtitle="switchText(realSwitches?.sunrunPointRandom, '开启（跑动中可能弹脸）', '关闭')"
                prepend-icon="mdi-shuffle-variant"
              />
              <v-list-item
                title="摄像头杆 getCameraConfig.flag"
                :subtitle="cameraFlag === null ? '未读取' : cameraFlag ? '该线路启用（需人到杆附近）' : '该线路未启用'"
                prepend-icon="mdi-video-outline"
              />
            </v-list>
            <v-alert v-if="realSwitches?.sunrunStartFace === '1' || realSwitches?.sunrunPointRandom === '1'" type="warning" variant="tonal" density="compact" class="mt-2">
              学校开启了人脸校验：随机抽查无法本地完成，必须真人配合；请谨慎使用。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row class="mt-1">
      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1 d-flex align-center">
            <v-icon color="primary" class="mr-2">mdi-run-fast</v-icon>
            任务与约束
            <v-chip class="ml-2" size="x-small" :color="usingRealTask ? 'success' : 'accent'" variant="tonal">
              {{ usingRealTask ? '真实' : '演示' }}
            </v-chip>
          </v-card-title>
          <v-card-text>
            <v-list density="compact">
              <v-list-item title="任务" :subtitle="activeTask.paperName" prepend-icon="mdi-clipboard-text-outline" />
              <v-list-item title="目标里程" :subtitle="`${activeTask.mileage} km`" prepend-icon="mdi-map-marker-distance" />
              <v-list-item title="拟合度阈值" :subtitle="String(activeTask.fitDegree)" prepend-icon="mdi-chart-bell-curve" />
              <v-list-item
                title="速度区间"
                :subtitle="`${activeTask.minSpeed ?? '—'} ~ ${activeTask.maxSpeed ?? '—'} km/h`"
                prepend-icon="mdi-speedometer"
              />
              <v-list-item
                title="时长区间"
                :subtitle="`${activeTask.minTime ?? '—'} ~ ${activeTask.maxTime ?? '—'} 分钟`"
                prepend-icon="mdi-timer-outline"
              />
              <v-list-item title="有效期" :subtitle="formatTaskPeriod(activeTask)" prepend-icon="mdi-calendar-range" />
              <v-list-item title="线路" :subtitle="lineNames" prepend-icon="mdi-map-outline" />
            </v-list>
            <v-alert v-if="!usingRealTask" type="warning" variant="tonal" density="compact" class="mt-2">
              当前是<b>演示取值</b>。点「读取真实账号与任务」换成南航真实约束。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1 d-flex align-center">
            <v-icon color="accent" class="mr-2">mdi-rocket-launch-outline</v-icon>
            下一步
          </v-card-title>
          <v-card-text>
            <ol class="text-body-2 mb-3 pl-4">
              <li>粘真实 token → 点「<b>读取真实账号与任务</b>」</li>
              <li>进「<b>阳光跑</b>」页，把模式切到「<b>真实模式</b>」</li>
              <li>选线路 → 开始跑步（模拟倍速跑完）→ 看自检 → 点「<b>真实提交</b>」</li>
              <li>提交那一刻会<b>真实等待</b>报备时长（保证时间线一致），完成后自动读判定</li>
            </ol>
            <div class="d-flex flex-column ga-2">
              <v-btn color="primary" block prepend-icon="mdi-run" :disabled="!isLoggedIn" to="/run">进入阳光跑</v-btn>
              <v-btn color="secondary" block variant="tonal" prepend-icon="mdi-format-list-bulleted" to="/records">
                查看记录（{{ records.length }} 条演示记录）
              </v-btn>
            </div>
            <v-alert v-if="!isLoggedIn" type="info" variant="tonal" density="compact" class="mt-3">
              先填 token 并读取真实数据，或点「只用演示数据」。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
import { formatTaskPeriod } from '~/utils/mp/taskRules'
import { DEMO_SESSION } from '~/src/mp/demo'

const { isLoggedIn, task, records, session, login, logout, setTask, setLines } = useMpDemo()
const {
  profileMasked: realProfileMasked,
  task: realTask,
  realLines,
  status: realStatus,
  error: realError,
  switches: realSwitches,
  cameraFlag,
  loadRealData,
  restoreTaskFromCache,
} = useMpReal()
const showSnackbar = inject<(msg: string, color?: string) => void>('showSnackbar', () => {})

const manualToken = ref('')

const isRealSession = computed(() => Boolean(session.value?.token) && !session.value?.token?.startsWith('demo-'))
/** 跑步页现在用的是真实任务还是演示任务 */
const usingRealTask = computed(() => Boolean(realTask.value) && task.value.paperName === realTask.value?.paperName)
const activeTask = computed(() => (usingRealTask.value && realTask.value ? realTask.value : task.value))
const lineNames = computed(() => (activeTask.value.runPointList ?? []).map((line) => line.pointName).join('、') || '—')

const switchText = (value: string | undefined, on: string, off: string) =>
  value === undefined ? '未读取' : value === '1' ? on : off

onMounted(() => {
  restoreTaskFromCache()
  // 已存过真实 token 时，自动把缓存任务注入跑步页
  if (realTask.value) {
    setTask(realTask.value)
    if (realLines.value.length) setLines(realLines.value)
  }
})

/** 只用演示数据：写入假会话 */
const doLogin = () => {
  login({})
  showSnackbar('已切到演示模式（假数据，不发请求）', 'info')
}

/** 真实链路：用 token 建会话 → 读账号 + 任务 + 线路 + 开关 */
const doLoadReal = async () => {
  const token = manualToken.value.trim()
  if (token) {
    session.value = {
      token,
      baseUrl: session.value?.baseUrl ?? DEMO_SESSION.baseUrl,
      userInfo: session.value?.userInfo,
    }
  }
  const ok = await loadRealData()
  if (ok) {
    const t = realTask.value!
    setTask(t)
    if (realLines.value.length) setLines(realLines.value)
    showSnackbar(`真实数据已就绪：${t.paperName}（${t.runPointList?.length ?? 0} 条线路）`, 'success')
  } else {
    showSnackbar(realError.value || '读取失败', 'error')
  }
}

const doLogout = () => {
  logout()
  showSnackbar('会话已清除', 'info')
}
</script>
