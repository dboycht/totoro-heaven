package io.github.dboycht.totorofield

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import java.io.File

class MainActivity : ComponentActivity() {

    private val requestLocation = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { /* 结果由界面上的权限状态自行反映 */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFF101418)) {
                    FieldScreen(onRequestPermissions = { askPermissions() })
                }
            }
        }
    }

    private fun askPermissions() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms += Manifest.permission.POST_NOTIFICATIONS
        }
        requestLocation.launch(perms.toTypedArray())
    }
}

private fun hasLocation(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED

@Composable
private fun FieldScreen(onRequestPermissions: () -> Unit) {
    val context = LocalContext.current
    val snapshot by TrackService.state.collectAsStateWithLifecycle()

    var note by remember { mutableStateOf("") }
    var elapsed by remember { mutableStateOf(0L) }
    var granted by remember { mutableStateOf(hasLocation(context)) }
    var exportPath by remember { mutableStateOf("") }
    var tick by remember { mutableStateOf(0) }

    // 权限状态随时可能被用户在系统设置里改掉，进前台就重读一次
    LaunchedEffect(tick) { granted = hasLocation(context) }

    // 计时：只在"正在采且没暂停"时累加（暂停不记账）
    LaunchedEffect(snapshot.running, snapshot.paused) {
        while (snapshot.running && !snapshot.paused) {
            delay(500)
            elapsed = (SystemClock.elapsedRealtime() - sessionStartAt) / 1000
        }
    }
    LaunchedEffect(snapshot.running) {
        if (snapshot.running) sessionStartAt = SystemClock.elapsedRealtime() - elapsed * 1000
    }

    val engine = TrackService.engine
    val km = engine.km

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "龙猫实地采数",
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
            color = Color(0xFF8FE3A8),
        )
        Text(
            "拿着手机去操场真跑一圈，只在本机记录真实 GPS；不联网、不上报、不需要 token。",
            fontSize = 12.sp,
            color = Color(0xFF9AA4AE),
        )

        if (!granted) {
            Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF3A2216))) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("需要「精确位置」权限", fontWeight = FontWeight.Bold, color = Color(0xFFFFC38A))
                    Text(
                        "采集期间请选「始终允许」或「使用应用时允许」。息屏后要继续收点，" +
                            "靠的是本应用的前台服务（通知栏会有一条常驻提示）。",
                        fontSize = 12.sp,
                        color = Color(0xFFDDD3C6),
                    )
                    Button(onClick = onRequestPermissions) { Text("授予权限") }
                }
            }
        }

        // 位置被冻住 = 真机上"白跑一圈"的前兆，必须压在最显眼处
        if (snapshot.frozen) {
            Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF5A2A12))) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("⚠️ 位置没有在变（已 ${snapshot.frozenSeconds} 秒）", fontWeight = FontWeight.Bold, color = Color(0xFFFFD9A8))
                    Text(
                        "里程不会增长，这样跑完是白跑。可能是：GPS 还没锁上星（去开阔处等 10~30 秒）、" +
                            "手机在兜里挡住了天线、或系统冻结了定位。\n" +
                            "请把手机拿出来、确认屏幕上这个数字在动，再继续。",
                        fontSize = 12.sp,
                        color = Color(0xFFF2E2D0),
                    )
                }
            }
        }

        // ---------- 实时读数 ----------
        Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF182028))) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(TrackMath.kmText(engine.meters), fontSize = 44.sp, fontWeight = FontWeight.Bold, color = Color.White)
                    Spacer(Modifier.width(6.dp))
                    Text("km", fontSize = 16.sp, color = Color(0xFF9AA4AE), modifier = Modifier.padding(bottom = 8.dp))
                }
                Text(TrackMath.durationText(elapsed), fontSize = 26.sp, color = Color(0xFF8FE3A8), fontFamily = FontFamily.Monospace)
                Text(
                    "配速 ${TrackMath.paceText(elapsed, km)}  ·  ${TrackMath.kcalText(km)} kcal  ·  ${engine.points.size} 个点",
                    fontSize = 13.sp,
                    color = Color(0xFFB9C4CE),
                )
                Text(
                    statusLine(snapshot),
                    fontSize = 12.sp,
                    color = if (snapshot.searchingSignal) Color(0xFFFFC38A) else Color(0xFF7E8A96),
                )
            }
        }

        // ---------- 操作 ----------
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            if (!snapshot.running) {
                Button(
                    onClick = {
                        if (!hasLocation(context)) {
                            onRequestPermissions()
                            return@Button
                        }
                        elapsed = 0
                        sessionStartAt = SystemClock.elapsedRealtime()
                        TrackService.engine.reset()
                        TrackService.start(context)
                    },
                    modifier = Modifier.weight(1f).height(52.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D4F)),
                ) { Text("开始记录") }
            } else {
                Button(
                    onClick = { TrackService.stop(context) },
                    modifier = Modifier.weight(1f).height(52.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8C3B3B)),
                ) { Text("结束") }
                OutlinedButton(
                    onClick = { TrackService.togglePause() },
                    modifier = Modifier.weight(1f).height(52.dp),
                ) { Text(if (snapshot.paused) "继续" else "暂停") }
            }
        }

        if (snapshot.error.isNotEmpty()) {
            Text(snapshot.error, color = Color(0xFFFF8A8A), fontSize = 13.sp)
        }

        // ---------- 采点质量（这一批数据可不可信，全看这块） ----------
        if (engine.rawSamples > 0) {
            Section("采点质量") {
                val stats = engine.accuracyStats()
                KV("原始样本", "${snapshot.rawSamples}")
                KV("已接受", "${engine.points.size}")
                KV("因精度丢弃", "${engine.droppedAccuracy}")
                KV("因飞点丢弃", "${engine.droppedFly}")
                KV("疑似飞点平滑", "${engine.jitterSmoothed}")
                KV("短步归零", "${engine.zeroedSteps}")
                KV("精度中位数", "${"%.1f".format(stats.median)} m（最好 ${"%.0f".format(stats.best)}，最差 ${"%.0f".format(stats.worst)}）")
                KV("轨迹实长", "${"%.0f".format(engine.rawPathMeters())} m")
                KV("计费里程", "${"%.0f".format(engine.meters)} m")
                val fit = engine.fitDegree()
                KV("拟合度", fit?.let { "%.2f".format(it) } ?: "未设参考路线")
            }
        }

        // ---------- 参考路线（可选：填了就顺便算拟合度） ----------
        Section("参考路线（可选）") {
            Text(
                "把官方线路点贴进来（每行 lat,lng，或直接贴 getSunrunArchDetail 的 pointList JSON），" +
                    "就能在跑步过程中实时算拟合度。不填也能采集，只是没有拟合度。",
                fontSize = 11.sp,
                color = Color(0xFF7E8A96),
            )
            var routeText by remember { mutableStateOf("") }
            OutlinedTextField(
                value = routeText,
                onValueChange = {
                    routeText = it
                    engine.referenceRoute = parseRoute(it)
                },
                label = { Text("参考路线点") },
                modifier = Modifier.fillMaxWidth().height(110.dp),
                textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp),
            )
        }

        // ---------- 备注 + 导出 ----------
        Section("导出") {
            OutlinedTextField(
                value = note,
                onValueChange = { note = it },
                label = { Text("本次备注（如：操场 4 圈 / 阴天）") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = {
                        val device = deviceInfo()
                        val json = TrackExport.buildJson(engine, snapshot, elapsed, device, note)
                        exportPath = writeExport(context, json.toString(2), TrackExport.buildCsv(engine))
                    },
                    enabled = engine.points.size > 1,
                    modifier = Modifier.weight(1f),
                ) { Text("导出文件") }

                OutlinedButton(
                    onClick = {
                        val device = deviceInfo()
                        val json = TrackExport.buildJson(engine, snapshot, elapsed, device, note)
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        cm.setPrimaryClip(ClipData.newPlainText("totoro-field", json.toString()))
                        exportPath = "已复制 JSON 到剪贴板"
                    },
                    enabled = engine.points.size > 1,
                    modifier = Modifier.weight(1f),
                ) { Text("复制 JSON") }
            }
            if (exportPath.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Text(exportPath, fontSize = 12.sp, color = Color(0xFF8FE3A8))
            }
        }

        Section("怎么把数据带回电脑") {
            Text(
                "1) 跑完点「导出文件」→ 文件落在应用私有目录；\n" +
                    "2) 点「分享出去」把它发到微信/网盘/邮件（或直接连线拷）；\n" +
                    "3) 电脑端把它丢进 totoro-heaven 的 capture 目录解析。\n\n" +
                    "目录：${exportDir(context).absolutePath}",
                fontSize = 11.sp,
                color = Color(0xFF9AA4AE),
            )
            Spacer(Modifier.height(4.dp))
            OutlinedButton(
                onClick = {
                    val f = latestExport(context)
                    if (f != null) {
                        val uri: Uri = androidx.core.content.FileProvider.getUriForFile(
                            context,
                            "${context.packageName}.fileprovider",
                            f,
                        )
                        val send = Intent(Intent.ACTION_SEND).apply {
                            type = "application/json"
                            putExtra(Intent.EXTRA_STREAM, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        context.startActivity(Intent.createChooser(send, "把轨迹分享出去"))
                    }
                },
                enabled = latestExport(context) != null,
            ) { Text("分享出去") }
        }

        Section("关于") {
            KV("版本", BuildConfig.VERSION_NAME)
            KV("作者", "Mizuki")
            KV("许可证", "CC BY-NC 4.0")
            Text(
                "仓库：https://github.com/dboycht/totoro-heaven",
                fontSize = 11.sp,
                color = Color(0xFF7E8A96),
            )
            Text(
                "本工具用于本人真实跑步的轨迹记录与学习，请遵守你所在学校的规定，风险自负。",
                fontSize = 11.sp,
                color = Color(0xFF6E7A86),
            )
        }

        Text(
            "本应用不申请 INTERNET 权限，因此无法联网：所有数据只留在本机。",
            fontSize = 11.sp,
            color = Color(0xFF6E7A86),
        )
        Spacer(Modifier.height(24.dp))
    }

    LaunchedEffect(Unit) {
        while (true) {
            delay(2000)
            tick++
        }
    }
}

