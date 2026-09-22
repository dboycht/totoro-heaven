<template>
  <div>
    <RunGateNotice :gate-status="gateStatus" :is-logged-in="isLoggedIn" />

    <v-card class="mb-4" variant="tonal">
      <v-card-text class="d-flex align-center flex-wrap ga-3 py-2">
        <v-chip :color="realReady ? 'success' : demoMode ? 'accent' : 'warning'" size="small" variant="tonal">
          <v-icon start size="14">{{ realReady ? 'mdi-database-check-outline' : 'mdi-alert-outline' }}</v-icon>
          {{ realReady ? `真实任务：${activeTask?.paperName ?? ''}` : '未读取真实数据' }}
        </v-chip>
        <v-chip v-if="demoMode" color="accent" size="small" variant="tonal">
          <v-icon start size="14">mdi-flask-outline</v-icon>
          演示数据（不发任何请求）
        </v-chip>
        <v-spacer />
        <!-- 演示是「按需功能」：只在没有真实任务时提供一个入口，不再作为顶层模式 -->
        <v-btn v-if="!realReady" size="small" variant="text" prepend-icon="mdi-flask-outline" @click="doEnableDemo">
          载入演示数据
        </v-btn>
        <span v-if="realReady" class="text-caption text-medium-emphasis">
          学校：{{ realProfile?.schoolName ?? '—' }}（{{ realProfile?.schoolCode ?? '—' }}）
        </span>
      </v-card-text>
    </v-card>

    <v-row>
      <v-col cols="12" md="8">
        <RunMetricsCard
          :active-task="activeTask"
          :run="run"
          :status-text="statusText"
          :status-color="statusColor"
          :pace-text="paceText"
          :fit-class="fitClass"
          :progress="progress"
        />
      </v-col>

      <v-col cols="12" md="4">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1">开跑设置</v-card-title>
          <v-card-text>
            <!-- 当前跑法由 URL（分组内的小标签）决定：只做**说明**，切换用上方标签或顶部导航 -->
            <div class="d-flex align-center flex-wrap ga-2 mb-2">
              <v-icon size="small" color="primary">{{ isFreeRun ? 'mdi-run' : 'mdi-white-balance-sunny' }}</v-icon>
              <!-- ⚠️ 用 `text-no-wrap`：此前"当前模式：自由跑"在窄列里被拆成两行（"自由/跑"），很难看 -->
              <span class="text-body-2 font-weight-bold text-no-wrap">当前模式：{{ isFreeRun ? '自由跑' : '阳光跑' }}</span>
              <span class="text-caption text-medium-emphasis">（切换用上方标签）</span>
            </div>

            <!-- ⚠️ 自由跑的**提交口径**（2026-09-18 按厂商源码落地，**不能改**）：
                 厂商在自由跑时 `0==runType && (取线路)` 根本不执行 ⇒ paperId/lineId 都是空串、
                 不带任务号、也不需要打卡/自查那三项开关校验。
                 ⚠️ 但**本机生成轨迹仍要一条几何**（且只允许用你自己描的跑道，见 runner.start 的注释），
                 所以 2026-09-20 起自由跑**也能选线路** —— 选的只是"本地用哪条几何"，
                 **提交报文里依旧不带 lineId/paperId**（`buildScoreRequest` 的 freeRun 分支强制为空，
                 与此处的选择无关；有单测钉住这一点）。 -->
            <v-alert v-if="isFreeRun" type="info" variant="tonal" density="compact" class="mb-2">
              自由跑<b>不带任务号、不校验打卡开关、不计入阳光跑成绩</b>（与小程序一致）。
              下面选的线路<b>只决定本机用哪条几何生成轨迹</b>（仍然只允许用你自己描过的跑道），
              <b>不会</b>被写进提交报文 —— 提交时线路标识一律为空。
              跑到<b>你设的目标距离</b>或你点「结束并结算」即止。
            </v-alert>
            <v-select
              v-model="run.lineId"
              :items="lineItems"
              item-title="title"
              item-value="value"
              :label="routeIsFree ? '线路（服务端未下发线路 —— 本任务不指定路线）' : isFreeRun ? '线路（只影响本地轨迹几何）' : '线路（按校区自动分组，本校区优先）'"
              density="comfortable"
              :disabled="isBusy || routeIsFree"
              class="mb-2"
            />
            <!-- 🆕 2026-09-22（issue #12）：服务端**未下发线路**时把下拉停用并就地说明 ——
                 不再让"下拉为空"被误读成"你还没描跑道"。措辞只用客观事实（"未下发"），
                 不写成"服务端不判路线"（我们无法证明服务端判定时怎么做）。 -->
            <div v-if="routeIsFree" class="text-caption text-medium-emphasis mb-2">
              本任务<b>服务端未下发线路</b>（不指定路线）—— 线路下拉已停用；轨迹将用你<b>本机已有的跑道几何</b>生成。
            </div>
            <!-- 跨校区提示：选了别的校区的线路（按坐标判定，不看名称） -->
            <v-alert v-if="crossCampusWarning" type="warning" variant="tonal" density="compact" class="mb-2">
              {{ crossCampusWarning }}
            </v-alert>
            <div v-if="routeGroups.clusters.length > 1" class="text-caption text-medium-emphasis mb-2">
              {{ routeGroups.note }}
            </div>

            <!-- 🆕 自由跑目标距离（1.1.12 需求①）：阳光跑不显示这一块（里程由任务决定） -->
            <div v-if="isFreeRun" class="mb-3">
              <v-alert v-if="freeRunBlocked" type="warning" variant="tonal" density="compact" class="mb-2">
                <div class="font-weight-bold">
                  <v-icon class="mr-1" size="18">mdi-alert-circle-outline</v-icon>本机记录：你所在学校未开通「自由跑任务」
                </div>
                <div class="text-body-2 mt-1">
                  自由跑的真实提交会被服务端拒绝（原话「暂无自由跑任务,请选择阳光跑!」），所以这里已把「真实提交」标灰。
                  自由跑仍可用于<b>本地模拟与预览</b>；阳光跑不受影响。
                </div>
                <v-btn size="x-small" variant="text" class="mt-1" @click="clearFreeRunUnsupported()">
                  仍要试一次（清除此标记）
                </v-btn>
              </v-alert>
              <!-- ⚠️ 2026-09-21 实测提示（用户要求"把提示提前"）：自由跑的真实提交由**服务端**按学校/账号判定，
                   实测厂商回 `暂无自由跑任务,请选择阳光跑!`（已核对厂商源码：自由跑就是 runType=1 + 空线路标识，
                   并不去取什么"自由跑任务"，所以补不了 paperId）⇒ **开跑前就说清**，别让人以为是自己操作错了。 -->
              <v-alert v-else type="info" variant="tonal" density="compact" class="mb-2">
                自由跑的真实提交需要<b>学校开通「自由跑任务」</b>（由服务端判定）。若你所在学校未开通，
                开跑时服务端会回「暂无自由跑任务,请选择阳光跑!」——此时自由跑仍可用于<b>本地模拟与预览</b>，阳光跑不受影响。
              </v-alert>
              <v-text-field
                v-model="freeKmText"
                type="number"
                :min="FREE_RUN_KM_MIN"
                :max="FREE_RUN_KM_MAX"
                :step="FREE_RUN_KM_STEP"
                suffix="km"
                label="目标距离（自由跑）"
                density="comfortable"
                :disabled="isBusy"
                hide-details="auto"
                @change="applyFreeKm(freeKmText)"
              />
              <div class="d-flex flex-wrap ga-1 mt-2">
                <v-btn
                  v-for="preset in FREE_RUN_KM_PRESETS"
                  :key="`free-km-${preset}`"
                  size="x-small"
                  variant="tonal"
                  :disabled="isBusy"
                  @click="applyFreeKm(preset)"
                >
                  {{ preset }} km
                </v-btn>
              </div>
              <div class="text-caption text-medium-emphasis mt-1">
                可设 {{ FREE_RUN_KM_MIN }} ~ {{ FREE_RUN_KM_MAX }} km（一位小数），会自动记住上次的值。
                <template v-if="freeRunLaps !== null">
                  按你选的这条跑道，这次约 <b>{{ freeRunLaps }}</b> 圈<template v-if="freeRunSeconds !== null">、约 {{ formatDuration(freeRunSeconds) }}</template>。
                </template>
                <template v-else> 描好跑道后，这里会算出"约几圈"。</template>
              </div>
            </div>

            <v-select
              v-model="run.speed"
              :items="speedItems"
              item-title="label"
              item-value="value"
              label="模拟倍速（演示用）"
              density="comfortable"
              :disabled="run.status === 'running'"
              class="mb-2"
            />
            <v-select
              v-model="run.paceSecPerKm"
              :items="paceItems"
              item-title="label"
              item-value="value"
              label="配速策略（基线，实际会±3%浮动）"
              density="comfortable"
              :disabled="isBusy"
              class="mb-3"
            />

            <div class="d-flex flex-column ga-2">
              <v-btn
                v-if="run.status === 'idle' || run.status === 'finished'"
                color="primary"
                block
                prepend-icon="mdi-play"
                :disabled="!canStart"
                @click="doStart"
              >
                开始跑步
              </v-btn>
              <v-btn v-if="run.status === 'running'" color="warning" block prepend-icon="mdi-pause" @click="pause">暂停</v-btn>
              <v-btn v-if="run.status === 'paused'" color="primary" block prepend-icon="mdi-play" @click="resume">继续</v-btn>
              <v-btn
                v-if="run.status === 'running' || run.status === 'paused'"
                color="error"
                block
                variant="tonal"
                prepend-icon="mdi-flag-checkered"
                @click="finish"
              >
                结束并结算
              </v-btn>
              <!-- ⚠️ 提交进行中（等报备时长/正在提交）时**禁止重置**：否则会把自己正在等待的
                   那笔提交从界面上抹掉（审计 #2），用户就看不到进度与结果了。 -->
              <v-btn
                v-if="run.status !== 'idle'"
                variant="text"
                block
                prepend-icon="mdi-refresh"
                :disabled="submitInFlight"
                @click="reset"
              >
                重置
              </v-btn>
              <div v-if="submitInFlight" class="text-caption text-warning">
                ⚠️ 真实提交正在进行（{{ phaseMessage }}）——<b>请勿关闭程序或离开本页</b>，等待结束会自动提交。
              </div>
            </div>

            <v-alert v-if="run.error" type="error" variant="tonal" density="compact" class="mt-3">{{ run.error }}</v-alert>
      <!-- 路线来源（2026-09-18 收紧）：**只列你描好的路线**，并以它的几何为基准生成轨迹 -->
      <!-- 🆕 2026-09-22（issue #12）：**先分"任务有没有下发线路"，再说"本机描没描"** ——
           原先只有"本机"一条判据，于是"服务端未下发线路"必然被归因成"你还没描跑道"。 -->
      <v-alert v-if="routeIsFree" :type="libTotal > 0 ? 'info' : 'warning'" variant="tonal" density="compact" class="mt-3">
        <div class="font-weight-bold">本任务服务端未下发线路（不指定路线）。</div>
        <div class="text-body-2 mt-1">
          任务的线路列表（<code>runPointList</code>）为空 ⇒ <b>没有服务端线路可选</b>，线路下拉已停用。
          <template v-if="libTotal > 0">
            轨迹将用你<b>本机已有的跑道几何</b>生成（取本机第一条已描跑道）；提交时<b>只带任务号、不带线路标识</b>。
          </template>
          <template v-else>
            本机<b>一条跑道都还没描过</b> —— 我们总得有个几何才能生成轨迹：请先去
            「<b>我的场地 → 跑道编辑</b>」描一条外圈并保存（本机），回到本页即可开跑。
          </template>
        </div>
        <div v-if="libTotal === 0" class="mt-2">
          <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-vector-polyline" to="/field/track-editor">
            去「跑道编辑」描一条
          </v-btn>
        </div>
      </v-alert>
      <v-alert v-else-if="hasConfigured" type="success" variant="tonal" density="compact" class="mt-3">
        只列出你在「跑道编辑」里配置好的 <b>{{ configuredForTask }}</b> 条路线 —— 轨迹以<b>你描的真跑道</b>为基准生成；
        官方模板只作对照（提交时服务端的拟合度仍按官方模板算）。
      </v-alert>
      <v-alert v-else-if="libEntriesNotForTask" type="warning" variant="tonal" density="compact" class="mt-3">
        <div class="font-weight-bold">本机有 {{ libTotal }} 条跑道，但都不属于当前任务的线路。</div>
        <div class="text-body-2 mt-1">
          本版<b>只会用你自己描的跑道</b>生成轨迹，而路线库是<b>按线路</b>存的 —— 当前任务的线路你还没描过。
          去「<b>跑道编辑</b>」把线路切到这条任务的线路 → 「快速定位」→ 沿卫星图描外圈 → 「按外圈自动生成内圈」→ 保存（本机）。
        </div>
        <div class="mt-2">
          <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-vector-polyline" to="/track-editor">
            去「跑道编辑」描一条
          </v-btn>
        </div>
      </v-alert>
      <v-alert v-else-if="activeLinesRaw.length" type="warning" variant="tonal" density="compact" class="mt-3">
        <div class="font-weight-bold">还没有可用的跑道：请先描一条。</div>
        <div class="text-body-2 mt-1">
          本版<b>只会用你自己描的跑道</b>生成轨迹（官方模板偏差十几米，不再作为生成基准）——
          <b>阳光跑与自由跑都是这个口径</b>。
          去「<b>我的场地 → 跑道编辑</b>」选一条线路 → 「快速定位」→ 沿卫星图描外圈 → 「按外圈自动生成内圈」→ 保存（本机）。
          保存后回到本页，这条线路就会出现在下面的下拉框里。
        </div>
        <div class="mt-2">
          <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-vector-polyline" to="/field/track-editor">
            去「跑道编辑」描一条
          </v-btn>
        </div>
      </v-alert>

      <v-alert v-if="!realReady && !demoMode" type="warning" variant="tonal" density="compact" class="mt-3">
              还没读到任务：回<NuxtLink to="/">工作台</NuxtLink>粘贴 token → 点「读取真实账号与任务」；
              或点上方「载入演示数据」只试界面与报文（不发请求）。
              <!-- 刷新后默认不自动恢复缓存，这里给显式入口（2026-09-18：恢复 = 重建会话 + 自动读取） -->
              <div v-if="hasCachedTask" class="d-flex flex-wrap ga-2 mt-2">
                <v-btn size="small" variant="tonal" prepend-icon="mdi-history" @click="doRestoreCached">
                  {{ cacheHasToken ? '恢复上次会话（重建会话并读取）' : '恢复上次会话（用 token 读取）' }}
                </v-btn>
                <span v-if="cacheTokenMask" class="text-caption align-self-center">
                  已保存 token <code>{{ cacheTokenMask }}</code>
                </span>
              </div>
            </v-alert>
            <v-alert type="info" variant="tonal" density="compact" class="mt-3">
              位置推进用「模拟倍速」代替真实 GPS；轨迹、拟合度、里程/配速都是<b>真实算法</b>算出来的
              （{{ demoMode ? '演示 20m/点' : '真实 3m/点 ≈1Hz' }}）；
              里程会<b>略超</b>任务要求、配速<b>非整分钟</b>，拟合度含"GPS 精度下降期" → 数值不是整数（避免一眼假）。
            </v-alert>
            <!-- 用户要求（2026-09-15）：把"模拟配速"的性质说清楚，避免误以为它本身就是最终结果 -->
            <v-alert type="warning" variant="tonal" density="compact" class="mt-2">
              <b>「模拟倍速 / 配速策略」不是最终结果</b> —— 它们只决定<b>本地如何生成这次的轨迹数据</b>
              （里程/时长/配速/拟合度都按任务约束算出来）。
              正确顺序是：<b>先「开始跑步」生成并结算出数据</b> → 看下方自检表 → 再点「<b>真实提交</b>」。
              提交的数值就是自检表里那一组（提交前还会再按报备时长真实等待）。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <RunSelfCheckCard :run="run">
      <!-- ⚠️ 本段是<b>插槽内容</b>：它必须与自检表处在<b>同一张卡</b>里 ——
           拆分前「结算表 + 真实提交」就是一张卡、一个 v-card-text；
           先前拆成两张卡会多出一层边框与间距（已由结构对照脚本抓出并修正）。 -->
      <!-- ===== 真实提交 ===== -->
      <v-divider class="my-3" />
      <div class="d-flex align-center flex-wrap ga-2 mb-2">
        <v-btn
          color="error"
          variant="flat"
          prepend-icon="mdi-cloud-upload-outline"
          :disabled="
            !realReady || run.status !== 'finished' || submitInFlight || alreadySubmitted || staleSettlement || freeRunBlocked || !gateStatus.allow
          "
          @click="confirmOpen = true"
        >
          真实提交
        </v-btn>
        <!-- ⚠️ 2026-09-21 审计修复（B3）：**按钮为什么灰，必须就在按钮旁边说**。
             原先解释只在上方「开跑设置」卡里（几百像素之外），而结果卡是 `v-if="result"` ——
             自由跑被拒时根本不产生 result ⇒ 用户滚到这里只会看到一个灰按钮、附近一个字都没有。 -->
        <template v-if="freeRunBlocked">
          <span class="text-caption text-warning">
            已标灰：本机记录显示你所在学校未开通「自由跑任务」（服务端会拒绝真实提交）
          </span>
          <v-btn size="x-small" variant="text" @click="clearFreeRunUnsupported()">仍要试一次</v-btn>
        </template>
        <!-- ⚠️ 2026-09-21：`:disabled` 里带 `submitInFlight` —— 提交流程内部自己也会调一次 `fetchVerdict`
             （同样往过程清单里插 ⑥ 行），只锁"按钮连点"挡不住这种并发（审计指出） -->
        <v-btn
          v-if="result?.scantronId"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-clipboard-check-outline"
          :loading="verdictLoading"
          :disabled="verdictLoading || submitInFlight"
          @click="onFetchVerdict"
        >
          查询判定
        </v-btn>
        <v-chip v-if="phase !== 'idle'" size="small" variant="tonal" :color="phaseColor">{{ phaseMessage }}</v-chip>
      </div>

      <!-- 未读到真实任务时的提示（演示模式不算——它本来就不是真实数据） -->
      <v-alert v-if="!realReady && !demoMode" type="info" variant="tonal" density="compact">
        尚未读取真实数据：先在<NuxtLink to="/">工作台</NuxtLink>粘贴 token 并点「读取真实账号与任务」。
        演示数据只能用于试界面与报文预览，<b>不会</b>真实提交。
      </v-alert>
      <!-- ⛔ 开跑前门禁：三个否决项任一开启（或状态未知）→ 从源头阻止创建场次 -->
      <v-alert
        v-else-if="!gateStatus.allow"
        type="error"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        <div class="font-weight-bold">已阻止真实提交（不会创建场次）</div>
        <div class="text-body-2">{{ gateStatus.reason }}</div>
        <div v-if="cameraFlagError" class="text-caption mt-1">读取异常：{{ cameraFlagError }}</div>
        <!-- 线路开关读取失败/切换线路后未重查 → 给一个显式重试入口（不必刷新页面） -->
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

      <v-alert v-if="phase === 'waiting'" type="info" variant="tonal" class="mt-2">
        <div class="d-flex align-center ga-3">
          <v-progress-circular indeterminate size="22" />
          <div>
            <div class="font-weight-bold">正在真实等待：还剩 {{ formatDuration(remainingSeconds) }}</div>
            <div class="text-caption">
              为保证 <code>endTime - startTime</code> 与服务器观测一致（避免"秒级完成长距离"的破绽），
              提交前必须真等够报备时长。可以切到别的页面，倒计时会继续。
            </div>
            <!-- 用户要求：等待期间明确提醒三条 -->
            <div class="text-body-2 mt-2 font-weight-bold">
              ⛔ 等待期间请勿在<b>任意端</b>登录「龙猫」相关账号；🚫 请勿关闭此网页/程序；⏳ 请等到倒计时结束。
            </div>
          </div>
        </div>
      </v-alert>

      <v-alert
        v-if="result"
        :type="result.scoreOk ? 'success' : result.scoreOutcome === 'timeout-unknown' ? 'warning' : 'error'"
        variant="tonal"
        class="mt-2"
      >
        <div class="font-weight-bold">提交结果：{{ result.scoreMessage }}</div>
        <div class="text-caption">
          scantronId={{ result.scantronId }} ·
          <!-- ⚠️ 2026-09-21（冗余加固，审计 B3）：「结果未知」不能再写成"成绩未成功"（自相矛盾） -->
          轨迹：{{
            result.detailOk === undefined
              ? result.scoreOutcome === 'timeout-unknown'
                ? '未提交（结果未知，稍后可点「查询判定」核实；核实到已入库时会自动补交）'
                : '未提交（成绩未成功，按源码不发）'
              : result.detailOk
                ? '已提交'
                : '失败：' + result.detailMessage
          }}
        </div>
        <div v-if="result.verdictText" class="text-body-2 mt-1">★ 判定：{{ result.verdictText }}</div>
        <!-- ⚠️ 2026-09-21 审计修复（B3）：提交成功后按钮会被禁用，这里说明**为什么**，并给出正确出路 -->
        <div v-if="alreadySubmitted" class="text-caption mt-1">
          本次结算已经提交过，不能再重复提交（服务端会多录一条成绩）。如需再跑一次，请先点「重置」再重新开跑。
        </div>
        <!-- ⚠️ 2026-09-21（冗余加固，审计 B4）：结算早于当前任务 ⇒ 已禁止提交，并说明怎么办 -->
        <div v-if="staleSettlement" class="text-caption mt-1">
          ⚠️ 这笔结算是<b>上一个任务/演示数据</b>留下的（早于当前任务读取时刻）——已禁止提交，避免把旧轨迹配到当前任务上。
          请点「重置」后重新开跑，再提交。
        </div>
      </v-alert>

      <!-- 提交过程清单（2026-09-21 用户要求："要能看到现在在传什么"）
           六步逐条打点：① 门禁 → ② 建场次 → ③ 真实等待 → ④ 成绩（含线路点列）→ ⑤ 轨迹（GPS 点列）→ ⑥ 判定。
           ⚠️ 超时那条也会显示在这里（"结果未知 → 正在核实 → 已入库/无法确认"），
           让用户明白"超时 ≠ 失败"，也避免他以为没交上去而重复提交。 -->
      <v-card v-if="submitProgress.length" variant="outlined" class="mt-3">
        <v-card-title class="text-body-2 font-weight-bold py-2 d-flex align-center">
          <v-icon size="18" class="mr-1">mdi-progress-upload</v-icon>提交过程
          <v-spacer />
          <span class="text-caption text-medium-emphasis">共 {{ submitProgress.length }} 步记录</span>
        </v-card-title>
        <v-divider />
        <v-card-text class="py-2">
          <div v-for="(line, i) in submitProgress" :key="i" class="d-flex align-start ga-2 mb-1">
            <v-icon
              size="16"
              :color="line.kind === 'ok' ? 'success' : line.kind === 'error' ? 'error' : line.kind === 'warn' ? 'warning' : 'info'"
              class="mt-1"
            >
              {{
                line.kind === 'ok'
                  ? 'mdi-check-circle-outline'
                  : line.kind === 'error'
                    ? 'mdi-close-circle-outline'
                    : line.kind === 'warn'
                      ? 'mdi-alert-circle-outline'
                      : 'mdi-circle-small'
              }}
            </v-icon>
            <div class="text-body-2">
              <span class="text-medium-emphasis text-caption mr-1">{{ formatClock(line.at) }}</span>{{ line.text }}
            </div>
          </div>
        </v-card-text>
      </v-card>

      <RunPayloadPreview :run="run" />
    </RunSelfCheckCard>

    <!-- 轨迹预览（矢量、离线）：看"有没有贴着官方路线走 / 有没有跑在自己描的跑道两圈之间"
         —— 1.1.9 起把**本机路线库的内外圈 + 所选车道线**一起画出来（几何与真实提交同源）
         —— 并按"一圈多长"把轨迹**拆成每圈一色**（多圈同色会糊成一条粗带，用户反馈过）
         ⚠️ `:lapLengthM` **必须用 camelCase 绑定**（不要写 :lap-length）：
            Vue 解析 prop 时走 `camelize(属性名)`，而 `camelize('lap-length')` = `lapLength`
            ≠ 组件声明的 `lapLengthM`（**末尾那个大写 M 丢失**）⇒ 该 prop 被**静默丢弃**（=undefined）；
            **dev 与生产都会丢**（dev 只是额外给一条 warning）。详见 ERROR.md E48。 -->
    <RunTrajectoryPreview
      :points="run.points"
      :route="selectedLine?.pointList ?? []"
      :track-entries="libEntries"
      :line-id="run.lineId"
      :lapLengthM="run.lapLengthM"
      :lapDriftM="run.lapDriftM"
    />

    <!-- 真实提交确认框 -->
    <v-dialog v-model="confirmOpen" max-width="620">
      <v-card>
        <v-card-title class="d-flex align-center">
          <v-icon color="error" class="mr-2">mdi-alert-outline</v-icon>
          确认真实提交？
        </v-card-title>
        <v-card-text>
          <!-- 🔴 用户要求（2026-09-15）：提交时明确弹出三条警告 -->
          <v-alert type="error" variant="flat" density="comfortable" class="mb-3">
            <div class="font-weight-bold">提交前请务必确认以下三条</div>
            <ol class="text-body-2 pl-4 mt-1 mb-0">
              <li><b>请勿在任意端登录「龙猫」相关账号</b>（手机 / 电脑 / 其他浏览器都别登）——避免会话被顶掉或触发风控；</li>
              <li><b>请勿关闭此网页或本程序</b>——提交与真实等待都发生在这里，关掉就中断了；</li>
              <li><b>请等待倒计时结束</b>（约 20 分钟），期间<b>不要刷新页面</b>。</li>
            </ol>
          </v-alert>
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
            这会在你的账号上<b>真实生成一条成绩</b>（会计入本学期的跑步次数）。请确认下列数值无误。
          </v-alert>
          <v-list density="compact">
            <v-list-item title="线路" :subtitle="routeIsFree ? '本任务未下发线路（不指定路线）' : selectedLineName" prepend-icon="mdi-map-marker-path" />
            <v-list-item title="里程" :subtitle="`${run.result?.km.toFixed(2)} km（任务要求 ${activeTask?.mileage ?? '—'} km）`" prepend-icon="mdi-map-marker-distance" />
            <v-list-item title="时长 / 配速" :subtitle="`${formatDuration(run.result?.durationSeconds ?? 0)} · ${formatPace(Math.round((run.result?.durationSeconds ?? 1) / Math.max(0.01, run.result?.km ?? 1)))}/km`" prepend-icon="mdi-timer-outline" />
            <!-- 🆕 2026-09-22（issue #12）：阈值口径取自纯函数 `fitRequirementOf()` ——
                 服务端未下发阈值时如实写"未下发"（客观事实），不再拿历史兜底 0.6 冒充"要求"。 -->
            <v-list-item title="拟合度" :subtitle="`${run.result?.fitDegree.toFixed(2)}（${fitRequirementText}）`" prepend-icon="mdi-chart-bell-curve" />
            <v-list-item title="自检" :subtitle="run.result?.check.pass ? '硬性项全部通过' : '存在不通过项，建议先修正'" prepend-icon="mdi-clipboard-check-outline" />
            <v-list-item
              title="开跑前门禁（人脸 / 抽查 / 摄像头杆）"
              :subtitle="gateStatus.blockedBy === 'night' ? '夜间停用：只能模拟与预览，不能真实提交' : gateStatus.allow ? '三项均关闭或无阻碍，可开跑' : gateStatus.reason"
              prepend-icon="mdi-shield-check-outline"
            />
            <v-list-item
              title="提交前需真实等待"
              :subtitle="`${formatDuration(run.result?.durationSeconds ?? 0)}（保证时间线一致）`"
              prepend-icon="mdi-timer-sand"
            />
          </v-list>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <!-- ⚠️ 2026-09-19 审计 S2：确认按钮原先**没有 disabled/loading** ⇒ 双击会发两次
               `getRunBegin`（服务端开两个场次），而 `submitRealRun()` 内部的 `waitTimer` 是闭包单变量，
               第二次调用会把第一次的计时器清掉 ⇒ 第一次的 Promise 永不 resolve。
               这里加锁只是第一层，真正兜底在 `submitRealRun()` 的入口互斥（见 real/submit.ts）。 -->
          <v-btn variant="text" :disabled="submitInFlight" @click="confirmOpen = false">取消</v-btn>
          <v-btn
            color="error"
            variant="flat"
            prepend-icon="mdi-cloud-upload-outline"
            :disabled="submitInFlight"
            :loading="submitInFlight"
            @click="doRealSubmit"
          >
            确认提交
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { formatClock, formatDuration, formatPace } from '~/utils/mp/runData'
// 冗余加固（2026-09-21）：判定"这笔结算是不是上一笔/演示数据留下的"（纯函数，有单测）
import { isStaleSettlement } from '~/utils/mp/writeOutcome'
import { useMpDemo } from '~/composables/useMpDemo'
import { useMpReal } from '~/composables/useMpReal'
import { logError, logInfo, logWarn } from '~/composables/useEventLog'
import { groupRoutesByCampus, toSelectItems, warnForSelection } from '~/utils/mp/routeGroups'
// 🆕 2026-09-22（issue #12）：判"任务到底有没有下发线路"（纯函数，与门禁/自检/诊断同源）
import { fitRequirementOf, routeRequirementOf } from '~/utils/mp/taskShape'
import { laneLoop, laneRatioFor, ringLengthM } from '~/utils/mp/trackEditor'
import {
  FREE_RUN_KM_MAX,
  FREE_RUN_KM_MIN,
  FREE_RUN_KM_PRESETS,
  FREE_RUN_KM_STEP,
  estimateFreeRunSeconds,
  estimateLaps,
  formatFreeRunKm,
} from '~/utils/mp/freeRun'

