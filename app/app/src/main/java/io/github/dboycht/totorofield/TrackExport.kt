package io.github.dboycht.totorofield

import org.json.JSONArray
import org.json.JSONObject

/**
 * 导出 —— 把这一趟真跑变成**能被 Windows 端解析的 JSON**。
 *
 * 两条硬口径（对着提交报文的字段来的）：
 *  1. `submitPoints[]` 的每一项**只有** `latitude` / `longitude` / `time` 三个字段 ——
 *     这正是 `sunRunExercisesDetail` 的 `pointList` 要求的形状（缺 `time` 会被判「GPS位置为空！」整条拒收）。
 *  2. `summary` 里的 `km` / `usedTime` / `fitDegree` / `avgSpeed` / `kcal` **全部由本机按官方算法算出**，
 *     不是估算：算法与小程序逐行等价（见 [TrackMath]）。
 */
object TrackExport {

    const val SCHEMA = "totoro-field-run/1"

    fun buildJson(
        engine: TrackEngine,
        snapshot: TrackSnapshot,
        elapsedSeconds: Long,
        device: DeviceInfo,
        note: String,
    ): JSONObject {
        val points = engine.points
        val km = engine.km
        val fit = engine.fitDegree()

        val root = JSONObject()
        root.put("schema", SCHEMA)
        root.put("app", "totoro-field/0.1.0")
        root.put("exportedAt", TrackMath.stampText(System.currentTimeMillis()))
        root.put("note", note)

        // ---- 汇总：一半是"能直接提交的字段"，一半是"这批数据可不可信的诊断" ----
        val summary = JSONObject()
        summary.put("startTime", TrackMath.stampText(snapshot.startedAtMs))
        summary.put("km", TrackMath.kmText(engine.meters))
        summary.put("usedTime", TrackMath.durationText(elapsedSeconds))
        summary.put("avgSpeed", TrackMath.paceText(elapsedSeconds, km))
        summary.put("kcal", TrackMath.kcalText(km))
        summary.put("fitDegree", fit?.let { String.format("%.2f", it) } ?: "")
        summary.put("fitDegreeApplicable", fit != null)
        summary.put("pointCount", points.size)
        root.put("summary", summary)

        // ---- 采点质量：解释"为什么只有这么多点" ----
        val quality = JSONObject()
        quality.put("rawSamples", engine.rawSamples)
        quality.put("accepted", points.size)
        quality.put("droppedByAccuracy", engine.droppedAccuracy)
        quality.put("droppedAsFlyPoint", engine.droppedFly)
        quality.put("zeroedShortSteps", engine.zeroedSteps)
        quality.put("jitterSmoothed", engine.jitterSmoothed)
        quality.put("rawPathMeters", String.format("%.0f", engine.rawPathMeters()))
        quality.put("billedMeters", String.format("%.0f", engine.meters))
        val stats = engine.accuracyStats()
        quality.put("accuracyMedian", String.format("%.1f", stats.median))
        quality.put("accuracyP90", String.format("%.1f", stats.p90))
        quality.put("accuracyBest", String.format("%.1f", stats.best))
        quality.put("accuracyWorst", String.format("%.1f", stats.worst))
        root.put("samplingQuality", quality)

        // ---- 设备环境：回来对"为什么这一趟这么差"有用 ----
        val env = JSONObject()
        env.put("brand", device.brand)
        env.put("model", device.model)
        env.put("manufacturer", device.manufacturer)
        env.put("androidRelease", device.androidRelease)
        env.put("sdkInt", device.sdkInt)
        env.put("providers", JSONArray(snapshot.providers))
        env.put("locationModeNote", "Android 端只有「开/关」，没有 iOS 那种高精度开关")
        root.put("device", env)

        // ---- 提交形状的轨迹点（可直接喂给 sunRunExercisesDetail）----
        val submitPoints = JSONArray()
        for (p in points) {
            val o = JSONObject()
            o.put("latitude", p.latitude)
            o.put("longitude", p.longitude)
            o.put("time", TrackMath.clockText(p.timestamp))
            submitPoints.put(o)
        }
        root.put("submitPoints", submitPoints)

        // ---- 完整样本（含精度/海拔/速度），供回来做真实感分析 ----
        val full = JSONArray()
        for (p in points) {
            val o = JSONObject()
            o.put("latitude", p.latitude)
            o.put("longitude", p.longitude)
            o.put("timestamp", p.timestamp)
            o.put("time", TrackMath.clockText(p.timestamp))
            o.put("accuracy", p.accuracy)
            o.put("altitude", p.altitude)
            o.put("speed", p.speed)
            o.put("bearing", p.bearing)
            full.put(o)
        }
        root.put("points", full)

        return root
    }

    /** 轨迹点表的 CSV（便于直接丢进表格/画图） */
    fun buildCsv(engine: TrackEngine): String {
        val sb = StringBuilder()
        sb.append("seq,time,timestamp,latitude,longitude,accuracy,altitude,speed,bearing\n")
        engine.points.forEachIndexed { i, p ->
            sb.append(i).append(',')
                .append(TrackMath.clockText(p.timestamp)).append(',')
                .append(p.timestamp).append(',')
                .append(p.latitude).append(',')
                .append(p.longitude).append(',')
                .append(p.accuracy).append(',')
                .append(p.altitude).append(',')
                .append(p.speed).append(',')
                .append(p.bearing).append('\n')
        }
        return sb.toString()
    }
}

/** 设备信息（Android 端可读部分） */
data class DeviceInfo(
    val brand: String,
    val model: String,
    val manufacturer: String,
    val androidRelease: String,
    val sdkInt: Int,
)