/** 采样会话起点（与"暂停不计时"配套） */
private var sessionStartAt: Long = SystemClock.elapsedRealtime()

private fun statusLine(s: TrackSnapshot): String = when {
    !s.running -> "未开始"
    s.paused -> "已暂停（这段时间不计入成绩）"
    s.searchingSignal -> "正在搜索高精度 GPS，请到开阔处"
    s.accepted == 0 -> "等待第一个定位点…"
    else -> "最近一次：${s.lastProvider} · 精度 ${"%.0f".format(s.lastAccuracy)} m · ${verdictText(s.lastVerdict)}"
}

private fun verdictText(v: String): String = when (v) {
    "ACCEPTED" -> "已接受"
    "ANCHOR" -> "起点锚定"
    "DROPPED_ACCURACY" -> "精度差，丢弃"
    "DROPPED_FLY" -> "飞点，丢弃"
    "DROPPED_JITTER" -> "疑似飞点，平滑"
    else -> v
}

/**
 * 解析参考路线。两种输入都收：
 *  - 每行 `lat,lng`；
 *  - 直接贴 `[{"latitude":..,"longitude":..}, …]` 这样的 JSON 片段（正则抠数字对，容错优先）。
 */
internal fun parseRoute(text: String): List<LatLng> {
    if (text.isBlank()) return emptyList()
    val out = mutableListOf<LatLng>()

    // 形状一：JSON 对象数组
    val json = Regex("\"latitude\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)\\s*,\\s*\"longitude\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)")
    for (m in json.findAll(text)) {
        val lat = m.groupValues[1].toDoubleOrNull() ?: continue
        val lng = m.groupValues[2].toDoubleOrNull() ?: continue
        out += LatLng(lat, lng)
    }
    if (out.isNotEmpty()) return out

    // 形状二：每行 "lat,lng"
    for (line in text.lines()) {
        val parts = line.trim().split(',', ' ', '\t').filter { it.isNotBlank() }
        if (parts.size < 2) continue
        val lat = parts[0].toDoubleOrNull() ?: continue
        val lng = parts[1].toDoubleOrNull() ?: continue
        out += LatLng(lat, lng)
    }
    return out
}

