package io.github.dboycht.totorofield

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Binder
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 采集用的前台服务 —— **息屏后继续收点**。
 *
 * 为什么必须这样：官方小程序在安卓上踩过的坑就是"息屏/切后台后定位被冻结"，
 * 于是有了那条「🔋 后台定位保护指南」弹窗（关省电模式、把 App 加白名单）。
 * 我们用前台服务 + `FOREGROUND_SERVICE_LOCATION` 类型 + 常驻通知，
 * **不依赖厂商的省电白名单**也能持续收点。
 *
 * 定位源：直接用 `LocationManager.GPS_PROVIDER`（不引入 Google Play 服务，
 * 野外/校园网下不依赖任何云组件）。同时挂 `NETWORK_PROVIDER` 做兜底，
 * 但**每个点都记下来源**，便于回来判断"这段是不是纯 GPS"。
 */
class TrackService : Service() {

    companion object {
        const val ACTION_START = "io.github.dboycht.totorofield.START"
        const val ACTION_STOP = "io.github.dboycht.totorofield.STOP"
        private const val CHANNEL_ID = "totoro-field-tracking"
        private const val NOTIFICATION_ID = 4201

        /** 最新采点状态（界面直接读它；进程内单例） */
        private val _state = MutableStateFlow(TrackSnapshot())
        val state: StateFlow<TrackSnapshot> = _state.asStateFlow()

        /** 采点引擎（跨 Service/Activity 共享同一份） */
        val engine = TrackEngine()

        /** "位置冻住"判定阈值：连续这么多个样本同一坐标、且已持续这么久 ⇒ 告警 */
        private const val FROZEN_SAMPLES = 10
        private const val FROZEN_SECONDS = 20

        /**
         * 暂停/继续开关。放在伴生对象里是因为它**必须比 Service 实例活得久**：
         * Service 被系统回收再拉起时，暂停状态不该丢（丢了会把"暂停那段"算进成绩）。
         */
        private val _paused = MutableStateFlow(false)

        /** 切换暂停；返回切换后的状态 */
        fun togglePause(): Boolean {
            val next = !_paused.value
            _paused.value = next
            publish(state.value.copy(paused = next))
            return next
        }

        fun isPaused(): Boolean = _paused.value

        fun start(context: Context) {
            val intent = Intent(context, TrackService::class.java).setAction(ACTION_START)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, TrackService::class.java).setAction(ACTION_STOP))
        }

        fun publish(snapshot: TrackSnapshot) {
            _state.value = snapshot
        }
    }

    private val binder = LocalBinder()
    private var locationManager: LocationManager? = null
    private var startedAtMs: Long = 0L
    private var running = false
    private var provider: String = "gps"

    inner class LocalBinder : Binder() {
        fun service(): TrackService = this@TrackService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            else -> startTracking()
        }
        return START_STICKY
    }

    private fun startTracking() {
        if (running) return
        running = true
        startedAtMs = System.currentTimeMillis()
        startForegroundWithNotification()

        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        locationManager = lm

        val permitted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        if (!permitted) {
            publish(
                TrackSnapshot(
                    running = false,
                    error = "没有定位权限：请回到应用里授权「精确位置」后再开始",
                ),
            )
            stopSelf()
            return
        }

        val listeners = mutableListOf<String>()
        val failures = mutableListOf<String>()
        // GPS 为主（真值来源）
        runCatching {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, listener, Looper.getMainLooper())
            listeners += "gps"
        }.onFailure { failures += "GPS:${it::class.simpleName}" }
        // 网络定位兜底（室内/树荫下不至于一个点都没有）
        runCatching {
            lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 2000L, 0f, listener, Looper.getMainLooper())
            listeners += "network"
        }.onFailure { failures += "网络:${it::class.simpleName}" }

        /**
         * ⚠️ **一个 provider 都没注册上时必须当场报错**（2026-11-02 加）。
         * 原实现无条件 publish `running = true` —— 于是"位置服务被关/被系统拒绝"时，
         * 界面照样显示"正在记录"、计时器在走，而**一个点都收不到**：用户跑完才发现白跑。
         * 判据：**"已开始"这个状态必须由"至少有一个 provider 真的注册成功"来支撑**，
         * 不能用"函数没抛异常"来代替。
         */
        if (listeners.isEmpty()) {
            publish(
                TrackSnapshot(
                    running = false,
                    error = "定位服务不可用（${failures.joinToString("；")}）—— " +
                        "请确认系统「定位」已打开、并且本应用拿到了「精确位置」权限",
                ),
            )
            stopSelf()
            return
        }

        publish(
            TrackSnapshot(
                running = true,
                startedAtMs = startedAtMs,
                providers = listeners,
                paused = isPaused(),
            ),
        )
    }

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            onSample(location)
        }

        @Deprecated("Android < Q 兼容")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

        override fun onProviderEnabled(provider: String) = Unit

        override fun onProviderDisabled(provider: String) {
            publish(_state.value.copy(error = "系统定位已关闭：请下拉控制中心打开「定位」"))
        }
    }

    private fun onSample(location: Location) {
        if (isPaused()) return
        val now = System.currentTimeMillis()
        val sample = LatLng(
            latitude = location.latitude,
            longitude = location.longitude,
            timestamp = if (location.time > 0) location.time else now,
            accuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else -1.0,
            altitude = if (location.hasAltitude()) location.altitude else 0.0,
            speed = if (location.hasSpeed()) location.speed.toDouble() else -1.0,
            bearing = if (location.hasBearing()) location.bearing.toDouble() else 0.0,
        )
        provider = location.provider ?: "unknown"

        /**
         * ⚠️ **"位置被冻住"检测**（2026-11-02 加，模拟器实测逼出来的）：
         *
         * 现场：模拟器把位置永久钉在一个固定坐标（`39.237,-123.150`），
         * 系统**照常每秒回调一次**，但经纬度**一模一样**。于是：
         *   · 每个点的间距都是 0 m ⇒ 全被 `< 1.5 m` 规则归零 ⇒ 里程永远 0.00 km；
         *   · 而界面显示"228 个点已接受 / 正在记录" ⇒ **看起来一切正常**。
         * 这正是最危险的一类失败：**数据是假的，但没有任何信号告诉你**。
         *
         * 真机上对应的现实场景：手机在兜里、GPS 没锁上星、或系统冻结了定位，
         * 拿到的都是"最后一个有效点"的重复值 —— 跑完才发现白跑一圈。
         *
         * 判据：**连续 N 个样本的经纬度完全相同、且已持续超过 T 秒 ⇒ 明确告警**。
         * 只告警、不中断采样：万一真是站着不动，恢复移动后应当能继续记录。
         */
        if (lat == sample.latitude && lng == sample.longitude) {
            frozenSamples++
            if (frozenSinceMs == 0L) frozenSinceMs = now
        } else {
            frozenSamples = 0
            frozenSinceMs = 0L
        }
        val frozenSeconds = if (frozenSinceMs > 0) (now - frozenSinceMs) / 1000 else 0
        val frozen = frozenSamples >= FROZEN_SAMPLES && frozenSeconds >= FROZEN_SECONDS

        val verdict = if (sample.accuracy < 0) {
            engine.offer(sample.copy(accuracy = 0.0))
        } else {
            engine.offer(sample)
        }

        publish(
            _state.value.copy(
                running = true,
                startedAtMs = startedAtMs,
                accepted = engine.points.size,
                rawSamples = engine.rawSamples,
                meters = engine.meters,
                lastLat = sample.latitude,
                lastLng = sample.longitude,
                lastAccuracy = sample.accuracy,
                lastProvider = provider,
                lastVerdict = verdict.name,
                droppedAccuracy = engine.droppedAccuracy,
                droppedFly = engine.droppedFly,
                zeroedSteps = engine.zeroedSteps,
                jitterSmoothed = engine.jitterSmoothed,
                searchingSignal = engine.searchingSignal,
                frozen = frozen,
                frozenSeconds = frozenSeconds.toInt(),
            ),
        )
        updateNotification()
    }

    /** 上一个样本的经纬度（用于"位置冻住"检测） */
    private var lat = Double.NaN
    private var lng = Double.NaN
    private var frozenSamples = 0
    private var frozenSinceMs = 0L

    private fun startForegroundWithNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "实地采数",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "记录 GPS 轨迹时保持常驻，息屏后继续采点"
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }

        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("正在记录真实轨迹")
            .setContentText("息屏也会继续采点")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val km = TrackMath.kmText(engine.meters)
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("正在记录真实轨迹")
            .setContentText("$km km · ${engine.points.size} 个点 · 精度 ${_state.value.lastAccuracy.toInt()} m")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        nm.notify(NOTIFICATION_ID, notification)
    }

    override fun onDestroy() {
        running = false
        runCatching { locationManager?.removeUpdates(listener) }
        publish(_state.value.copy(running = false))
        super.onDestroy()
    }
}

/** 采点状态快照（界面直接渲染它） */
data class TrackSnapshot(
    val running: Boolean = false,
    val paused: Boolean = false,
    val startedAtMs: Long = 0L,
    val providers: List<String> = emptyList(),
    val accepted: Int = 0,
    val rawSamples: Int = 0,
    val meters: Double = 0.0,
    val lastLat: Double = 0.0,
    val lastLng: Double = 0.0,
    val lastAccuracy: Double = 0.0,
    val lastProvider: String = "",
    val lastVerdict: String = "",
    val droppedAccuracy: Int = 0,
    val droppedFly: Int = 0,
    val zeroedSteps: Int = 0,
    val jitterSmoothed: Int = 0,
    val searchingSignal: Boolean = false,
    /** 🆕 位置疑似被冻住（连续同一坐标）——真机上是"白跑一圈"的前兆，必须显眼告警 */
    val frozen: Boolean = false,
    val frozenSeconds: Int = 0,
    val error: String = "",
)