const { isLoggedIn, task, run, progress, paceText, start, pause, resume, finish, reset, demoMode, enableDemo, freeRunKm, setFreeRunKm } =
  useMpDemo()
const {
  profile: realProfile,
  task: realTask,
  status: realStatus,
  error: realError,
  /** 本机"上次读取真实数据"的时刻（毫秒）—— 用来判定结算是不是"当前任务的" */
  loadedAt: realLoadedAt,
  phase,
  phaseMessage,
  remainingSeconds,
  result,
  /** ⚠️ 必须改名：`progress` 已被上面的 `useMpDemo()` 占用（那是**演示跑**的进度） */
  progress: submitProgress,
  /** 🆕 2026-09-21（E）：本机已知该校未开通自由跑 ⇒ 标灰真实提交入口 */
  freeRunUnsupported,
  clearFreeRunUnsupported,
  applyToRunner,
  submitRealRun,
  fetchVerdict,
  restoreCachedTask,
  hasCachedTask,
  cacheHasToken,
  cacheTokenMask,
  persistSelectedLine,
  gateStatus,
  cameraFlagError,
  retryCameraFlag,
} = useMpReal()
const showSnackbar = useNotice()

const confirmOpen = ref(false)

const realReady = computed(() => realStatus.value === 'ready' && Boolean(realTask.value))
/** 当前生效的任务：真实任务优先，其次演示任务（默认都为空 = 未载入） */
const activeTask = computed(() => realTask.value ?? task.value)
/** 当前线路集（真实/演示任务都自带 runPointList） */
const activeLinesRaw = computed(() => activeTask.value?.runPointList ?? [])

