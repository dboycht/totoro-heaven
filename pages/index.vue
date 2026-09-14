<template>
  <div>
    <v-alert type="info" variant="tonal" class="mb-4" density="comfortable">
      <template #prepend>
        <v-icon>mdi-flask-outline</v-icon>
      </template>
      <div class="font-weight-bold">演示模式（Mock 数据）</div>
      <div class="text-body-2">
        当前页面用的是<b>编造的演示数据</b>：登录、任务约束、历史成绩都来自
        <code>src/mp/demo.ts</code>；跑步过程只用真实算法算轨迹与拟合度，<b>不发任何网络请求</b>。
        9-14 拿到真实 token 与任务后，按右侧「真实数据接入点」逐条替换即可，页面不用改。
      </div>
    </v-alert>

    <v-row>
      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="d-flex align-center">
            <v-icon color="primary" class="mr-2">mdi-school-outline</v-icon>
            选择学校并登录
          </v-card-title>
          <v-card-subtitle>
            真实链路：getSunRunSchoolList → resolveSchoolBaseUrl → token
          </v-card-subtitle>
          <v-card-text>
            <v-select
              v-model="schoolCode"
              :items="schoolItems"
              item-title="label"
              item-value="value"
              label="学校"
              density="comfortable"
              class="mb-2"
            />
            <v-alert v-if="currentSchool && !currentSchool.supported" type="warning" variant="tonal" density="compact" class="mb-3">
              该校会自动跳转到「学校专属小程序」，本项目明确不支持（只做「龙猫体育锻炼」入口）。
            </v-alert>

            <v-text-field v-model="snCode" label="学号（演示占位）" density="comfortable" class="mb-2" />
            <v-text-field v-model="studentName" label="姓名（演示占位）" density="comfortable" class="mb-2" />
            <v-text-field
              v-model="manualToken"
              label="真实 token（可选：拿到后粘这里）"
              density="comfortable"
              hint="留空则用演示 token；真实 token 只存本机 localStorage，不入库"
              persistent-hint
              class="mb-4"
            />

            <div class="d-flex align-center flex-wrap ga-2">
              <v-btn color="primary" prepend-icon="mdi-login-variant" @click="doLogin">演示登录</v-btn>
              <v-btn v-if="isLoggedIn" variant="text" prepend-icon="mdi-logout" @click="doLogout">清除会话</v-btn>
              <v-chip v-if="isLoggedIn" color="success" variant="tonal" size="small">
                <v-icon start size="14">mdi-check-circle-outline</v-icon>
                会话已就绪
              </v-chip>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="d-flex align-center">
            <v-icon color="secondary" class="mr-2">mdi-swap-horizontal-bold</v-icon>
            真实数据接入点
          </v-card-title>
          <v-card-subtitle>拿到真实数据后，只改这些地方</v-card-subtitle>
          <v-card-text>
            <v-list density="compact">
              <v-list-item
                v-for="point in swapPoints"
                :key="point.title"
                :prepend-icon="point.icon"
                :title="point.title"
                :subtitle="point.detail"
              />
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row class="mt-1">
      <v-col cols="12" md="4">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1 d-flex align-center">
            <v-icon color="primary" class="mr-2">mdi-run-fast</v-icon>
            任务与约束
          </v-card-title>
          <v-card-text>
            <v-list density="compact">
              <v-list-item title="任务" :subtitle="task.paperName" prepend-icon="mdi-clipboard-text-outline" />
              <v-list-item title="目标里程" :subtitle="`${task.mileage} km`" prepend-icon="mdi-map-marker-distance" />
              <v-list-item title="拟合度阈值" :subtitle="String(task.fitDegree)" prepend-icon="mdi-chart-bell-curve" />
              <v-list-item title="有效期" :subtitle="formatTaskPeriod(task)" prepend-icon="mdi-calendar-range" />
              <v-list-item title="线路" :subtitle="lineNames" prepend-icon="mdi-map-outline" />
            </v-list>
            <v-alert type="warning" variant="tonal" density="compact" class="mt-2">
              演示取值；真实约束来自 <code>getSunrunPaper</code>（字段名已实测，取值待 9-14）。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="4">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1 d-flex align-center">
            <v-icon :color="switches.faceRegistered ? 'success' : 'error'" class="mr-2">mdi-face-recognition</v-icon>
            人脸与抽查
          </v-card-title>
          <v-card-text>
            <v-list density="compact">
              <v-list-item
                title="人脸建档（服务端硬门槛）"
                :subtitle="switches.faceRegistered ? '已建档 —— 之后 faceBase64 可留空' : '未建档 —— getRunBegin 返回 code:888'"
                prepend-icon="mdi-account-check-outline"
              />
              <v-list-item
                title="开场人脸 sunrunStartFace"
                :subtitle="switches.sunrunStartFace === '1' ? '开启（需实时拍脸）' : '关闭'"
                prepend-icon="mdi-camera-outline"
              />
              <v-list-item
                title="随机抽查 sunrunPointRandom"
                :subtitle="switches.sunrunPointRandom === '1' ? '开启（跑动中可能弹脸）' : '关闭'"
                prepend-icon="mdi-shuffle-variant"
              />
            </v-list>
            <v-alert type="warning" variant="tonal" density="compact" class="mt-2">
              9-14 任务下发后必须复验这两个开关（30 秒，一票否决项）。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="4">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1 d-flex align-center">
            <v-icon color="accent" class="mr-2">mdi-rocket-launch-outline</v-icon>
            下一步
          </v-card-title>
          <v-card-text>
            <div class="text-body-2 mb-3">
              演示流程：登录 → 阳光跑（调「模拟倍速」几十秒跑完 3km）→ 结算看提交报文 → 记录页看成绩。
            </div>
            <div class="d-flex flex-column ga-2">
              <v-btn color="primary" block prepend-icon="mdi-run" :disabled="!isLoggedIn" to="/run">进入阳光跑</v-btn>
              <v-btn color="secondary" block variant="tonal" prepend-icon="mdi-format-list-bulleted" to="/records">
                查看记录（{{ records.length }} 条）
              </v-btn>
            </div>
            <v-alert v-if="!isLoggedIn" type="info" variant="tonal" density="compact" class="mt-3">
              先点左侧「演示登录」。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
