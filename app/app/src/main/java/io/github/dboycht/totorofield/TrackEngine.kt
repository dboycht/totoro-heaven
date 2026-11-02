package io.github.dboycht.totorofield

/**
 * 采点引擎 —— **把 v73 源码的过滤链原样搬过来**，并**如实记账每一步丢了什么**。
 *
 * 与小程序源码的差异（**只有一处，且是刻意的**）：小程序把丢弃原因 `console.warn` 掉，
 * 我们把它统计下来。理由：这一轮的目的就是"拿到真实数据"，如果丢掉了一半点位却不知道，
 * 那份数据就没法解释。**过滤规则本身一个都没改。**
 */
class TrackEngine {

    /** 已接受的轨迹点（提交报文用） */
    val points = mutableListOf<LatLng>()

    /** 参考路线（官方线路点）。为空 = 不判拟合度（服务端没下发线路的任务，口径同小程序） */
    var referenceRoute: List<LatLng> = emptyList()

    var meters: Double = 0.0
        private set

    /** 起跑锚点：第一个被接受的样本（源码里的 `w`） */
    private var anchor: LatLng? = null

    /** 连续"疑似飞点"计数（源码里的 `S`） */
    private var jitterStreak = 0

    /**
     * "疑似飞点"判定是否已被停用（连续满 [TrackMath.JITTER_MAX_STREAK] 个之后）。
     * 语义：连着好几个都像飞点 ⇒ 更可能是用户在**真的快速移动**（骑车/坐车），
     * 这时不该再把点往旧位置拉 —— 否则会把真实位移抹掉。
     */
    private var jitterDisabled = false

    // ---------- 如实记账（界面与导出都要用） ----------
    var rawSamples: Int = 0; private set
    var droppedAccuracy: Int = 0; private set
    var droppedFly: Int = 0; private set
    var zeroedSteps: Int = 0; private set
    var jitterSmoothed: Int = 0; private set
    private val accuracies = mutableListOf<Double>()

    /** 当前是否已建立起跑锚点 */
    val hasAnchor: Boolean get() = anchor != null

    /** 最近一次样本的精度（米）；0 = 还没有样本 */
    var lastAccuracy: Double = 0.0; private set

    /** 是否正在"搜索高精度信号"（源码：accuracy > 100 且还没锚定时提示用户） */
    var searchingSignal: Boolean = false; private set

    val km: Double get() = meters / 1000.0

    /** 精度统计（导出里给一段"这批数据有多可信"的量化说明） */
    fun accuracyStats(): AccuracyStats = AccuracyStats(
        samples = accuracies.size,
        median = TrackMath.median(accuracies),
        p90 = TrackMath.percentile(accuracies, 0.90),
        worst = accuracies.maxOrNull() ?: 0.0,
        best = accuracies.minOrNull() ?: 0.0,
    )

    fun reset() {
        points.clear()
        anchor = null
        jitterStreak = 0
        jitterDisabled = false
        meters = 0.0
        rawSamples = 0
        droppedAccuracy = 0
        droppedFly = 0
        zeroedSteps = 0
        jitterSmoothed = 0
        lastAccuracy = 0.0
        searchingSignal = false
        accuracies.clear()
    }

    /** 采点结果：给界面用的一句话反馈 */
    enum class Verdict { ACCEPTED, ANCHOR, DROPPED_ACCURACY, DROPPED_FLY, DROPPED_JITTER }

