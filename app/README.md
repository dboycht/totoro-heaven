# 龙猫实地采数（totoro-field）

给 **totoro-heaven** 配的安卓采数工具：**拿着手机去操场真跑一圈，把真实 GPS 数据带回来。**

一个独立 APK，**不联网、不上报、不需要 token** —— 它只做一件事：用与官方小程序
**逐行等价**的口径记录你的真实轨迹，算出里程 / 用时 / 配速 / 拟合度，导出成 JSON。

---

## 为什么需要它

Windows 端的 totoro-heaven 要生成"真实感轨迹"，但**真实学生跑出来到底是什么样**，
一直没有第一手数据（`memory/10` 记的是模拟经验，不是实测）。

这个 App 就是去补那一课：**你去操场跑一圈，我们拿到真实手机的 GPS 采样分布** ——
精度中位数、丢点率、静止时的抖动幅度、真实配速下的点间距。有了它，
"生成的数据一眼假"这个问题才有客观参照。

---

## 三条硬设计（都不许改）

| # | 设计 | 为什么 |
| --- | --- | --- |
| 1 | **不申请 `INTERNET` 权限** | 从系统层面保证它**无法**上传任何东西。不是"我们承诺不上传"，是"它传不出去" |
| 2 | **算法与官方小程序逐行等价** | 里程/配速/卡路里/拟合度是判分口径的一部分，不能自己发明。每个常数都标了 v73 源码出处 |
| 3 | **如实记账** | 丢了多少点、为什么丢、精度分布如何 —— 全部导出。**数据要能解释，才敢用** |

---

## 拿手机怎么用

### 装

```bash
adb install -r totoro-field-0.1.0.apk
```

（或直接把 APK 发到手机上点安装，允许"安装未知来源应用"即可。）

### 跑

1. 打开 App → 点「授予权限」→ 选**「使用应用时允许」或「始终允许」**（**必须给精确位置**）；
2. 站在跑道起点，**等精度读数稳定**（右上角会显示"最近一次：gps · 精度 X m"，
   等它降到 **10 m 以内**再开始 —— 这是真机上最影响数据质量的一步）；
3. 点「开始记录」，**把手机揣兜里正常跑**；
4. 跑完点「结束」→ 点「导出文件」→ 点「分享出去」发到微信/网盘/邮件（或连电脑拷）。

### 关于"手机揣兜里"

本 App 用的是**前台服务 + `FOREGROUND_SERVICE_LOCATION`**，通知栏会常驻一条
「正在记录真实轨迹」。**息屏后照常收点，不需要**像官方小程序那样去关省电模式、
加后台白名单。但有一件事必须做：

> ⚠️ **跑之前确认屏幕上那个公里数在动。**
> 如果它一直不动，App 会在 20 秒后弹出橙色的
> 「⚠️ 位置没有在变」警告 —— 那说明 GPS 没锁上星（去开阔处等 10~30 秒）、
> 手机挡了天线、或系统冻结了定位。**这时候跑完就是白跑。**

---

## 它到底记了什么

界面上的「采点质量」和导出 JSON 里的 `samplingQuality` 是同一份数据：

| 字段 | 含义 |
| --- | --- |
| `rawSamples` | 系统一共回调了多少次 |
| `accepted` | 有多少个点进了轨迹（= 提交时 `pointList` 的长度） |
| `droppedByAccuracy` | 精度 > 80 m 被丢掉的 |
| `droppedAsFlyPoint` | 判定为"瞬移飞点"被丢掉的 |
| `jitterSmoothed` | 疑似飞点、被向上一位置拉近 90% 的 |
| `zeroedShortSteps` | 位移 < 1.5 m、按 0 计但仍入轨的 |
| `rawPathMeters` / `billedMeters` | 轨迹实长 vs 计费里程（能看出过滤链吃掉了多少） |
| `accuracyMedian / P90 / best / worst` | **真实精度分布** —— 这批数据可不可信，看它 |

---

## 导出格式

```jsonc
{
  "schema": "totoro-field-run/1",
  "exportedAt": "2026-11-02 09:12:33",
  "note": "操场 4 圈",                     // 你填的备注

  "summary": {
    "startTime": "2026-11-02 09:05:10",
    "km": "3.21",                          // 与提交报文的 km 同口径
    "usedTime": "00:20:25",
    "avgSpeed": "6'22\"",                  // M'SS"，源码 calSpeed 口径
    "kcal": "182.34",                      // 55 × km × 1.036
    "fitDegree": "0.94",                   // 填了参考路线才有；空串 = 不适用
    "pointCount": 1183
  },

  // 可直接喂给 sunRunExercisesDetail 的形状：每点只有这三个字段
  "submitPoints": [ { "latitude": 32.041, "longitude": 118.723, "time": "09:05:12" } ],

  // 完整样本（含精度/海拔/速度），用来分析"真实感"
  "points": [ { "latitude": ..., "longitude": ..., "accuracy": 8.4, "altitude": 12.1, ... } ],

  "samplingQuality": { /* 上表那批计数 */ },
  "device": { "brand": "Xiaomi", "model": "...", "androidRelease": "15", "providers": ["gps"] }
}
```

