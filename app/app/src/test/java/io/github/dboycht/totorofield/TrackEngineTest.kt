// Instrumented test of TrackEngine: feed a known 400 m lap straight into the engine
// and assert the meters/pace/fit-degree come out right.
// Runs on the JVM (no emulator GPS needed) -> validates the logic the phone will execute.

package io.github.dboycht.totorofield

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

class TrackEngineTest {

    private val cLat = 32.0412
    private val cLng = 118.7231
    private val straights = 84.39
    private val radius = 36.5
    private val mPerDegLat = 6371e3 * Math.PI / 180.0
    private val mLat = 1.0 / mPerDegLat
    private val mLng = 1.0 / (mPerDegLat * cos(cLat * Math.PI / 180.0))
    private val perimeter = 2 * straights + 2 * Math.PI * radius

    /** 标准 400 m 跑道（闭合），t 是沿跑道的里程（米） */
    private fun trackPoint(d: Double): Pair<Double, Double> {
        val half = Math.PI * radius
        return when {
            d < straights -> (cLat + d * mLat) to (cLng - radius * mLng)
            d < straights + half -> {
                val a = (d - straights) / radius - Math.PI / 2
                (cLat + straights * mLat + cos(a) * radius * mLat) to (cLng + sin(a) * radius * mLng)
            }
            d < 2 * straights + half -> {
                val dd = d - straights - half
                (cLat + straights * mLat - dd * mLat) to (cLng + radius * mLng)
            }
            else -> {
                val a = (d - 2 * straights - half) / radius + Math.PI / 2
                (cLat + cos(a) * radius * mLat) to (cLng + sin(a) * radius * mLng)
            }
        }
    }

    /** 以固定速度喂一个完整闭合圈；返回引擎 */
    private fun feedLap(speedMps: Double, accuracy: Double = 5.0, startMs: Long = 1_700_000_000_000L): TrackEngine {
        val engine = TrackEngine()
        var t = startMs
        var d = 0.0
        val dtSec = 1.0
        while (d < perimeter) {
            val (lat, lng) = trackPoint(d)
            engine.offer(LatLng(lat, lng, timestamp = t, accuracy = accuracy, speed = speedMps))
            d += speedMps * dtSec
            t += (dtSec * 1000).toLong()
        }
        return engine
    }

    @Test
    fun `一圈 400m 记为约 0_40 km`() {
        val engine = feedLap(2.0)
        val km = engine.km
        assertTrue("km=$km 应落在 0.38~0.41", km in 0.38..0.41)
        assertEquals("0.40", String.format("%.2f", km))
    }

    @Test
    fun `所有点都被接受且没有被丢弃`() {
        val engine = feedLap(2.0)
        assertEquals(0, engine.droppedAccuracy)
        assertEquals(0, engine.droppedFly)
        assertEquals(0, engine.zeroedSteps)
        assertTrue("应接受约 199 个点，实际 ${engine.points.size}", engine.points.size >= 190)
    }

    @Test
    fun `配速按官方口径格式化为 M_SS`() {
        // 400 m 用 200 s（2 m/s）= 0.4 km -> 500 s/km = 8'20"
        assertEquals("8'20\"", TrackMath.paceText(200, 0.4))
        // 与项目实测过的那笔对齐：3.31 km / 1225 s
        assertEquals("6'10\"", TrackMath.paceText(1225, 3.31))
    }

    @Test
    fun `原地不动不会涨里程`() {
        val engine = TrackEngine()
        val (lat, lng) = trackPoint(0.0)
        var t = 1_700_000_000_000L
        repeat(60) {
            engine.offer(LatLng(lat, lng, timestamp = t, accuracy = 5.0))
            t += 1000
        }
        assertEquals("静止 60 秒里程必须是 0", 0.0, engine.meters, 0.001)
        assertEquals("这些点仍应入轨（源码口径）", 60, engine.points.size)
    }

    @Test
    fun `飞点被丢弃且不计入里程`() {
        // 先确认这个构造确实落在"飞点"判据上（速度 >> 12 m/s）
        val jump = TrackMath.distanceMeters(cLat, cLng, cLat + 0.02, cLng)
        assertTrue("构造的瞬移应远大于飞点阈值，实际 $jump m/s", jump > TrackMath.FLY_SPEED_MPS * 10)

        val engine = TrackEngine()
        var t = 1_700_000_000_000L
        engine.offer(LatLng(cLat, cLng, timestamp = t, accuracy = 5.0))
        t += 1000
        // 1 秒内瞬移 ~2.2 km => 速度远超 12 m/s，属飞点
        engine.offer(LatLng(cLat + 0.02, cLng, timestamp = t, accuracy = 5.0))
        assertEquals(1, engine.droppedFly)
        assertEquals("飞点不应产生里程", 0.0, engine.meters, 0.001)
        assertEquals("飞点不入轨", 1, engine.points.size)
    }

    @Test
    fun `精度超过 80 米在已有锚点后被丢弃`() {
        val engine = TrackEngine()
        var t = 1_700_000_000_000L
        engine.offer(LatLng(cLat, cLng, timestamp = t, accuracy = 5.0))
        t += 1000
        val (lat, lng) = trackPoint(2.0)
        engine.offer(LatLng(lat, lng, timestamp = t, accuracy = 95.0))
        assertEquals(1, engine.droppedAccuracy)
        assertEquals(1, engine.points.size)
    }

