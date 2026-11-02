package io.github.dboycht.totorofield

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 轨迹算法 —— **与官方小程序逐行等价**（唯一来源：解包产物 v73 `app-service.js`）。
 *
 * 本项目存在的理由就是"拿着真机去操场跑一圈，拿到真实 GPS 数据"，
 * 所以这些算法**一个常数都不能自己发明**：它们是判分口径的一部分。
 *
 * 逆向到的原文（v73 `app-service.js` 第 14045 行那一页，逐字）：
 *
 * ```
 * // 拟合度：参考路线 route 与候选轨迹 userRoute，每 5 米加密采样，容差 25 米
 * calculateRouteSimilarity(route, userRoute, sampleStep = 5, tolerance = 25)
 *
 * // 采点丢弃（handleLocationChange）
 * if (t.accuracy > 100) { ...提示"正在搜索高精度GPS信号..." }      // 只提示，不丢
 * else {
 *   if (t.accuracy > 80) { if (已锚定) return; }                    // 未锚定：放宽，当锚点
 *   ... 速度 = 距离 / 间隔秒 ...
 *   if (速度 > 12 || (t.accuracy > 50 && 速度 > 8)) 彻底丢弃        // 飞点
 *   else if ((速度 > 6 || (t.accuracy > 35 && 速度 > 4.5))) { 疑似飞点，计数 }
 *   ...
 *   if (距离增量 < 1.5) 距离增量 = 0                                // 静止抖动不累加
 * }
 * // 公里数 = 累计米数 / 1000，toFixed(2)
 * // 配速 = 总分钟 / 公里数，格式 M'SS"
 * // 卡路里 = 55 × 公里 × 1.036
 * ```
 */
object TrackMath {

    /** 地球平均半径（米）——与小程序源码常量一致（源码写作 6371e3） */
    private const val EARTH_RADIUS_M = 6371e3

    // ---------- 采点口径（全部逐字取自 v73 源码，勿自行调整） ----------

    /** 小程序把 `accuracy > 100` 的样本只用于提示"正在搜索高精度GPS信号"，**不丢弃** */
    const val ACCURACY_HINT_M = 100.0

    /** 起跑前 `accuracy > 80` 的新样本不建锚点（等更好的信号）；锚定后 >80 直接丢弃 */
    const val ACCURACY_DROP_M = 80.0

    /** 飞点：瞬时速度上限（m/s）。`> 12` 直接丢；`accuracy > 50` 时收紧到 `> 8` */
    const val FLY_SPEED_MPS = 12.0
    const val FLY_SPEED_LOW_ACC_MPS = 8.0
    const val FLY_ACC_LOW_M = 50.0

    /** 疑似飞点：`> 6`；`accuracy > 35` 时收紧到 `> 4.5`（最多连续 5 个） */
    const val JITTER_SPEED_MPS = 6.0
    const val JITTER_SPEED_LOW_ACC_MPS = 4.5
    const val JITTER_ACC_LOW_M = 35.0

    /** 连续疑似飞点达到这个数量就停用"疑似"判定（源码 `++S >= 5` 后复位） */
    const val JITTER_MAX_STREAK = 5

    /** 距离增量小于该值按 0 计（站在原地抖动不涨里程） */
    const val MIN_STEP_M = 1.5

    /** 拟合度：加密采样步长（米） */
    const val FIT_SAMPLE_STEP_M = 5.0

    /** 拟合度：命中容差（米） */
    const val FIT_TOLERANCE_M = 25.0

    // ---------- 基础几何 ----------

    private fun toRad(deg: Double) = deg * Math.PI / 180.0