同时会写一份 `.csv`（点表，便于直接画图）。文件落在应用私有目录
`/data/data/io.github.dboycht.totorofield/files/runs/`，取回方式：

```bash
adb shell run-as io.github.dboycht.totorofield ls files/runs
adb exec-out run-as io.github.dboycht.totorofield cat files/runs/run-<时间戳>.json > run.json
```

---

## 可选：填参考路线，顺便算拟合度

把官方线路点贴进「参考路线」框（两种写法都认）：

- 每行 `lat,lng`；
- 或直接贴 `getSunrunArchDetail` 返回的 `pointList` JSON 片段。

填了之后界面实时显示拟合度，算法就是小程序那个
`calculateRouteSimilarity(route, userRoute, 5, 25)`：参考线每 **5 m** 加密采样，
到轨迹折线距离 **≤ 25 m** 记命中，命中率即拟合度。

> 📌 本任务**没下发线路**时（`kind === 'free'`）拟合度本就**不适用** ——
> 这种情况下导出里 `fitDegree` 是空串、`fitDegreeApplicable: false`，
> 而不是 `0`。**"不适用"与"0 分"是两回事**，别混。

---

## 开发

```bash
cd app
./gradlew :app:assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest    # 14 个单测
node tools/verify_track_math.mjs    # 17 项算法验证（纯 Node，不需要安卓）
```

需要 `local.properties` 指向 SDK（**不入库**）：

```properties
sdk.dir=D\:\\Program\\Android\\SDK
```

### 目录

```
app/
├─ app/src/main/java/io/github/dboycht/totorofield/
│  ├─ TrackMath.kt       # 与小程序逐行等价的算法（距离/拟合度/配速/卡路里），纯函数
│  ├─ TrackEngine.kt     # 采点过滤链（精度/飞点/抖动/短步）+ 如实记账
│  ├─ TrackService.kt    # 前台服务，息屏继续收点 + 冻结检测
│  ├─ TrackExport.kt     # JSON / CSV 导出
│  └─ MainActivity.kt    # 单页界面（Compose）
├─ app/src/test/...      # 14 个单测
└─ tools/verify_track_math.mjs   # 算法验证（Node 跑，与单测互为对照）
```

### 算法口径的出处

全部取自解包产物 **v73** 的 `app-service.js`（运行页 `handleLocationChange` 及其同页函数）：

| 口径 | 源码依据 |
| --- | --- |
| 精度 > 80 m 丢弃（起跑前放宽） | `if (t.accuracy > 80) { if (w) return }` |
| 飞点 > 12 m/s（精度差时 > 8） | `if (T > 12 \|\| (t.accuracy > 50 && T > 8)) return` |
| 疑似飞点 > 6 m/s（精度差时 > 4.5），最多连续 5 次 | `if ((T > 6 \|\| (t.accuracy > 35 && T > 4.5)) && (_ = !0), _ && ++S >= 5 && …` |
| 短步 < 1.5 m 归零 | `if ((o = c) < 1.5) o = 0` |
| 拟合度 5 m / 25 m | `calculateRouteSimilarity(a, i, 5, 25)` |
| 配速 `M'SS"`、上限 99 分 | `calSpeed` |
| 卡路里 `55 × km × 1.036` | `CalMotionCalories` |

---

## 已知边界

- **必须在真机上跑。** 安卓模拟器的 GPS 引擎（Android Studio Emulator GPS）
  在部分 AVD 上只回一个固定假坐标、`geo fix` 无效 —— 本机实测就是这样，
  所以**模拟器只能验界面，不能验数据**。算法正确性由那 17 项 Node 验证 + 14 个单测保证。
- **没有地图。** 导出后到电脑上用 `_mp-analyze/scratch/viz_real_track.mjs` 那套看。
- **不提交、不上报。** 这是采数工具，不是打卡工具；服务端交互仍走 Windows 端。

---

本作品以 **CC BY-NC 4.0** 发布，作者 `Mizuki`，仓库
https://github.com/dboycht/totoro-heaven 。仅供本人真实跑步的记录与学习用途，
请遵守你所在学校的规定，风险自负。