/**
 * 🆕 2026-09-22（issue #12）：**本任务到底有没有下发线路**（纯函数判据，唯一来源 `utils/mp/taskShape.ts`）。
 *
 * `routeIsFree === true` = 任务的 `runPointList` 缺失/为空 ⇒ **服务端未下发线路**（自由路线任务，如"研途健行"）。
 * 它与"任务有线路、但你还没描跑道"是**两件不同的事**，界面文案必须分开（这是 issue #12 的核心误判）。
 *
 * ⚠️ 口径纪律：文案只能说"**服务端未下发线路**"（客观事实），**不许**写成"服务端不判路线"。
 */
const routeReq = computed(() => routeRequirementOf(activeTask.value))
const routeIsFree = computed(() => routeReq.value.kind === 'free')
/**
 * 拟合度那一行的口径说明（确认弹窗用）——**与自检表同源**（`utils/mp/taskShape.ts`）：
 * 服务端未下发阈值时就是"服务端未下发拟合度阈值（本任务不判拟合度）"，不写"不判路线"这类我们证明不了的结论。
 */
const fitRequirementText = computed(() => fitRequirementOf(activeTask.value).reason)

/**
 * 本地路线库（用户要求，2026-09-18 收紧为**强制**）：
 * **阳光跑页只列"在跑道编辑里配置好的路线"，并以那条路线的几何为基准生成轨迹。**
 *
 * ⚠️ 2026-09-18 变更（用户实测反馈）：此前"库里为空时先列出全部官方线路"的兜底**已删除** ——
 * 用户的原话是"我们就是要弄新的版本，在下拉框里面选择我们已经编辑好的路径，再以这个路径为基础来进行生成"。
 * 那条兜底会让人**在没配过跑道时直接跑官方模板**（形状偏十几米），而且提示不醒目 ⇒ 容易被当成 bug。
 * 现在：没配置过 ⇒ 下拉框为空、**开跑按钮禁用**，并给出"先去描一条"的明确指引。
 *
 * ⚠️ 2026-09-18 发布前审计 M1：**"有没有配置"必须与下拉框同口径**。
 *    库里按 `lineId` 存，本机可能留着**别的任务/演示数据**的条目（例如先用演示数据描了一圈，
 *    再读真实任务）—— 那时旧写法 `libEntries.length > 0` 会显示绿条"只列出你配置好的 N 条路线"，
 *    而下拉框其实是空的、开跑永久灰，且本该出现的"去描一条"警示被 `v-else-if` 吃掉 ⇒ 用户卡死无出路。
 *    判据改为"**当前任务里的线路确有配置**"（`activeLines.length > 0`），并为"库里有条目但都不属于当前任务"
 *    单独给一条带入口的提示。
 */