    /** 两点球面距离（米）——haversine，与小程序 `getDistance` 同式 */
    fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val dLat = toRad(lat2 - lat1)
        val dLng = toRad(lng2 - lng1)
        val h = sin(dLat / 2) * sin(dLat / 2) +
            cos(toRad(lat1)) * cos(toRad(lat2)) * sin(dLng / 2) * sin(dLng / 2)
        return EARTH_RADIUS_M * (2 * atan2(sqrt(h), sqrt(1 - h)))
    }

    /** 点 P 到线段 AB 的最短距离（米）——等距圆柱近似下的投影，与源码一致 */
    fun pointToSegmentDistance(
        plat: Double, plng: Double,
        alat: Double, alng: Double,
        blat: Double, blng: Double,
    ): Double {
        val dx = blat - alat
        val dy = blng - alng
        val lenSq = dx * dx + dy * dy
        var t = -1.0
        if (lenSq != 0.0) t = ((plat - alat) * dx + (plng - alng) * dy) / lenSq
        val clat: Double
        val clng: Double
        when {
            t < 0 -> { clat = alat; clng = alng }
            t > 1 -> { clat = blat; clng = blng }
            else -> { clat = alat + t * dx; clng = alng + t * dy }
        }
        return distanceMeters(plat, plng, clat, clng)
    }

    /** 轨迹累计长度（米） */
    fun pathLengthMeters(points: List<LatLng>): Double {
        if (points.size < 2) return 0.0
        var total = 0.0
        for (i in 0 until points.size - 1) {
            total += distanceMeters(
                points[i].latitude, points[i].longitude,
                points[i + 1].latitude, points[i + 1].longitude,
            )
        }
        return total
    }

    /**
     * 拟合度计算（0~1）。**与小程序 `calculateRouteSimilarity` 逐行等价。**
     *
     * 语义：把**参考路线**（官方线路点）按每 5 米加密采样，对每个采样点求到候选轨迹各段的
     * 最短距离，≤ 25 米即记为命中；命中率即拟合度。
     *
     * @param route     参考路线（官方 `pointList`）
     * @param userRoute 真实采集到的轨迹
     */
    fun calculateRouteSimilarity(
        route: List<LatLng>,
        userRoute: List<LatLng>,
        sampleStepM: Double = FIT_SAMPLE_STEP_M,
        toleranceM: Double = FIT_TOLERANCE_M,
    ): Double {
        if (route.size < 2 || userRoute.size < 2) return 0.0

        var matched = 0
        var checked = 0

        for (i in 0 until route.size - 1) {
            val (alat, alng) = route[i].let { it.latitude to it.longitude }
            val (blat, blng) = route[i + 1].let { it.latitude to it.longitude }
            val segLen = distanceMeters(alat, alng, blat, blng)
            var steps = ceil(segLen / sampleStepM).toInt()
            if (steps < 1) steps = 1

            for (s in 0 until steps) {
                val ratio = s.toDouble() / steps
                val plat = alat + (blat - alat) * ratio
                val plng = alng + (blng - alng) * ratio

                var minDist = Double.MAX_VALUE
                for (j in 0 until userRoute.size - 1) {
                    val d = pointToSegmentDistance(
                        plat, plng,
                        userRoute[j].latitude, userRoute[j].longitude,
                        userRoute[j + 1].latitude, userRoute[j + 1].longitude,
                    )
                    if (d < minDist) minDist = d
                    if (minDist <= toleranceM) break
                }
                if (minDist <= toleranceM) matched++
                checked++
            }
        }

        if (checked == 0) return 0.0
        return matched.toDouble() / checked.toDouble()
    }

    // ---------- 展示口径（同样逐字取自 v73 源码） ----------

    /** 公里数：`(米 / 1000).toFixed(2)` */
    fun kmText(meters: Double): String = String.format("%.2f", meters / 1000.0)

    /**
     * 平均配速，形如 `M'SS"`（源码 `calSpeed`）。
     * 总分钟 = 时×60 + 分 + 秒/60；配速 = 总分钟 / 公里数；上限 99 分。
     */
    fun paceText(elapsedSeconds: Long, km: Double): String {
        if (km <= 0.0 || elapsedSeconds <= 0) return "0'00\""
        val minutes = elapsedSeconds / 60.0
        var pace = minutes / km
        if (!pace.isFinite() || pace <= 0) return "0'00\""
        if (pace > 99) pace = 99.0
        val m = floor(pace).toInt()
        val s = floor(60 * (pace - m)).toInt()
        return "$m'${s.toString().padStart(2, '0')}\""
    }

    /** 卡路里：`55 × 公里 × 1.036`（源码 `CalMotionCalories`，体重固定 55 kg 口径） */
    fun kcalText(km: Double): String {
        if (!km.isFinite() || km <= 0) return "0.00"
        return String.format("%.2f", 55.0 * km * 1.036)
    }

    /** 用时 `HH:mm:ss` */
    fun durationText(elapsedSeconds: Long): String {
        val s = max(0L, elapsedSeconds)
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return "%02d:%02d:%02d".format(h, m, sec)
    }

    /** 日期时间 `yyyy-MM-dd HH:mm:ss`（源码 `getCurrentTime`） */
    fun stampText(epochMs: Long): String {
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
        return fmt.format(java.util.Date(epochMs))
    }

    /** 路径点时钟 `HH:mm:ss`（提交报文里 `pointList[].time` 就是这个格式——缺了整条轨迹被拒） */
    fun clockText(epochMs: Long): String {
        val fmt = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
        return fmt.format(java.util.Date(epochMs))
    }

    /**
     * 判断移动是否**疑似异常**（源码的"疑似飞点"分支：连续 5 个之后停用该判定）。
     * 抽成纯函数是为了能单测——它是"真数据 vs 脏数据"的分界线。
     */
    fun isJitterCandidate(speedMps: Double, accuracy: Double): Boolean =
        speedMps > JITTER_SPEED_MPS || (accuracy > JITTER_ACC_LOW_M && speedMps > JITTER_SPEED_LOW_ACC_MPS)

    /** 判断移动是否**必须丢弃**（飞点：`> 12`，或 `accuracy > 50` 时 `> 8`） */
    fun isFlyPoint(speedMps: Double, accuracy: Double): Boolean =
        speedMps > FLY_SPEED_MPS || (accuracy > FLY_ACC_LOW_M && speedMps > FLY_SPEED_LOW_ACC_MPS)

    /** 该样本是否应当因精度太差而丢弃（仅在已有锚点之后；起跑前放宽用于建立基准） */
    fun shouldDropForAccuracy(accuracy: Double, hasAnchor: Boolean): Boolean =
        hasAnchor && accuracy > ACCURACY_DROP_M

    /** 距离增量归零阈值 */
    fun snapStepMeters(step: Double): Double = if (abs(step) < MIN_STEP_M) 0.0 else step

    /** 把米数夹到非负有限值 */
    fun sanitizeMeters(v: Double): Double = if (!v.isFinite() || v < 0) 0.0 else v

    /** 保留两位小数的公里数（数值版） */
    fun kmValue(meters: Double): Double = Math.round(meters / 10.0) / 100.0

    /** 中位数（诊断用：看真实精度分布） */
    fun median(values: List<Double>): Double {
        if (values.isEmpty()) return 0.0
        val sorted = values.sorted()
        val mid = sorted.size / 2
        return if (sorted.size % 2 == 1) sorted[mid] else (sorted[mid - 1] + sorted[mid]) / 2.0
    }

    /** 百分位（诊断用） */
    fun percentile(values: List<Double>, p: Double): Double {
        if (values.isEmpty()) return 0.0
        val sorted = values.sorted()
        val idx = min(sorted.size - 1, max(0, floor(p * (sorted.size - 1)).toInt()))
        return sorted[idx]
    }
}

/** 一个采样点（**提交报文里只发 latitude / longitude / time 三个字段**） */
data class LatLng(
    val latitude: Double,
    val longitude: Double,
    /** 采集时刻（epoch ms）；导出时另附 `time` HH:mm:ss */
    val timestamp: Long = 0L,
    val accuracy: Double = 0.0,
    val altitude: Double = 0.0,
    /**
     * 系统给出的瞬时速度（m/s）。**负值表示"系统没给"**（`Location.hasSpeed() == false`）。
     *
     * ⚠️ **默认值必须是 -1 而不是 0**（2026-11-02 单测抓到的坑）：
     * 0 是**合法的真实读数**（"人停着"），用它当"没有速度"的哨兵，
     * 会让"系统没给速度"与"人真的静止"两种情形无法区分 ——
     * 而引擎在间隔 <1.2 秒时会优先采信系统速度 ⇒ 瞬移 2.2 km 的点被当成静止而放行。
     * 判据：**哨兵值必须落在合法值域之外**。
     */
    val speed: Double = -1.0,
    val bearing: Double = 0.0,
)
