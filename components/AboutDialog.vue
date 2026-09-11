<template>
  <v-dialog v-model="model" max-width="480">
    <v-card>
      <v-card-title class="d-flex align-center pt-4">
        <v-icon color="primary" size="32" class="mr-2">mdi-weather-sunny</v-icon>
        <span class="text-h6 font-weight-bold">龙猫天堂</span>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">Totoro Heaven</span>
      </v-card-title>
      <v-card-subtitle class="pb-2">阳光跑（乐学/龙猫校园）跑步记录辅助工具 · 微信小程序后端线</v-card-subtitle>

      <v-divider />

      <v-card-text>
        <v-list density="compact" class="pa-0">
          <v-list-item prepend-icon="mdi-tag-outline" title="版本" :subtitle="`v${version}`" />
          <v-list-item prepend-icon="mdi-account-circle-outline" title="作者" subtitle="Mizuki" />
          <v-list-item prepend-icon="mdi-github" title="GitHub">
            <template #append>
              <a
                href="https://github.com/dboycht/totoro-heaven"
                target="_blank"
                rel="noopener"
                class="text-primary text-decoration-none text-subtitle-2"
              >
                dboycht/totoro-heaven
              </a>
            </template>
          </v-list-item>
          <v-list-item prepend-icon="mdi-scale-balance" title="许可" subtitle="MIT License" />
        </v-list>

        <v-alert type="info" variant="tonal" density="compact" class="mt-3">
          仅用于教育与研究目的，请遵守所在学校的规章制度，作者不对任何违规使用负责。
        </v-alert>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn color="primary" variant="tonal" @click="model = false">关闭</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
const model = defineModel<boolean>({ default: false })

const appConfig = useAppConfig()
const version = computed(() => (appConfig.version as string) || 'dev')
</script>