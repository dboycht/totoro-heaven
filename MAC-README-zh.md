# MAC 上手说明（totoro-heaven 搬迁包）

> 打包日期：2026-11-19　包内版本：`package.json` = **1.3.8**（最新已发布为 1.3.7）
> 本文件只写「在 Mac 上怎么开始」与「哪些东西在 Mac 上不一样」；项目机制与当前状态见同目录 `DEVELOPMENT.md` / `HANDOVER.md`。

## 一、装环境

- **Node.js ≥ 20**（建议 22 或 24 LTS；Windows 侧开发用的是 Node 24）。
- **npm**（随 Node 自带）。本项目是 **npm 项目**（有 `package-lock.json`），**不要**用 pnpm / yarn。

## 二、跑起来

**Mac 版启动（推荐，2026-11-22 起）**——双击 `pack/mac/totoro-heaven-mac.command`，或命令行：

```bash
cd <解压目录>
npm install          # 会执行 postinstall: nuxt prepare
npm run mac          # 自动构建（首次约 1 分钟）→ 起本地服务（只绑 127.0.0.1）→ 自动开浏览器
```

启动器带**单实例**语义：已在运行时再启动会自动打开浏览器指向现有实例并退出；端口 3000~3020 被别的程序占用会自动顺延。终端横幅与 Windows EXE 同款（`pack/sea/banner.mjs` 单一来源）。

开发模式（改代码/跑探针用）：

```bash
npm run dev          # 浏览器打开 http://localhost:3000
```

⚠️ 必须用 `localhost`，不要用 `127.0.0.1` —— 两者是两份 localStorage，登录态不共享。

## 三、验证命令

```bash
npm run test:mp                          # 单测（固定共享目录，别并行跑）
TZ=UTC npm run verify                    # 全量门禁 = 单测 + 三个 typecheck + check:wiring(R1~R15) + selftest:wiring
node _mp-analyze/scratch/verify_docs.mjs # 文档自检（已知差异见第五节）
```

浏览器探针（dev 起着，且**必须显式传 base**）：

```bash
node _mp-analyze/scratch/verify_ytu_run.mjs http://localhost:3000
node _mp-analyze/scratch/verify_real_path.mjs http://localhost:3000
```

## 四、Mac 上与 Windows 的四处差异（重要）

1. **打 EXE 不可用**：`npm run sea` 走 `pack/sea/build-sea.ps1`（PowerShell + rcedit/postject 注入 Windows 图标资源）。Mac 上的对应体验是 **`npm run mac` / 双击 `pack/mac/totoro-heaven-mac.command`**（见第二节）。
2. **一键获取 token 在 Mac 上灰禁（2026-11-22 起）**：扫描器用 Win32 调试 API 只读 **Windows 微信客户端**进程内存。工作台按钮在 Mac 上是灰色禁用态（服务端 `/api/local/token-scan/start` 也 fail-closed 拒绝）。**Mac 拿 token 走手动路线**：抓包工具抓一条 `wxxcx.xtotoro.com` 请求 → 把 `Authorization: Bearer` 后面那串粘贴到工作台 token 输入框 → 点「读取真实账号与任务」。首次教程在 Mac 上也自动换成这条路线。（Mac 微信内存扫描的技术可行性研究 2026-11-21 起挂起，见 `logs/2026-11-21-mac-token-scan-feasibility.md`。）
3. **脚本里写死的 Windows 路径**（2026-11-20 状态：探针主链已修完，发布类仍保留）：
   - ✅ 已修（按脚本位置推 / 指向本机 canonical）：`_run_probe_family.sh`、`_rerun_*.sh`、`status.sh`、`selftest_memory_index.sh`（本工作区 memory 无编号索引行时**如实跳过**）、`selftest_error_toc.sh`、`verify_dev_parity.mjs`、`verify_real_path_batch.mjs`、`verify_real_path_place.mjs`；
   - 仍写死 `D:`（发布/一次性用，Mac 上不跑）：`verify_release.mjs`、`upload_asset.mjs`、`publish_release*.mjs`、`probe_mornsign_records.mjs`、`probe_freerun_real.mjs`、`_tmp_title_numbers.mjs`、`diff_contracts_v65_v67.mjs`（`verify_docs.mjs` 的命中只是跨项目引用白名单注释）。
4. **无关文件**：`打开GitBash终端.bat`、`desktop.ini`、各 `.ps1` 是 Windows 向，忽略即可。

## 五、包内容与已知差异

- **含**：canonical 全部跟踪源码（`src/` `server/` `utils/` `pages/` `components/` `composables/` `public/` `tests/` `pack/` `scripts/` `app/` …）、四份开发文档（`DEVELOPMENT.md` / `HANDOVER.md` / `ACCEPTANCE.md` / `ERROR.md`）、`logs/` 全部、`_mp-analyze/` 的研究文档与探针脚本。
- **不含**（有意裁掉）：`node_modules/`、`.nuxt/`、`.output/`、`dist/`、`.tmp/`、`_mp-analyze/capture/`（抓包，隐私）、`_mp-analyze/` 下的解包产物（`extracted/`、`Totoro-main*/`、`v67/`、`v70/`、`v73/`、`*.wxapkg`）、安卓 `app/` 的构建产物。
- 因此 `_mp-analyze/README.md`、`DEVELOPMENT.md`、`ERROR.md` 里凡点名上述目录/文件的引用，在 Mac 上**指向不存在**；跑 `verify_docs.mjs` 的 A 节可能报若干「引用无法解析」——**那是搬迁裁掉材料的结果，不是文档错**。缺的材料仍在 Windows 侧开发副本 `D:\code\DeepSeekHarness\totoro-heaven`。
- 工作区级 `rules/` 与 `memory/` 不在项目内、本包也未含（它们在工作区根，不是仓库内容）。

## 六、纪律提醒（搬迁不改变）

- **推送只在 canonical 进行**：Mac 上 canonical = `/Users/mizuki/Documents/file/github/totoro-heaven`（2026-11-20 起）；本包（开发副本）仍不是 git 仓库，改完**逐文件复制**过去再 commit + push。
- **升号 / 打 tag / 发 Release 只由用户触发**；发布前必须先交用户验收。
- **token 任何形态不落盘、不打印**；不查询 / 枚举 / 留存非本人学生数据；不做挑衅性实验。
- 夜间纪律 22:30~06:00 停真实提交（只拦真实提交，本地模拟与预览照旧）。

## 七、先读哪几份

| 想知道 | 文件 |
| --- | --- |
| 项目机制 / 目录地图 / 约定 / 已知问题 | `DEVELOPMENT.md` |
| 当前状态与待办 | `HANDOVER.md` |
| 验收项与实测结论 | `ACCEPTANCE.md` |
| 踩过的坑（E0–E109） | `ERROR.md` |
| 开发日志索引 | `logs/README.md` |
| 逆向研究总入口 | `_mp-analyze/README.md`（注意第五节的差异） |