const { entries: libEntries, load: loadTrackLibrary } = useTrackLibrary()
onMounted(() => loadTrackLibrary())
const configuredIds = computed(() => new Set(libEntries.value.map((e) => String(e.lineId))))
/** 只列"本机路线库里配置过"的线路（**没有兜底**：没配置就是空列表） */
const activeLines = computed(() => activeLinesRaw.value.filter((l) => configuredIds.value.has(String(l.pointId))))
/** 当前任务里**确有配置**的线路数（与下拉框同口径；=0 时不能开跑） */
const configuredForTask = computed(() => activeLines.value.length)
/** 本机路线库总条数（可能全是别的任务/演示数据留下的） */
const libTotal = computed(() => libEntries.value.length)
const hasConfigured = computed(() => configuredForTask.value > 0)
/** 库里有条目、但都不属于当前任务的线路（要给"去为这条线路描一圈"的指引） */
const libEntriesNotForTask = computed(() => libTotal.value > 0 && configuredForTask.value === 0)
/** 本次是自由跑（提交口径：不选线路、不带任务号、不查打卡开关 —— 与小程序一致） */
const isFreeRun = computed(() => run.value.runType !== 0)

/**
 * **标签页按 URL 绑定**：阳光跑与自由跑是同一个分组（「跑步」）里的两个小标签，各自有独立 URL。
 *
 * 为什么这么做：两者**共用同一套跑步引擎与跑步机状态**（`useMpDemo().run` 是跨页面共享的 `useState`）
 * —— 如果复制成两份页面，逻辑会立刻漂移。所以用"两个真实路由 + 同一个引擎"。
 *
 * ⚠️ 2026-09-20 分组重构：路由从 `/run` + `/freerun` 改为 **`/runs/sunrun` + `/runs/freerun`**
 *    （旧 URL 保留为跳转）。**这里不能再靠固定字符串判断**，改成"看路由最后一段"，
 *    这样分组/改名都不会再失效（判据：**路由判定要读"末段 / 参数"，不要 `startsWith('/某个固定前缀')`**）。
 */