    /**
     * 送入一个原始定位样本，按小程序的口径决定"收、丢、还是平滑"。
     *
     * 逐行对应 v73 `handleLocationChange`：
     * 1. `accuracy > 100` ⇒ 还没有 5 个点时不建锚点，只提示"正在搜索高精度GPS信号"；
     * 2. `accuracy > 80` ⇒ **已有锚点时直接丢弃**（源码 `if (w) return`）；
     * 3. 速度 = 距离增量 / 间隔秒；`> 12`（或 `accuracy > 50` 且 `> 8`）⇒ 飞点，彻底丢弃；
     * 4. `> 6`（或 `accuracy > 35` 且 `> 4.5`）⇒ 疑似飞点，把新点向上一接受点拉近 90%，
     *    且**本次距离增量按 0 计**；连续 5 个之后停用该判定；
     * 5. 距离增量 `< 1.5 m` ⇒ 按 0 计。
     */
    fun offer(sample: LatLng): Verdict {
        rawSamples++
        lastAccuracy = sample.accuracy
        accuracies.add(sample.accuracy)

        // ① 精度差到 100 米以上：源码只在"还没攒够 5 个点"时提示，采样本身不拦
        if (sample.accuracy > TrackMath.ACCURACY_HINT_M) {
            if (points.size < 5) searchingSignal = true
        } else {
            searchingSignal = false
        }

        // ② 精度 > 80：已有锚点 ⇒ 丢弃；没有锚点 ⇒ 放宽（用它建立起点基准）
        if (TrackMath.shouldDropForAccuracy(sample.accuracy, hasAnchor)) {
            droppedAccuracy++
            return Verdict.DROPPED_ACCURACY
        }

        val prev = anchor
        if (prev == null) {
            anchor = sample
            points.add(sample)
            return Verdict.ANCHOR
        }

        val spanSec = (sample.timestamp - prev.timestamp) / 1000.0
        if (spanSec <= 0) {
            droppedAccuracy++
            return Verdict.DROPPED_ACCURACY
        }

        var step = TrackMath.distanceMeters(prev.latitude, prev.longitude, sample.latitude, sample.longitude)
        var accepted = sample

        /**
         * 速度取值（源码：`u < 1.2 ? (t.speed && t.speed >= 0 ? t.speed : 0) : c / u`）。
         *
         * ⚠️ **2026-11-02 修过的两个坑（模拟器 + 单测各逼出一个）**：
         *
         * ① 照抄成"间隔 < 1.2 秒就一律用系统速度"，会在系统**不给速度**时把 speed 恒当 0
         *    ⇒ 飞点判定永远不触发，而距离增量仍被算出来 ⇒ 里程里灌水。
         * ② 更隐蔽的一层：即便系统**给了**速度，它也可能是**陈旧值**（GPS 芯片复用的上一帧）。
         *    实测形态：1 秒内坐标跳了 2.2 km，而 `Location.speed` 报 0
         *    ⇒ 按 ① 修好"缺速度"仍然不够。
         *
         * ⇒ **最终判据（两条一起，才既能挡飞点又不误伤真跑）**：
         *    · 系统速度**只在它与实测位移不矛盾时**才采信（偏差不超过 2 倍）；
         *    · 否则一律用"实测距离 ÷ 实测间隔"。
         *    这样：真机给的速度正常时行为与源码一致；速度缺失或陈旧时自动退回自算，
         *    飞点再也钻不过去。
         */
        val computedSpeed = step / spanSec
        val systemSpeedUsable = sample.speed >= 0.0 &&
            (computedSpeed <= 0.0 || sample.speed <= computedSpeed * 2.0)
        val speed = if (spanSec < 1.2 && systemSpeedUsable) sample.speed else computedSpeed

        // ③ 飞点：彻底丢弃
        if (TrackMath.isFlyPoint(speed, sample.accuracy)) {
            droppedFly++
            return Verdict.DROPPED_FLY
        }

        // ④ 疑似飞点：向上一接受点拉近（源码 .1 × 新 + .9 × 旧），距离增量归 0
        /**
         * ⚠️ **2026-11-02 修掉的一个真 bug（单测抓到的）**：
         * 原写法是 `if (jitter) jitterStreak++; if (jitterStreak >= 5) jitterStreak = 0;`
         * 然后判断 `if (jitter && jitterStreak != 0)` —— 计数一到 5 就被清零，
         * 于是**"平滑"这条分支有一半概率根本不执行**，被平滑的点会掉进 else 分支，
         * 把那一大步 `step` 直接计入里程。实测：1 秒瞬移 2.2 km，本该按飞点丢弃/平滑，
         * 结果 `meters` 直接涨了 2223.9 米。
         *
         * 源码意图（`_jitterStreak` 那行）：**连续**疑似满 5 个之后，才认为"这确实是用户在快速移动"，
         * 从而**停用**"疑似"判定（免得真骑车的用户被一直平滑）。
         * 正确写法：计数达到上限时**置一个"已停用"标志**，而不是把计数清零。
         */
        val jitter = TrackMath.isJitterCandidate(speed, sample.accuracy)
        if (jitter) {
            jitterStreak++
            if (jitterStreak >= TrackMath.JITTER_MAX_STREAK) jitterDisabled = true
        } else {
            jitterStreak = 0
        }

        if (jitter && !jitterDisabled) {
            accepted = sample.copy(
                latitude = 0.1 * sample.latitude + 0.9 * prev.latitude,
                longitude = 0.1 * sample.longitude + 0.9 * prev.longitude,
            )
            step = 0.0
            jitterSmoothed++
        } else {
            // ⑤ 距离增量 < 1.5 m ⇒ 归零（但**该点仍然入轨**，源码就是这么做的）
            if (step < TrackMath.MIN_STEP_M) {
                step = 0.0
                zeroedSteps++
            }
            anchor = accepted
        }

        points.add(accepted)
        meters = TrackMath.sanitizeMeters(meters + TrackMath.sanitizeMeters(step))

        return if (jitter && !jitterDisabled) Verdict.DROPPED_JITTER else Verdict.ACCEPTED
    }

    /** 当前拟合度（0~1）。参考路线为空或轨迹点不足时返回 null = 不适用 */
    fun fitDegree(): Double? {
        if (referenceRoute.size < 2 || points.size < 2) return null
        return TrackMath.calculateRouteSimilarity(referenceRoute, points)
    }

    /** 轨迹本身的真实累计长度（与"计费里程"分开：能看出过滤链吃掉了多少） */
    fun rawPathMeters(): Double = TrackMath.pathLengthMeters(points)
}

/** 精度分布摘要 */
data class AccuracyStats(
    val samples: Int,
    val median: Double,
    val p90: Double,
    val worst: Double,
    val best: Double,
)
