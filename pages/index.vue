<template>
  <div>
    <v-alert type="warning" variant="tonal" class="mb-4" density="comfortable">
      <template #prepend>
        <v-icon>mdi-alert-decagram-outline</v-icon>
      </template>
      <div class="font-weight-bold">旧 App 后端已下线</div>
      <div class="text-body-2">
        学校侧校园跑服务已整体迁移到微信小程序「龙猫体育锻炼」。原 <code>app.xtotoro.com</code> 通道
        （扫码登录 + RSA 加密 + Cookie 透传）在本仓库中<strong>已彻底移除</strong>，1.0.4 及更早版本不再可用。
      </div>
    </v-alert>

    <v-card class="mb-4">
      <v-card-title class="d-flex align-center">
        <v-icon color="primary" class="mr-2">mdi-cellphone-link</v-icon>
        微信小程序后端线（1.1.x）
      </v-card-title>
      <v-card-subtitle>当前唯一后端通道 · 契约来自逆向分析，真包抓包后仍需逐条核对</v-card-subtitle>
      <v-card-text>
        <v-list density="compact">
          <v-list-item prepend-icon="mdi-server-network" title="后端地址" subtitle="https://wxxcx.xtotoro.com（路径前缀 /wxxcx）" />
          <v-list-item prepend-icon="mdi-shield-key-outline" title="鉴权" subtitle="Authorization: Bearer <token>" />
          <v-list-item prepend-icon="mdi-lock-open-variant-outline" title="请求体" subtitle="明文 JSON（不再使用 RSA 私钥加密）" />
          <v-list-item prepend-icon="mdi-swap-horizontal" title="本机代理" subtitle="/api/mp/** → wxxcx.xtotoro.com/wxxcx/**（GET + POST 透传）" />
          <v-list-item prepend-icon="mdi-content-save-outline" title="会话存储" subtitle="localStorage mp_session" />
          <v-list-item
            prepend-icon="mdi-account-check-outline"
            title="会话状态"
            :subtitle="isLoggedIn ? '已持有 token' : '未登录（待接入 token 录入 / 微信登录）'"
          />
        </v-list>
      </v-card-text>
    </v-card>

    <v-row>
      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1">
            <v-icon color="success" class="mr-2">mdi-check-circle-outline</v-icon>
            已就绪的模块
          </v-card-title>
          <v-card-text>
            <v-list density="compact">
              <v-list-item prepend-icon="mdi-file-document-outline" title="契约与类型" subtitle="src/mp/types.ts（含 TODO(verify) 标注）" />
              <v-list-item prepend-icon="mdi-vector-polyline" title="轨迹拟合度算法" subtitle="utils/mp/routeSimilarity.ts（5m 采样 / 25m 容差）" />
              <v-list-item prepend-icon="mdi-map-marker-path" title="走廊式轨迹生成" subtitle="utils/mp/generateRoute.ts（弧长推进 + OU 相关抖动）" />
              <v-list-item prepend-icon="mdi-timer-outline" title="数据自洽与格式化" subtitle="utils/mp/runData.ts（时长/配速/步数/卡路里/飞点）" />
              <v-list-item prepend-icon="mdi-api" title="接口封装" subtitle="src/wrappers/MpApiWrapper.ts" />
              <v-list-item prepend-icon="mdi-test-tube" title="单测与类型检查" subtitle="npm run test:mp / npm run typecheck:mp" />
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1">
            <v-icon color="warning" class="mr-2">mdi-progress-wrench</v-icon>
            尚待完成
          </v-card-title>
          <v-card-text>
            <v-list density="compact">
              <v-list-item prepend-icon="mdi-bug-outline" title="真包抓包核对" subtitle="字段全集 / 时间格式 / fitDegree 口径 / 签名 header" />
              <v-list-item prepend-icon="mdi-login-variant" title="登录入口" subtitle="token 录入或微信登录（wx.login code 换 token）" />
              <v-list-item prepend-icon="mdi-view-dashboard-outline" title="业务页面" subtitle="阳光跑 / 自由跑 / 记录 / 地图 —— 页面尚未开发" />
              <v-list-item prepend-icon="mdi-shield-alert-outline" title="风控适配" subtitle="随机人脸（faceBase64）/ cheatCode / 打卡点围栏" />
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-alert type="info" variant="tonal" class="mt-4" density="comfortable">
      <div class="font-weight-bold mb-1">使用风险</div>
      <div class="text-body-2">
        小程序版新增虚拟定位检测（检测到即阻断成绩）、随机人脸抽查、轨迹拟合度校验、运动传感器分析等多重风控。
        本项目仅用于教育与研究目的，请遵守所在学校的规章制度，作者不对任何违规使用负责。
      </div>
    </v-alert>
  </div>
</template>

<script setup lang="ts">
import { useMpSession } from '~/composables/useMpSession'

const { isLoggedIn } = useMpSession()
</script>