    @Test
    fun `精度差的首个样本仍可建立锚点`() {
        val engine = TrackEngine()
        engine.offer(LatLng(cLat, cLng, timestamp = 1_700_000_000_000L, accuracy = 95.0))
        assertTrue("起跑前 >80 的样本应被放宽用于建立基准", engine.hasAnchor)
        assertEquals(1, engine.points.size)
    }

    @Test
    fun `贴着参考路线跑拟合度接近 1`() {
        val engine = TrackEngine()
        engine.referenceRoute = (0..400).map { i ->
            val (lat, lng) = trackPoint(i.toDouble() / 400.0 * perimeter)
            LatLng(lat, lng)
        }
        var t = 1_700_000_000_000L
        var d = 0.0
        while (d < perimeter) {
            val (lat, lng) = trackPoint(d)
            engine.offer(LatLng(lat, lng, timestamp = t, accuracy = 5.0, speed = 2.0))
            d += 2.0
            t += 1000
        }
        val fit = engine.fitDegree()
        assertNotNull(fit)
        assertTrue("拟合度应 > 0.95，实际 $fit", fit!! > 0.95)
    }

    @Test
    fun `没有参考路线时拟合度为 null 而不是 0`() {
        val engine = feedLap(2.0)
        assertNull("未下发线路的任务不应报 0 拟合度", engine.fitDegree())
    }

    @Test
    fun `轨迹点数不足时拟合度为 null`() {
        val engine = TrackEngine()
        engine.referenceRoute = listOf(LatLng(cLat, cLng), LatLng(cLat + 0.001, cLng))
        engine.offer(LatLng(cLat, cLng, timestamp = 1_700_000_000_000L, accuracy = 5.0))
        assertNull(engine.fitDegree())
    }

    @Test
    fun `导出 shape 与提交报文一致`() {
        val engine = feedLap(2.0)
        val snapshot = TrackSnapshot(running = false, startedAtMs = 1_700_000_000_000L, providers = listOf("gps"))
        val json = TrackExport.buildJson(
            engine, snapshot, elapsedSeconds = 200,
            device = DeviceInfo("Google", "sdk_gphone64_x86_64", "Google", "15", 35),
            note = "单元测试",
        )
        assertEquals("totoro-field-run/1", json.getString("schema"))
        val points = json.getJSONArray("submitPoints")
        assertTrue("应有轨迹点", points.length() > 100)
        val first = points.getJSONObject(0)
        // 提交报文只允许这三个字段
        assertEquals(3, first.length())
        assertTrue(first.has("latitude") && first.has("longitude") && first.has("time"))
        val summary = json.getJSONObject("summary")
        assertEquals("0.40", summary.getString("km"))
        assertEquals("00:03:20", summary.getString("usedTime"))
        assertTrue(summary.getBoolean("fitDegreeApplicable") == false)
    }

    @Test
    fun `卡路里按 55 公斤口径`() {
        assertEquals("182.34", TrackMath.kcalText(3.2))
        assertEquals("0.00", TrackMath.kcalText(0.0))
    }

    /**
     * 回归测试：**疑似飞点计数到上限后，不能把那一大步算进里程**。
     *
     * 这是 2026-11-02 单测抓到的一个真 bug 的固化：
     * 原实现 `if (jitterStreak >= 5) jitterStreak = 0` 把计数清零，
     * 导致"平滑"分支半失效 —— 1 秒瞬移 2.2 km 时 `meters` 直接涨了 2223.9 米。
     * 这类 bug 的危险在于：它**不报错、不崩溃**，只是悄悄往里程里灌水。
     */
    @Test
    fun `连续疑似飞点不会把瞬移距离算进里程`() {
        val engine = TrackEngine()
        var t = 1_700_000_000_000L
        var lat = cLat
        engine.offer(LatLng(lat, cLng, timestamp = t, accuracy = 5.0))

        // 连续 6 次"每秒跳 ~30 米"（速度 30 m/s：既 > 12 的飞点线？不，飞点是 >12；
        // 这里用 8 m/s 落在"疑似"区间（>6 但 <12），连发 6 次触发停用逻辑）
        var injected = 0.0
        repeat(6) {
            t += 1000
            lat += 8.0 * mLat      // 8 m/s：落入疑似区间
            injected += 8.0
            engine.offer(LatLng(lat, cLng, timestamp = t, accuracy = 5.0))
        }
        // 无论平滑还是停用，录入的里程都不允许超过真实位移的 1.2 倍
        assertTrue(
            "里程 ${engine.meters} m 不应显著超过真实位移 ${injected} m（灌水 bug 回归）",
            engine.meters <= injected * 1.2,
        )
    }

    @Test
    fun `1 秒瞬移 2 公里必须被丢掉而不是计入里程`() {
        val engine = TrackEngine()
        var t = 1_700_000_000_000L
        engine.offer(LatLng(cLat, cLng, timestamp = t, accuracy = 5.0))
        t += 1000
        engine.offer(LatLng(cLat + 0.02, cLng, timestamp = t, accuracy = 5.0))
        assertEquals(1, engine.droppedFly)
        assertEquals("飞点的距离绝不能进里程", 0.0, engine.meters, 0.001)
    }
}
