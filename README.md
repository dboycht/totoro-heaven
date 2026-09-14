> ## 🚨 状态说明（务必先读）
>
> 学校侧的校园跑服务**已整体迁移到微信小程序**「龙猫体育锻炼」，后端从 `app.xtotoro.com` 换成 `wxxcx.xtotoro.com`，
> 接口路径、鉴权方式、加密方式与提交字段**全部不同**。
>
> - **历史 Release（1.0.4 及更早）仅适用于旧 App 后端，现已完全无法用于打卡**，请勿再下载使用。
> - 本仓库 **1.1.x 起为微信小程序后端线**：旧的 App 通道代码（扫码登录 / RSA 加密 / Cookie 透传代理）
>   **已从仓库中彻底移除**，不再随源码提供。
> - ⚠️ **当前 1.1.1 是预览版**：后端契约层已按真包实测重建，界面已有**可交互 demo**，
>   但**界面数据仍是演示数据（mock），尚未接入真实打卡链路** —— **现在还无法完成一次真实打卡**。
>   真实链路（登录 / 任务约束 / 成绩提交）将在 **1.1.2** 接入。
>
> ⚠️ 另外提醒：小程序版新增了**虚拟定位检测（检测到即阻断成绩）、随机人脸抽查、轨迹拟合度校验、运动传感器分析**
> 等多重风控。使用前请自行评估风险，作者不对任何因使用本工具产生的后果负责。

> ### ⚠️ 支持范围：只支持「龙猫体育锻炼」这一个入口；会自动跳转的学校**不支持**
>
> 本项目**只做「龙猫体育锻炼」这一个纯小程序**（AppID `wx8e8598deed63f9b1`）的后端，不做多小程序适配。
>
> 但该小程序内置了**学校重定向逻辑**（`checkSchoolRedirect`）：部分学校会被弹窗提示「服务迁移升级通知」，
> 并**跳转到该校自己的专属小程序**——此时「龙猫体育锻炼」不再是有效入口。
>
> **这类学校不在本项目的支持范围内，我们不做适配，也请不要使用本项目。**
>
> 目前源码中已知的唯一此类条目：
>
> | schoolCode | 学校 | 专属小程序 | AppID |
> | --- | --- | --- | --- |
> | `10289` | 江苏科技大学 | 江苏科技大学校园跑 | `wxfb4d255c8de7378e` |
>
> **如何判断自己是否被支持**：打开小程序后，若出现「服务迁移升级通知 / 一键前往」这类弹窗，
> 即说明你所在学校已启用专属小程序 —— **本项目不支持**。

# totoro-heaven · 龙猫天堂

阳光跑（乐学/龙猫校园）跑步记录辅助工具。伪造真实感的模拟跑步数据流生成上传，用于龙猫代跑（**仅供学习交流，请遵守学校规定，使用风险自负**）。

> 目标后端：**微信小程序**「龙猫体育锻炼」（AppID `wx8e8598deed63f9b1`）→ `https://wxxcx.xtotoro.com`。
> 旧 App 后端（`app.xtotoro.com`）自 **1.0.4** 停止维护，其代码已在 **1.1.1** 轮次中移除。

基于 Totoro Paradise v2.0.4（Nuxt 3 构建产物）重构为可维护的源码工程。

## 下载（1.1.1 预览版）

到 [Releases](https://github.com/dboycht/totoro-heaven/releases) 下载 `totoro-heaven-1.1.1.zip`，
解压后**双击 `totoro-heaven.exe`** 即可（Windows 10/11 x64，**无需安装 Node.js 或任何依赖**）。
启动后浏览器会自动打开 `http://localhost:3000/`，可完整点一遍「演示登录 → 阳光跑 → 结算 → 记录」流程。

> 再次强调：预览版的界面数据是**演示数据**，不能用于真实打卡。

## 当前进度

**已就绪**

| 模块 | 说明 | 验证 |
| --- | --- | --- |
| `src/mp/types.ts` | 端点元数据表：**56 个端点**的路径 / 方法 / 业务负载位置 / 是否需 token | 类型检查 + 表自检单测 |
| `src/mp/envelope.ts` | 三轨信封判定（`status` / `code` / `header.bizCode`）+ 逐端点负载解包 + Bearer 构造 | 单测 |
| `src/wrappers/MpApiWrapper.ts` | 请求层：**始终带 `Authorization`**、判定式调用、多租户基址解析 | 类型检查 + 真实后端冒烟 |
| `server/api/mp/[...slug].ts` | Nitro 代理 `/api/mp/**` → **按学校动态上游**（多租户） | 真实连通 |
| `utils/mp/routeSimilarity.ts` | 轨迹拟合度算法（与小程序端等价：5m 采样 / 25m 容差）+ 距离工具 | 12 单测 |
| `utils/mp/generateRoute.ts` | 走廊式轨迹生成（全局弧长推进 + OU 相关抖动），输出可提交的 `fitDegree` | 9 单测 |
| `utils/mp/runData.ts` | 时长/配速/步数/卡路里格式化 + 自洽校验 + 飞点检测 + 时间字段 | 7 单测 |
| `utils/mp/taskRules.ts` | 任务约束自检（提交前闸门，区分硬性 / 待实测口径） | 12 单测 |
| `pages/`（工作台 / 阳光跑 / 记录） | 三页可交互 demo（mock 数据驱动，跑步过程用真实算法） | UI 冒烟（真实浏览器） |

**尚待完成（1.1.2 正式版）**

- 真实登录链路：token 录入 / `wx.login` code 换 token + 学校基址解析
- 读取真实任务约束（`getSunrunPaper`）并替换演示值
- 真实提交：`getRunBegin` → `sunRunExercises` + `sunRunExercisesDetail`，并实测判分口径
- 实测 token 有效期、复验人脸 / 随机抽查开关
- 轨迹地图（当前版本按需求**不做**）

## 技术栈

- Nuxt 3.9.1（SPA）+ Vue 3 + TypeScript + Vuetify 3
- `ky` HTTP 客户端（Bearer + 明文 JSON，**不再使用 RSA 加密**）
- Nitro 服务端代理到该校 API 基址（多租户）

## 快速开始

```bash
npm install
npm run dev            # http://localhost:3000
npm run test:mp        # 75 个单测（Node 内置 test runner，零依赖）
npm run typecheck:mp   # 纯逻辑模块类型检查
npm run typecheck:ui   # composables / src / utils / server 的 .ts 类型检查
npm run build          # 产出 .output/
npm run sea            # 打单文件 EXE（见 pack/sea/build-sea.ps1）
```

## 免责声明

本项目仅用于教育与研究目的。请遵守所在学校的规章制度，作者不对任何违规使用负责。

## LICENSE

MIT License (see [LICENSE](LICENSE))。原始项目 Totoro Paradise（AGPL-3.0）的改动衍生请注意合理地保持署名与合规。
