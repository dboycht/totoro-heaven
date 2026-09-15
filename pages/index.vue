<template>
  <div>
    <v-alert type="info" variant="flat" class="mb-4" density="comfortable">
      <template #prepend>
        <v-icon>mdi-shield-check-outline</v-icon>
      </template>
      <div class="font-weight-bold">支持范围：共享域 + 无风控校验的学校（运行时自动判定）</div>
      <div class="text-body-2">
        只要同时满足两点即可使用：<br />
        ① 学校与南航<b>共享同一个 API 域</b>（<code>wxxcx.xtotoro.com</code>）——
        独立域/学校专属小程序的学校<b>不支持</b>（那等于另一套后端）；<br />
        ② 该校<b>未开启</b>开场人脸 / 随机抽查 / 摄像头杆校验 ——
        任一开启时门禁会<b>在创建场次前阻止</b>，不会留下无效记录。<br />
        <span class="text-caption">
          当前 {{ verifiedSchoolText }}（我们实测验证过判分口径）；其他学校可以直接用，
          但判分口径未经验证 → 首次提交后请看「记录」页核对是否判为「有效」。
        </span>
      </div>
    </v-alert>

    <v-alert type="info" variant="tonal" class="mb-4" density="comfortable">
      <template #prepend>
        <v-icon>mdi-rocket-launch-outline</v-icon>
      </template>
      <div class="font-weight-bold">使用方式：粘贴 token → 自动读取 → 选线路开跑</div>
      <div class="text-body-2">
        <b>真实流程</b>：把真实 token 粘进来 → 点「读取真实账号与任务」→ 自动校验 token、识别学校、
        读取<b>真实任务约束与真实线路</b> → 在「阳光跑」页选线路开跑（提交前会先过<strong>开跑前门禁</strong>并自检）。<br />
        <b>演示</b>：只是想先看界面/报文、不想碰真实账号时，点「载入演示数据」——数据来自
        <code>src/mp/demo.ts</code>，<b>不发任何网络请求</b>，也不会真实提交。
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
              <v-btn variant="text" prepend-icon="mdi-flask-outline" @click="doEnableDemo">载入演示数据（试界面）</v-btn>
              <v-btn v-if="isLoggedIn" variant="text" prepend-icon="mdi-logout" @click="doLogout">清除会话</v-btn>
            </div>

            <v-chip v-if="isLoggedIn" color="success" variant="tonal" size="small" class="mr-2">
              <v-icon start size="14">mdi-account-check</v-icon>
              真实会话
            </v-chip>
            <v-chip v-if="realStatus === 'ready'" color="success" variant="tonal" size="small">
              <v-icon start size="14">mdi-database-check-outline</v-icon>
              真实任务已就绪
            </v-chip>

            <v-alert v-if="realStatus === 'error'" type="error" variant="tonal" density="compact" class="mt-3">
              {{ realError }}
            </v-alert>
            <v-alert v-else-if="manualToken.trim() && !isRealSession" type="info" variant="tonal" density="compact" class="mt-3">
              已填入 token —— 点「读取真实账号与任务」即可校验并拉取真实数据（自动识别学校；非已验证学校会被拒绝）。
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

            <!-- 未验证学校：只提示"判分口径未实测"，不阻断（**读到档案后才显示**，否则还不知道是哪所学校） -->
            <v-alert v-if="realProfileMasked && realSchoolNotice" type="info" variant="tonal" density="compact" class="mt-3">
              {{ realSchoolNotice }}
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
                :subtitle="cameraFlag === null ? '未读取' : cameraFlag ? '当前选中线路启用（需人到杆附近）' : '当前选中线路未启用'"
                prepend-icon="mdi-video-outline"
              />
            </v-list>
            <v-alert v-if="!gateStatus.allow" type="error" variant="tonal" density="compact" class="mt-2">
              <div class="font-weight-bold">⛔ 开跑前门禁未通过（真实提交会被阻止，不会创建场次）</div>
              <div class="text-body-2">{{ gateStatus.reason }}</div>
              <div v-if="cameraFlagError" class="text-caption mt-1">读取异常：{{ cameraFlagError }}</div>
              <v-btn
                v-if="gateStatus.blockedBy === 'camera_unknown'"
                size="small"
                variant="tonal"
                class="mt-2"
                prepend-icon="mdi-refresh"
                @click="retryCameraFlag()"
              >
                重新读取该线路的开关
              </v-btn>
            </v-alert>
            <v-alert v-else type="success" variant="tonal" density="compact" class="mt-2">
              ✅ 开跑前门禁通过：三项（开场人脸 / 随机抽查 / 摄像头杆）均无阻碍。
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
              <v-list-item title="任务" :subtitle="activeTask?.paperName ?? '—'" prepend-icon="mdi-clipboard-text-outline" />
              <v-list-item title="目标里程" :subtitle="`${activeTask?.mileage ?? '—'} km`" prepend-icon="mdi-map-marker-distance" />
              <v-list-item title="拟合度阈值" :subtitle="String(activeTask?.fitDegree ?? '—')" prepend-icon="mdi-chart-bell-curve" />
              <v-list-item
                title="速度区间"
                :subtitle="`${activeTask?.minSpeed ?? '—'} ~ ${activeTask?.maxSpeed ?? '—'} km/h`"
                prepend-icon="mdi-speedometer"
              />
              <v-list-item
                title="时长区间"
                :subtitle="`${activeTask?.minTime ?? '—'} ~ ${activeTask?.maxTime ?? '—'} 分钟`"
                prepend-icon="mdi-timer-outline"
              />
              <v-list-item title="有效期" :subtitle="activeTask ? formatTaskPeriod(activeTask) : '—'" prepend-icon="mdi-calendar-range" />
              <!-- 线路：按坐标校区分组展示（本校区在前；跨校区标距离），避免"名称看不出是哪个校区" -->
              <template v-if="routeGroups.clusters.length">
                <v-list-item
                  v-for="c in routeGroups.clusters"
                  :key="c.index"
                  :title="c.label"
                  :subtitle="c.routes.map((r) => r.line.pointName).join('、')"
                  :prepend-icon="c.kind === 'home' ? 'mdi-map-marker-check-outline' : 'mdi-map-marker-distance'"
                />
                <v-list-item
                  v-if="routeGroups.inferred"
                  title="分组提示"
                  :subtitle="routeGroups.note"
                  prepend-icon="mdi-alert-circle-outline"
                />
              </template>
              <v-list-item v-else title="线路" :subtitle="lineNames" prepend-icon="mdi-map-outline" />
            </v-list>
            <v-alert v-if="!usingRealTask" type="warning" variant="tonal" density="compact" class="mt-2">
              当前是<b>演示取值</b>。点「读取真实账号与任务」换成真实约束（自动识别学校）。
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
              <li>粘真实 token → 点「<b>读取真实账号与任务</b>」（自动校验 token、识别学校）</li>
              <li>进「<b>阳光跑</b>」页（真实数据已就绪后即为真实链路）</li>
              <li>选线路 → 开始跑步（模拟倍速跑完）→ 看自检 → 点「<b>真实提交</b>」</li>
              <li>提交那一刻会<b>真实等待</b>报备时长（保证时间线一致），完成后自动读判定</li>
            </ol>
            <div class="d-flex flex-column ga-2">
              <v-btn color="primary" block prepend-icon="mdi-run" :disabled="!isLoggedIn && !demoMode" to="/run">进入阳光跑</v-btn>
              <v-btn color="secondary" block variant="tonal" prepend-icon="mdi-format-list-bulleted" to="/records">
                查看记录
              </v-btn>
            </div>
            <v-alert v-if="!isLoggedIn && !demoMode" type="info" variant="tonal" density="compact" class="mt-3">
              先填 token 并读取真实数据，或点「载入演示数据」只试界面（不发请求）。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