const route = useRoute()
const runTab = computed(() => String(route.path ?? '').split('/').filter(Boolean).pop() ?? 'sunrun')
const isFreeTab = computed(() => runTab.value === 'freerun')
/** 当前标签对应的**提交口径**（0 阳光跑 / 1 自由跑）—— 这是唯一权威来源 */
const tabRunType = computed<0 | 1>(() => (isFreeTab.value ? 1 : 0))
/** 正在跑/暂停时不允许改口径（会污染进行中的那一笔） */
const runTypeLocked = computed(() => run.value.status === 'running' || run.value.status === 'paused')
watchEffect(() => {
  const want = tabRunType.value
  if (run.value.runType === want) return
  if (runTypeLocked.value) return // 进行中：先不动，交给 doStart() 兜底
  run.value.runType = want
})

/**
 * ⚠️ **开跑前把口径与当前标签对齐**（2026-09-18 审计 #1 的修复）。
 *
 * 病因：`run.runType` 只是"上一次设置后可能被冻结"的副本 —— `watchEffect` 在 `running/paused` 时跳过改写，
 * 若用户在这期间（或在"已结算"态）从导航切了标签，副本就可能与 URL 不一致；而 `start()` 直接读这个副本，
 * 于是出现"界面是自由跑、实际按阳光跑提交"（带任务号 + 路径点列 + **计入成绩**），
 * 正好违反自由跑的口径（`utils/mp/submitPayload.ts` 的 freeRun 分支）。
 *
 * 修法：**不再依赖那个副本** —— 每次开跑都以**当前标签**为准写回，再交给 runner 生成/结算。
 */
