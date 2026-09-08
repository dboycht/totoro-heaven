# 构建 totoro-heaven 单文件 EXE（Node SEA）
# 用法：.\pack\sea\build-sea.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$distSea = Join-Path $root 'dist\sea'
$exeOut = Join-Path $root 'dist\totoro-heaven.exe'
if (-not (Test-Path $distSea)) { New-Item -ItemType Directory -Path $distSea | Out-Null }

Write-Host '[1/6] bundle launcher (esbuild)...'
$esbuild = Join-Path $root 'node_modules\.bin\esbuild.cmd'
if (-not (Test-Path $esbuild)) { throw "esbuild not found at $esbuild" }
# 从 package.json 读取当前版本，构建时注入 launcher（横幅版本单一来源）
$verMatch = Select-String -Path (Join-Path $root 'package.json') -Pattern '"version"\s*:\s*"([^"]+)"'
$ver = if ($verMatch -and $verMatch.Matches.Count -gt 0) { $verMatch.Matches[0].Groups[1].Value } else { '0.0.0' }
$defineArg = "--define:__APP_VERSION__=" + [char]34 + $ver + [char]34
$bundleArgs = @('pack/sea/launcher.mjs', '--bundle', '--platform=node', '--format=cjs', '--target=node22', $defineArg, "--outfile=$distSea/launcher.bundle.cjs")
& $esbuild @bundleArgs
if ($LASTEXITCODE -ne 0) { throw 'esbuild failed' }

Write-Host '[2/6] pack .output -> app.tar.gz (Windows tar)...'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
& $tar -czf (Join-Path $distSea 'app.tar.gz') -C (Join-Path $root '.output') .
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }

Write-Host '[3/6] generate SEA blob...'
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

Write-Host '[4/6] copy node.exe base...'
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe $exeOut -Force

Write-Host '[5/6] inject SEA blob (postject)...'
& npx postject $exeOut NODE_SEA_BLOB (Join-Path $distSea 'sea-prep.blob') --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw 'postject failed' }

Write-Host '[6/7] set EXE icon from logo.ico (rcedit)...'
$rcedit = Join-Path $root 'node_modules\rcedit\bin\rcedit.exe'
$logoIco = Join-Path $root 'logo.ico'
if (Test-Path $rcedit -and (Test-Path $logoIco)) {
    & $rcedit $exeOut --set-icon $logoIco
    if ($LASTEXITCODE -ne 0) { Write-Warning 'rcedit icon set failed (EXE still works, without custom icon)' }
} else {
    Write-Warning 'rcedit or logo.ico not found - skipping icon step'
}

$size = [math]::Round((Get-Item $exeOut).Length / 1MB, 1)
Write-Host "[7/7] done -> $exeOut ($size MB)"