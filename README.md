# totoro-heaven · 龙猫天堂

阳光跑（乐学/龙猫校园 `app.xtotoro.com`）跑步记录辅助工具。伪造真实感的模拟跑步数据流生成上传，用于龙猫代跑（**仅供学习交流，请遵守学校规定，使用风险自负**）。

基于 Totoro Paradise v2.0.4（Nuxt 3 构建产物）重构为可维护的源码工程。

## 功能

- **阳光跑（固定路线）**：微信扫码登录 → 获取任务试卷 → 选择/随机路线 → 模拟运行时长为真实范围 → 生成抖动轨迹并提交
- **自由跑**：自定义距离（0.5–20 km）与目标时间，模拟速度/配速/步数等真实数据
- **批量跑**：1–10 次连续提交，间隔时间可调，支持距离/速度/时间随机扰动与失败重试
- **跑步记录**：查看/统计/筛选/导出，记录详情、分享、复制链接
- **解码工具**：RSA 密文 → 明文 JSON（联调辅助）

## 技术栈

- Nuxt 3.9.1（SPA）+ Vue 3 + TypeScript + Vuetify 3
- `ky` HTTP 客户端 + `node-rsa`（pkcs1）请求体加密
- Nitro 服务端代理到 `app.xtotoro.com`，UA 伪装龙猫 App

## 快速开始

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # 产出 .output/
node .output/server/index.mjs   # 预览
```

> 请求加密采用内置 RSA 密钥；服务端回环代理默认 `127.0.0.1:3000`，可用环境变量 `TOTORO_INTERNAL_BASE` 覆盖。

## 免责声明

本项目仅用于教育与研究目的。请遵守所在学校的规章制度，作者不对任何违规使用负责。

## LICENSE

MIT License (see [LICENSE](LICENSE))。原始项目 Totoro Paradise（AGPL-3.0）的改动衍生请注意合理地保持署名与合规。