const doStart = () => {
  run.value.runType = tabRunType.value
  start()
}
/**
 * 能不能开跑：**两种跑法都要求"已为当前任务的线路描过跑道"**（用户 2026-09-18 口径：
 * "自由跑我们也需要保证线路的稳健性，所以也是限制在自己做的线路中"）。
 *
 * ⚠️ 与厂商语义的差别（有意为之，写在这里免得后人误改）：
 *   厂商的自由跑 `paperId`/`lineId` 都是空串、**不取线路**（见 `utils/mp/submitPayload.ts` 的注释），
 *   所以"必须描过跑道"**不是厂商要求**，而是**我们本地为了轨迹质量加的约束** ——
 *   自由跑若不描，就只能拿官方模板当形状（偏差十几到几十米），用户要的是"稳健"。
 *
 * ⚠️ 2026-09-20 补充（用户要求"自由跑也要选择路径"）：自由跑现在**也会显示线路下拉**，
 *   但它选的是**本地生成轨迹用哪条几何**，**不是**提交用的线路标识 ——
 *   提交口径**一个字都没变**：自由跑依旧 `runType=1` + 不带任务号 + `paperId`/`lineId` 为空串 +
 *   不发路径点明细（由 `buildScoreRequest` 的 freeRun 分支强制，且有单测钉住）。
 *   判据：**"选线路"这件事只允许影响本地几何；任何把 UI 上的线路选择带进自由跑报文的改动都是错的。**
 *
 * 🆕 2026-09-22（issue #12）：**服务端未下发线路的任务**（`routeIsFree`）——
 *   线路下拉已停用（没有服务端线路可选），但**本机只要有一条已描跑道就允许开跑**：
 *   跑步引擎用「本机第一条已描跑道」当几何（`composables/demo/runner.ts` 的 `localTrackLines` 兜底）。
 *   一条都没描 ⇒ 仍禁用并提示去描一条（我们总得有个几何才能生成轨迹）。
 *   ⚠️ 那只是**本地几何的来源**，与提交报文无关：这类任务提交时 `lineId` 为空串、`paperId` 用任务号兜底。
 */
const canStart = computed(() => configuredForTask.value > 0 || (routeIsFree.value && libTotal.value > 0))
const isBusy = computed(() => run.value.status === 'running' || run.value.status === 'paused')
/**
 * **真实提交正在进行**（等报备时长 / 正在提交）。
 *
 * ⚠️ 2026-09-18 审计 #2：这条链路活在 `phase` 里，而"能不能离开/重置"原先只看 `run.status`
 * （提交期 `run.status` 已是 `finished` ⇒ `isBusy=false`）⇒ 用户可以在倒计时中途点「重置」把
 * 自己正在等待的那笔提交从界面上抹掉（数据不会写坏，但完全失去监督窗口）。
 * 所以"锁"必须**同时看两条轨道**。
 */
/**
 * "提交在途"判据（按钮 disabled / loading 共用）。
 * ⚠️ 2026-09-20 审计修复：原先只判 `waiting|submitting`，**漏了 `begin`** ——
 * `phase='begin'` 时正在 await `getRunBegin`（最长 15 s），那段时间按钮可点，
 * 第二次点击会让服务端**建出两个场次**（`real/submit.ts` 的入口互斥已同步补上 `begin` 兜底）。
 * ⚠️ 2026-09-21 审计修复：**同一"在途"概念只允许一处判据** —— 工具栏那个按钮原先自己另写了一套
 * （`phase === 'waiting' || phase === 'submitting'`），于是 `begin` 阶段它能点，再点会弹出
 * "确认/取消**都禁用**"的点不动弹窗；现在工具栏也统一用本 computed。
 */
const submitInFlight = computed(
  () => phase.value === 'begin' || phase.value === 'waiting' || phase.value === 'submitting',
)

/**
 * ⚠️ 2026-09-21 审计修复（B3）：**本次结算已经提交过**就不许再点。
 * 原先提交成功后 `phase='done'` 而 `run.status` 仍是 `finished` ⇒ 「真实提交」重新可点，
 * 再点会新建一个 `scantronId` **再发一次 sunRunExercises** ⇒ 账号上多录一条成绩。
 * 最容易踩的场景正是：首次提交超时、界面说"结果未知"，用户以为没交上去就再点一次。
 */
const alreadySubmitted = computed(() => phase.value === 'done' && Boolean(result.value?.scantronId))

/**
 * ⚠️ 2026-09-21（冗余加固，审计 B4）：**"上一笔结算"不许当成本次任务的成绩提交**。
 *
 * 问题：换任务时 `applyToRunner()` 只换 `task`/线路，**不动 `run`** ⇒ 从"载入演示数据 → 跑完"
 * 切到"读取真实任务"后，`run.status` 仍是 `finished`、`run.result` 还是**演示那笔**，
 * 而按钮判据只看 `realReady && run.status === 'finished'` ⇒ 可以把**演示数据的里程/轨迹**
 * 配上**真实任务的 taskId** 提交上去（服务端会多一条来路不明的成绩）。
 *
 * 判据（冗余，不改结构）：**结算时刻必须晚于"本次任务读取时刻"** —— 否则按钮禁用并说明原因。
 * （`loadedAt` = `loadRealData()` 完成时写的 `Date.now()`；`settledAtMs` = `finish()` 结算时写的。）
 */