private fun exportDir(context: Context): File = File(context.filesDir, "runs").apply { mkdirs() }

private fun latestExport(context: Context): File? =
    exportDir(context).listFiles()?.filter { it.name.endsWith(".json") }?.maxByOrNull { it.lastModified() }

private fun writeExport(context: Context, json: String, csv: String): String {
    val dir = exportDir(context)
    val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date())
    val jsonFile = File(dir, "run-$stamp.json")
    jsonFile.writeText(json, Charsets.UTF_8)
    File(dir, "run-$stamp.csv").writeText(csv, Charsets.UTF_8)
    return "已写入 ${jsonFile.absolutePath}"
}

private fun deviceInfo(): DeviceInfo = DeviceInfo(
    brand = Build.BRAND ?: "",
    model = Build.MODEL ?: "",
    manufacturer = Build.MANUFACTURER ?: "",
    androidRelease = Build.VERSION.RELEASE ?: "",
    sdkInt = Build.VERSION.SDK_INT,
)

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Color(0xFF182028)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Color(0xFF8FE3A8))
            content()
        }
    }
}

@Composable
private fun KV(k: String, v: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(k, fontSize = 12.sp, color = Color(0xFF9AA4AE))
        Text(v, fontSize = 12.sp, color = Color(0xFFE6EDF3))
    }
}