import { DEMO_SCHOOLS } from '~/src/mp/demo'
import { formatTaskPeriod } from '~/utils/mp/taskRules'

const { isLoggedIn, task, switches, records, session, login, logout } = useMpDemo()
const showSnackbar = inject<(msg: string, color?: string) => void>('showSnackbar', () => {})

const schoolCode = ref(DEMO_SCHOOLS[0]!.schoolCode)
const snCode = ref('DEMO2026001')
const studentName = ref('演示同学')
const manualToken = ref('')

const schoolItems = DEMO_SCHOOLS.map((school) => ({
  value: school.schoolCode,
  label: `${school.schoolName}（${school.schoolCode}）`,
}))

const currentSchool = computed(() => DEMO_SCHOOLS.find((school) => school.schoolCode === schoolCode.value))
const lineNames = computed(() => (task.value.runPointList ?? []).map((line) => line.pointName).join('、') || '—')

/** 真实数据接入点（与 src/mp/demo.ts 文件头的表一一对应） */
const swapPoints = [
  { icon: 'mdi-key-outline', title: '① token', detail: '演示 token → 真实 token（粘贴 / 微信 code 换）' },
  { icon: 'mdi-dns-outline', title: '② 学校基址', detail: '共享域 → resolveSchoolBaseUrl(schoolCode) 的 domainUrl' },
  { icon: 'mdi-clipboard-text-outline', title: '③ 任务约束', detail: 'DEMO_TASK → getSunrunPaper 的 getSunrunPaperResponseList[0]' },
  { icon: 'mdi-map-marker-path', title: '④ 官方路线点列', detail: 'DEMO_LINES → 任务的 runPointList[].pointList' },
  { icon: 'mdi-face-recognition', title: '⑤ 人脸 / 抽查开关', detail: 'DEMO_SWITCHES → selectSunRunStartConfiguration 的 body' },
  { icon: 'mdi-format-list-numbered', title: '⑥ 历史成绩', detail: 'DEMO_RECORDS → getSunrunArch 的 data[] + 汇总字段' },
]

const doLogin = () => {
  login({
    snCode: snCode.value.trim() || 'DEMO2026001',
    studentName: studentName.value.trim() || '演示同学',
    schoolCode: schoolCode.value,
    schoolName: currentSchool.value?.schoolName ?? '演示学校',
  })
  if (manualToken.value.trim()) {
    session.value = { ...(session.value || { token: '' }), token: manualToken.value.trim() }
  }
  showSnackbar(manualToken.value.trim() ? '已用真实 token 建立会话（其余仍是演示数据）' : '演示登录完成', 'success')
}

const doLogout = () => {
  logout()
  showSnackbar('会话已清除', 'info')
}
</script>