const staleSettlement = computed(() =>
  run.value.status === 'finished' && isStaleSettlement(Number(run.value.settledAtMs || 0), Number(realLoadedAt.value || 0)),
)

/**
 * 🆕 2026-09-21（E：自由跑入口标灰）：**本机已知该校未开通「自由跑任务」** 时，把自由跑的真实提交入口标灰。
 *
 * 为什么这样设计：服务端是否开通**本地无法预先探测**（报文与官方小程序逐字一致、没有 paperId 可补），
 * 所以退而求其次 —— 记下上一次被拒（`markFreeRunUnsupported`，持久化），下次开跑前就说明白；
 * 同时给一个「仍要试一次」的出口把标记清掉，**不挡真的开通了的学校**。
 */
const freeRunBlocked = computed(() => isFreeRun && Boolean(freeRunUnsupported.value))

/** 载入演示数据（按需功能，不发任何请求） */
const doEnableDemo = () => {
  enableDemo()
  showSnackbar('已载入演示数据（假数据，不发请求）', 'info')
}

/** 恢复"上次读取的任务"（刷新后默认不自动恢复） */
const doRestoreCached = () => {
  // 这也是"读取数据"（从本机缓存里恢复任务）⇒ 用云式顶部提示（1.1.9 需求①）
  // 2026-09-18：恢复 = **拿本机 token 重新读取一遍**（与工作台同一套语义）
  if (restoreCachedTask()) showSnackbar('正在用本机 token 重新读取…', 'info', { cloud: true })
  else showSnackbar(realError.value || '本机没有可用 token：请回「工作台」点「一键获取 token」', 'warning', { cloud: true })
}

const statusText = computed(() => ({ idle: '待开始', running: '跑步中', paused: '已暂停', finished: '已结算' })[run.value.status])
const statusColor = computed(() => ({ idle: 'info', running: 'success', paused: 'warning', finished: 'primary' })[run.value.status])
const phaseColor = computed(
  () => ({ idle: 'info', begin: 'info', waiting: 'info', submitting: 'warning', done: 'success', error: 'error' })[phase.value],
)

/**
 * 拟合度数值的颜色（RunMetricsCard 的大字）。
 * 🆕 2026-09-22（issue #12）：阈值口径同 `utils/mp/taskShape.ts` —— **服务端未下发阈值 ⇒ 不着色**
 * （灰色小字语境），既不算"通过"（旧实现会拿历史兜底 0.6 把它染绿）也不算"不通过"。
 */
const fitClass = computed(() => {
  const fit = fitRequirementOf(activeTask.value)
  if (!fit.required || fit.threshold === null) return 'text-medium-emphasis'
  if (run.value.fitDegree >= fit.threshold) return 'text-success'
  return run.value.fitDegree > 0 ? 'text-warning' : ''
})

/** 线路下拉（真实/演示都由当前生效任务提供；按坐标校区分组，本校区优先） */
const routeGroups = computed(() => groupRoutesByCampus(activeLines.value, realProfile.value?.campusName))
/**
 * 用户在「跑道编辑 → 本地路线库」里改过名 ⇒ 下拉里也显示他起的名字（1.1.9 需求②）。
 * 没改过名时返回 undefined，`toSelectItems` 的行为**逐字不变**。
 */
const customNameOf = (id: string) => libEntries.value.find((e) => String(e.lineId) === String(id))?.customName
const lineItems = computed(() => toSelectItems(routeGroups.value, customNameOf))
/** 选了其他校区线路时的提示（未跨校区为空串） */
const crossCampusWarning = computed(() => warnForSelection(routeGroups.value, run.value.lineId))
const selectedLineName = computed(() => {
  const line = activeLines.value.find((l) => l.pointId === run.value.lineId)
  if (!line) return '—'
  // 改过名就显示改名（用户看的是自己起的名字）；否则保持原来的厂商名口径
  return customNameOf(String(line.pointId))?.trim() || line.pointName || '—'
})
/** 当前选中的线路（含官方路线点列）—— 给「轨迹预览」当参考线用 */
const selectedLine = computed(() => activeLines.value.find((l) => l.pointId === run.value.lineId))

// 线路集变化后校正选中项：
//   - 已选线路仍在新列表里 → **保持不动**（不覆盖用户选择，也不覆盖服务器/缓存给的默认）；
//   - 未选或已选线路消失 → 落到分组默认（本校区第一条）。
watch(
  () => routeGroups.value,
  (g) => {
    if (!g.ordered.length) return
    const stillValid = g.ordered.some((r) => String(r.line.pointId) === String(run.value.lineId))
    if (!stillValid && g.defaultLineId) run.value.lineId = g.defaultLineId
  },
  { immediate: true },
)

// 用户换线路 → 写回任务缓存（刷新页面后保持所选线路）
watch(
  () => run.value.lineId,
  (id) => {
    if (id) persistSelectedLine()
  },
)

// 跑步状态变化 → 记事件日志（开始 / 暂停 / 结算，含结算数值，便于事后核对）
watch(
  () => run.value.status,
  (s, prev) => {
    if (s === prev) return
    const line = activeLines.value.find((l) => l.pointId === run.value.lineId)
    if (s === 'running' && prev === 'idle') {
      logInfo('run', '开始跑步', {
        mode: demoMode.value ? '演示' : '真实',
        lineId: line?.pointId,
        lineName: line?.pointName,
        speed: run.value.speed,
      })
    } else if (s === 'paused') {
      logInfo('run', '暂停', { km: Number((run.value.distanceM / 1000).toFixed(2)) })
    } else if (s === 'running' && prev === 'paused') {
      logInfo('run', '继续', { km: Number((run.value.distanceM / 1000).toFixed(2)) })
    } else if (s === 'finished' && run.value.result) {
      const r = run.value.result
      logInfo('run', '结算完成（本地预判）', {
        km: Number(r.km.toFixed(2)),
        durationSeconds: r.durationSeconds,
        fitDegree: r.fitDegree,
        paceSecPerKm: Math.round(r.durationSeconds / Math.max(0.01, r.km)),
        steps: r.stepsSubmitted,
        hardPass: r.check.pass,
        problems: r.check.problems,
      })
      if (!r.check.pass) logWarn('run', '硬性自检未通过', { problems: r.check.problems })
    }
  },
)

/**
 * 🆕 **自由跑目标距离**（2026-09-20，1.1.12 需求①）：
 *   · 阳光下跑的里程由任务决定（`task.mileage`），自由跑没有任务 ⇒ 由用户在这里设定；
 *   · 输入框走**本地文本态**：`@change`（失焦/回车）才归一化落盘 —— 否则用户打到一半
 *     （例如刚键入 `1`、还没打 `0`）就被夹紧成 0.5，看着像"数字乱跳"；
 *   · 归一化与落盘**全部交给 `setFreeRunKm`**（纯函数 `clampFreeRunKm` + localStorage），
 *     页面不自己判合法性（判据：**同一个数字只能有一处说了算**）。
 *   · 圈数/时长只是**提示**（按你描的那条跑道的车道周长与当前配速估），不改任何提交口径。
 */
