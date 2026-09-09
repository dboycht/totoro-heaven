# 构建 totoro-heaven 单文件 EXE（Node SEA）
# 用法：.\pack\sea\build-sea.ps1
# 说明：自动校验 .output 是否为生产构建；dev 产物/缺失时自动重新 build，
#       避免 dev 产物（或空目录）打进 EXE 导致页面空白（见 DEVELOPMENT.md 0-1）。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$distSea = Join-Path $root 'dist\sea'
$exeOut = Join-Path $root 'dist\totoro-heaven.exe'
if (-not (Test-Path $distSea)) { New-Item -ItemType Directory -Path $distSea | Out-Null }

# ---- [0/8-pre] 预检：清理历史遗留（rcedit 挂起导致 EXE 被锁 / 旧 EXE 已含 NODE_SEA_BLOB）----
Get-Process -Name rcedit -ErrorAction SilentlyContinue | ForEach-Object {
    try { if ($_.Path -like "$root*") { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } } catch {}
}
if (Test-Path $exeOut) { Remove-Item $exeOut -Force -ErrorAction SilentlyContinue }

# ---- [0/7] 确保 .output 为生产构建 ----
# 注：ssr:false 的 SPA 构建没有静态 public/index.html（HTML 由 nitro 运行时
#     经 client.manifest.mjs 渲染），故以 client.manifest.mjs 是否为 dev 污染为准。
$outputDir = Join-Path $root '.output'
$manifestPath = Join-Path $outputDir 'server\chunks\build\client.manifest.mjs'
$needBuild = $true
if (Test-Path $manifestPath) {
    $manifest = Get-Content $manifestPath -Raw -ErrorAction SilentlyContinue
    if ($manifest -and ($manifest -notmatch 'vite/client') -and ($manifest -notmatch '[A-Za-z]:/')) {
        $needBuild = $false
        Write-Host '[0/7] .output is a clean SPA production build, skip build'
    } else {
        Write-Host '[0/7] .output is contaminated (@vite/client or absolute paths in client manifest), rebuilding clean...'
    }
} else {
    Write-Host '[0/7] .output missing or incomplete, running production build...'
}
if ($needBuild) {
    $nuxtDir = Join-Path $root '.nuxt'
    if (Test-Path $nuxtDir) { Remove-Item $nuxtDir -Recurse -Force }
    if (Test-Path $outputDir) { Remove-Item $outputDir -Recurse -Force }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
    $manifest2 = Get-Content $manifestPath -Raw -ErrorAction SilentlyContinue
    if (-not $manifest2 -or ($manifest2 -match 'vite/client') -or ($manifest2 -match '[A-Za-z]:/')) {
        throw 'client.manifest.mjs still contaminated (@vite/client / absolute paths). Stop the dev server and retry.'
    }
}

Write-Host '[1/7] bundle launcher (esbuild)...'
$esbuild = Join-Path $root 'node_modules\.bin\esbuild.cmd'
if (-not (Test-Path $esbuild)) { throw "esbuild not found at $esbuild" }
# 从 package.json 读取当前版本（用 node 读取，避免 PowerShell 正则/编码坑）
$ver = (& node -e "console.log(require(process.argv[1]).version)" (Join-Path $root 'package.json')) 2>$null
if (-not $ver) { $ver = '0.0.0' }
Write-Host "[ver] root=$root ver=$ver"
$srcLauncher = Join-Path $PSScriptRoot 'launcher.mjs'
$tmpLauncher = Join-Path $distSea 'launcher.tmp.mjs'
$content = (Get-Content $srcLauncher -Raw -Encoding UTF8) -replace "__APP_VERSION__", $ver
[System.IO.File]::WriteAllText($tmpLauncher, $content, (New-Object System.Text.UTF8Encoding($false)))
$bundleArgs = @($tmpLauncher, '--bundle', '--platform=node', '--format=cjs', '--target=node22', "--outfile=$distSea/launcher.bundle.cjs")
& $esbuild @bundleArgs
if ($LASTEXITCODE -ne 0) { throw 'esbuild failed' }

Write-Host '[2/7] pack .output -> app.tar.gz (Windows tar)...'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
& $tar -czf (Join-Path $distSea 'app.tar.gz') -C $outputDir .
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }

Write-Host '[3/7] generate SEA blob...'
$seaCfg = @{
    main                          = (Join-Path $distSea 'launcher.bundle.cjs')
    output                        = (Join-Path $distSea 'sea-prep.blob')
    disableExperimentalSEAWarning = $true
    useSnapshot                   = $false
    useCodeCache                  = $false
    assets                        = @{ 'app.tar.gz' = (Join-Path $distSea 'app.tar.gz') }
} | ConvertTo-Json -Depth 4
Set-Content -Path (Join-Path $distSea 'sea-config.json') -Value $seaCfg -Encoding utf8
& node --experimental-sea-config (Join-Path $distSea 'sea-config.json')
if ($LASTEXITCODE -ne 0) { throw 'sea-config failed' }

Write-Host '[4/7] copy node.exe base...'
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe $exeOut -Force

Write-Host '[5/7] set EXE icon from logo.ico (rcedit, BEFORE postject)...'
# 关键顺序（2026-09-09 踩坑）：rcedit 在已 postject（含 NODE_SEA_BLOB / 签名损坏）的 SEA exe 上会
# 挂起且图标写不进去；必须先对未注入的 node.exe 设置图标，再 postject。这样图标能正确嵌入。
$rcedit = Join-Path $root 'node_modules\rcedit\bin\rcedit.exe'
$logoIco = Join-Path $root 'logo.ico'
$hasRcedit = Test-Path $rcedit
$hasIcon = Test-Path $logoIco
if ($hasRcedit -and $hasIcon) {
    $rceditProc = Start-Process -FilePath $rcedit -ArgumentList @($exeOut, '--set-icon', $logoIco) -PassThru -NoNewWindow
    # 保险：限时 120s（正常情况下对未 postject 的 exe 会正常退出）
    if (-not $rceditProc.WaitForExit(120000)) {
        Write-Warning 'rcedit timed out after 120s - killing it'
        Stop-Process -Id $rceditProc.Id -Force -ErrorAction SilentlyContinue
    } elseif ($rceditProc.ExitCode -ne 0) {
        Write-Warning "rcedit icon set failed (exit $($rceditProc.ExitCode))"
    }
} else {
    Write-Warning 'rcedit or logo.ico not found - skipping icon step'
}

Write-Host '[6/7] inject SEA blob (postject)...'
& npx postject $exeOut NODE_SEA_BLOB (Join-Path $distSea 'sea-prep.blob') --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw 'postject failed' }

$size = [math]::Round((Get-Item $exeOut).Length / 1MB, 1)
Write-Host "[7/7] done -> $exeOut ($size MB)"
