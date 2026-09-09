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

# ---- [0/7] 确保 .output 为生产构建 ----
$outputDir = Join-Path $root '.output'
$indexPath = Join-Path $outputDir 'public\index.html'
$needBuild = $true
if (Test-Path $indexPath) {
    $html = Get-Content $indexPath -Raw
    if (($html -notmatch '@vite/client') -and ($html -notmatch '[A-Za-z]:/')) {
        $needBuild = $false
        Write-Host '[0/7] .output is a production build, skip build'
    } else {
        Write-Host '[0/7] .output is a dev build (contains @vite/client or absolute paths), rebuilding...'
    }
} else {
    Write-Host '[0/7] .output not found, running production build...'
}
if ($needBuild) {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
    $html2 = Get-Content $indexPath -Raw
    if (($html2 -match '@vite/client') -or ($html2 -match '[A-Za-z]:/')) {
        throw 'index.html still contains dev artifacts (@vite/client / absolute paths). Stop the dev server and retry.'
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

Write-Host '[5/7] inject SEA blob (postject)...'
& npx postject $exeOut NODE_SEA_BLOB (Join-Path $distSea 'sea-prep.blob') --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw 'postject failed' }

Write-Host '[6/7] set EXE icon from logo.ico (rcedit)...'
$rcedit = Join-Path $root 'node_modules\rcedit\bin\rcedit.exe'
$logoIco = Join-Path $root 'logo.ico'
$hasRcedit = Test-Path $rcedit
$hasIcon = Test-Path $logoIco
if ($hasRcedit -and $hasIcon) {
    $rceditProc = Start-Process -FilePath $rcedit -ArgumentList @($exeOut, '--set-icon', $logoIco) -Wait -NoNewWindow -PassThru
    if ($rceditProc.ExitCode -ne 0) { Write-Warning "rcedit icon set failed (exit $($rceditProc.ExitCode))" }
} else {
    Write-Warning 'rcedit or logo.ico not found - skipping icon step'
}

$size = [math]::Round((Get-Item $exeOut).Length / 1MB, 1)
Write-Host "[7/7] done -> $exeOut ($size MB)"