const freeKmText = ref(formatFreeRunKm(freeRunKm.value))
watch(freeRunKm, (v) => {
  freeKmText.value = formatFreeRunKm(v)
})
const applyFreeKm = (raw: unknown) => {
  const km = setFreeRunKm(raw)
  freeKmText.value = formatFreeRunKm(km)
}
/** 所选跑道"一圈多长"（米）：没描过/几何不足时为 0（界面据此不显示"约几圈"） */
const selectedLaneLengthM = computed(() => {
  const e = libEntries.value.find((x) => String(x.lineId) === String(run.value.lineId))
  if (!e || e.outer.length < 3 || e.inner.length < 3) return 0
  const loop = laneLoop({ outer: e.outer, inner: e.inner }, laneRatioFor(e.laneNo ?? 3, e.laneCount ?? 6), 240)
  return loop.length >= 3 ? ringLengthM(loop) : 0
})
const freeRunLaps = computed(() => estimateLaps(freeRunKm.value, selectedLaneLengthM.value))
const freeRunSeconds = computed(() => estimateFreeRunSeconds(freeRunKm.value, run.value.paceSecPerKm))

const speedItems = [
  { value: 1, label: '1× 实时（3.4km 约 21 分钟）' },
  { value: 10, label: '10×（约 2 分钟）' },
  { value: 60, label: '60×（约 21 秒）' },
  { value: 600, label: '600×（约 2 秒，看结果用）' },
]
/** 配速策略（真实学生的常见区间；实际会 ±3% 浮动并夹紧到任务窗口） */
const paceItems = [
  { value: 330, label: `5'30" /km（较快）` },
  { value: 360, label: `6'00" /km（常规）` },
  { value: 390, label: `6'30" /km（轻松）` },
]

/** 页面挂载：把当前任务（若已有）注入跑步机；**不再自动回填缓存**（刷新后默认干净） */
onMounted(() => {
  applyToRunner()
})

/** 真实提交：确认后走 useMpReal 的完整流程（门禁 → 开跑 → 真实等待 → 提交 → 读判定） */
const doRealSubmit = async () => {
  confirmOpen.value = false
  /**
   * ⚠️ 2026-09-19 审计 S2/S3：这里原先**没有 try/catch**，也没有入口互斥。
   *   · `submitRealRun` 会创建服务端场次（非幂等写），内部一旦抛异常（例如等待期间档案被清空
   *     导致空指针），异常会直接冒到这里 ⇒ 界面**没有任何提示**，`phase` 还可能卡死；
   *   · 双击确认会进两次（按钮已加 disabled，这里再兜一层）。
   * 所以：入口判"已在等待/提交中就忽略"，并整体包 try/catch 把异常变成可读提示。
   */
  if (submitInFlight.value) {
    showSnackbar('正在等待/提交中，请勿重复点击', 'info')
    return
  }
  // 门禁失守直接返回（不调 getRunBegin，避免创建场次后才发现被拦）
  if (!gateStatus.value.allow) {
    logWarn('submit', '点了真实提交但门禁未通过', { blockedBy: gateStatus.value.blockedBy ?? '', reason: gateStatus.value.reason })
    showSnackbar(gateStatus.value.reason || '当前不允许真实提交', 'error')
    return
  }
  const r = run.value.result
  /**
   * 🆕 2026-09-22（issue #12）：**提交用哪条线路**。
   *
   * · 自由跑（`isFreeRun`）⇒ 没有线路（厂商口径：paperId/lineId 都为空串）；
   * · **服务端未下发线路的任务**（`routeIsFree`）⇒ 也传 `null`：本机跑道只是**本地几何**，
   *   它的 `pointId` 是我们自己库里的键名（多半来自别的任务/线路），**不是服务端线路标识**，
   *   绝不能进报文（`lineId` 必须空串）；任务号改由 `paperId` 兜底（`task.taskId`）。
   * · 其余（服务端下发了线路）⇒ 与原来逐字一致。
   */
  const line = isFreeRun.value || routeIsFree.value ? null : (activeLines.value.find((l) => l.pointId === run.value.lineId) ?? null)
  const paperId = routeIsFree.value ? String(activeTask.value?.taskId ?? '') : ''
  if (!r) {
    showSnackbar('缺少结算数据', 'error')
    return
  }
  if (!isFreeRun.value && !routeIsFree.value && !line) {
    showSnackbar('缺少线路或结算数据', 'error')
    return
  }
  logInfo('submit', '用户确认真实提交', {
    runType: r.submitRunType,
    lineId: line?.pointId ?? (isFreeRun.value ? '(自由跑)' : '(本任务未下发线路)'),
    paperId,
    km: Number(r.km.toFixed(2)),
    durationSeconds: r.durationSeconds,
    fitDegree: r.fitDegree,
    checkPass: r.check.pass,
    points: r.points.length,
  })
  try {
    const out = await submitRealRun({
      line,
      // 🆕 2026-09-22（issue #12）：任务号兜底 —— 只有"本任务未下发线路"时才非空（有线路时被报文构造器忽略）
      paperId: paperId || undefined,
      // 提交口径与预览同源（结果里那份 submitRunType），避免两处各转一次导致口径漂移
      runType: r.submitRunType,
      // ⚠️ 用**实际跑出来的那一段**（自由跑提前结束时，整条 points 会与 km 矛盾）
      points: r.points,
      km: r.km,
      fitDegree: r.fitDegree,
      plannedSeconds: r.durationSeconds,
    })
    if (out?.scoreOk) {
      showSnackbar('真实提交成功，正在读判定…', 'success')
      await onFetchVerdict(out.scantronId)
    } else if (out) {
      showSnackbar(`真实提交失败：${out.scoreMessage}`, 'error')
    } else {
      // out === null：可能是被门禁/上下文丢失挡住，也可能是重复点击被忽略 ⇒ 用 phase 的说明兜底
      showSnackbar(phaseMessage.value || '真实提交未完成（未创建场次或已中止）', 'error')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logError('submit', '真实提交抛出未捕获异常（已兜住）', { message })
    showSnackbar(`真实提交异常（未完成）：${message}`, 'error')
  }
}

/** 查询判定在途标记（按钮 loading/disabled 共用；仅本组件的只读查询用） */
const verdictLoading = ref(false)

/** ⚠️ 2026-09-21：查询判定会写过程清单，连点会重复插入 ⇒ 加锁（进行中禁用并转圈） */
/**
 * ⚠️ 2026-09-21（审计 B1）：查询判定会往过程清单里插一行「⑥ 读回判定」，**两条路径都会调它** ——
 * ① 用户点按钮；② 提交流程 `doRealSubmit` 自己那次（`await onFetchVerdict(out.scantronId)`）。
 * 原先只锁了按钮自己发起的那一次，而 `phase` 在提交流程调 `fetchVerdict` **之前**就已落定 `'done'`
 * ⇒ `submitInFlight` 变 false、按钮此刻可点 ⇒ 两边并发各插一行 ⑥。
 * 现在**两条路径共用同一把锁**（`id` 可选：按钮传 undefined，提交流程传 scantronId）。
 */
async function onFetchVerdict(id?: string) {
  if (verdictLoading.value) return
  verdictLoading.value = true
  try {
    await fetchVerdict(id)
  } finally {
    verdictLoading.value = false
  }
}
</script>