import { formatTaskPeriod } from '~/utils/mp/taskRules'
import { VERIFIED_SCHOOLS } from '~/utils/mp/schoolGate'
import { groupRoutesByCampus } from '~/utils/mp/routeGroups'
import { DEMO_SESSION } from '~/src/mp/demo'

const { isLoggedIn, task, session, logout, setTask, setLines, demoMode, enableDemo } = useMpDemo()
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
  gateStatus,
  schoolNotice: realSchoolNotice,
  cameraFlagError,
  retryCameraFlag,
} = useMpReal()
const showSnackbar = inject<(msg: string, color?: string) => void>('showSnackbar', () => {})

/** 已验证学校名单（登记表仅用于"判分口径是否实测过"的提示） */
const verifiedSchoolText = computed(() => {
  const list = VERIFIED_SCHOOLS.filter((s) => s.verified).map((s) => `「${s.schoolName}」（${s.schoolCode}）`)
  return list.length ? `已验证判分口径的学校：${list.join('、')}` : '目前还没有实测验证过的学校'
})

const manualToken = ref('')

const isRealSession = computed(() => Boolean(session.value?.token) && !session.value?.token?.startsWith('demo-'))
/** 跑步页当前用的是真实任务还是演示任务 */
const usingRealTask = computed(() => Boolean(realTask.value))
const activeTask = computed(() => realTask.value ?? task.value)
const lineNames = computed(() => (activeTask.value?.runPointList ?? []).map((line) => line.pointName).join('、') || '—')

/** 线路按校区分组（与跑步页同一套纯函数；用本人校区名识别本校区簇） */
const routeGroups = computed(() =>
  groupRoutesByCampus(activeTask.value?.runPointList ?? [], realProfileMasked.value?.campusName),
)

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

/** 载入演示数据（按需功能：只在"没有真实数据、只想看界面"时用） */
const doEnableDemo = () => {
  enableDemo()
  showSnackbar('已载入演示数据（假数据，不发请求）。读取真实数据时会自动退出演示。', 'info')
}

/** 真实链路：用 token 建会话 → 读账号 + 任务 + 线路 + 开关（成功后自动退出演示） */
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
