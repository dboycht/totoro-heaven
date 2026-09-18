# Build the totoro-heaven single-file EXE (Node SEA)
# Usage: .\pack\sea\build-sea.ps1
# It verifies that .output is a clean production build and rebuilds automatically when the output
# is missing or polluted by dev artifacts (a dev/empty output packed into the EXE => blank page).
#
# NOTE: keep this file **pure ASCII** (project rule / ERROR.md E3, E14). PowerShell 5.1 reads a
# UTF-8 file WITHOUT BOM as ANSI, so non-ASCII comments get mangled and can swallow the code line
# that follows them (2026-09-18: adding Chinese comments here nulled $outputDir and broke the build).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

# Read version early: needed by both the esbuild step and the SPA-content assertion below.
# (Read via node to avoid PowerShell regex/encoding pitfalls.)
$ver = (& node -e "console.log(require(process.argv[1]).version)" (Join-Path $root 'package.json')) 2>$null
if (-not $ver) { throw 'cannot read version from package.json' }
Write-Host "[ver] root=$root ver=$ver"

$distSea = Join-Path $root 'dist\sea'
$exeOut = Join-Path $root 'dist\totoro-heaven.exe'
if (-not (Test-Path $distSea)) { New-Item -ItemType Directory -Path $distSea | Out-Null }

# ---- [0/8-pre] pre-flight: clean up leftovers (a hung rcedit locks the EXE / old EXE already has a blob) ----
Get-Process -Name rcedit -ErrorAction SilentlyContinue | ForEach-Object {
    try { if ($_.Path -like "$root*") { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } } catch {}
}
if (Test-Path $exeOut) { Remove-Item $exeOut -Force -ErrorAction SilentlyContinue }

# ---- [0/7] make sure .output is a production build ----
# Note: an ssr:false SPA build has no static public/index.html (HTML is rendered at runtime by nitro
#       through client.manifest.mjs), so the pollution check keys off client.manifest.mjs instead.
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

# ---- [0.5] SPA content assertion: the .output MUST have been built from the CURRENT sources ----
# 2026-09-18 incident: the [0/7] check above only detects a DIRECTORY-STRUCTURE problem
# (@vite/client or absolute paths). A .output left over from an OLDER release passes that check, so
# the packer reused it and shipped the OLD UI: releases 1.1.7 and 1.1.8 both went out with 1.1.6-era
# front-end code (no track editor / no local route library / no trajectory preview) while only the
# version number inside the EXE was swapped. Measured on the published zips: those two EXEs contain
# release entries 1.1.3..1.1.6 and no 1.1.7/1.1.8 at all.
#
# Judgment (executable). Historical entries are EXPECTED in a bundle (releaseArt.ts keeps them so the
# version page can fall back), and so are PLANNED future entries (e.g. 1.2.0 with planned: true), so
# the test cannot be "no other versions present". The reliable signal is:
#   **the bundle must contain the entry for the CURRENT version** - a stale output cannot contain it,
#   because the release-art list is compiled from src/mp/releaseArt.ts by the same `npm run build`.
# A *newer-than-current* entry is only reported as a warning (it may be a legitimate planned entry).
$chunkFiles = @(Get-ChildItem $outputDir -Recurse -File -Include *.js, *.mjs -ErrorAction SilentlyContinue)
if ($chunkFiles.Count -eq 0) { throw "[0.5] no js chunks found under .output - build output looks broken" }

function To-Comparable([string]$v) {
    $p = $v.Split('.')
    return ([int]$p[0] * 10000) + ([int]$p[1] * 100) + ([int]$p[2])
}
$curNum = To-Comparable $ver
$allEntries = @()
foreach ($f in $chunkFiles) {
    foreach ($m in (Select-String -Path $f.FullName -Pattern 'version:"(1\.[0-9]+\.[0-9]+)"' -AllMatches -ErrorAction SilentlyContinue).Matches) { $allEntries += $m.Groups[1].Value }
}
$uniqEntries = @($allEntries | Sort-Object -Unique)
if (-not ($uniqEntries -contains $ver)) {
    throw "[0.5] .output has no release entry for version $ver => it is a STALE build (entries: [$($uniqEntries -join ', ')]). Delete .output and rebuild."
}
$newer = @($uniqEntries | Where-Object { (To-Comparable $_) -gt $curNum })
if ($newer.Count -gt 0) {
    Write-Warning "[0.5] .output also contains entries newer than $ver : [$($newer -join ', ')] - fine if those are PLANNED entries, otherwise the output is suspicious."
}
Write-Host "[0.5] SPA content OK: entry for $ver present. (versions in bundle: $($uniqEntries -join ', '))"

# ---- [0.6] version-art: keep ONLY the current version's image ----
# User-facing rule: the version page only ever shows the CURRENT version's artwork, so older (and
# future) artwork must never be shipped. Historically the source folder accumulates artwork for
# several versions, and .output copies all of it verbatim (outputDir/public is a verbatim copy),
# which both ships wrong images and bloats the EXE. Here we sync it down to exactly "<ver>.png".
$srcArt = Join-Path $root 'public\version-art'
$outArt = Join-Path $outputDir 'public\version-art'
if (-not (Test-Path -LiteralPath (Join-Path $srcArt "$ver.png"))) {
    throw "[0.6] public\version-art\$ver.png is missing - the version page would show a placeholder. Add the artwork before packaging."
}
if (Test-Path $outArt) { Remove-Item $outArt -Recurse -Force }
New-Item -ItemType Directory -Path $outArt | Out-Null
Copy-Item -LiteralPath (Join-Path $srcArt "$ver.png") -Destination $outArt
$packedArt = @(Get-ChildItem $outArt -File -Filter '*.png' | ForEach-Object { $_.Name })
if ($packedArt.Count -ne 1 -or $packedArt[0] -ne "$ver.png") {
    throw "[0.6] version-art assertion failed: expected exactly [$ver.png], got [$($packedArt -join ', ')]"
}
Write-Host "[0.6] version-art OK: shipping only $ver.png (stale/future artwork excluded)."

Write-Host '[1/7] bundle launcher (esbuild)...'
$esbuild = Join-Path $root 'node_modules\.bin\esbuild.cmd'
if (-not (Test-Path $esbuild)) { throw "esbuild not found at $esbuild" }
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
# Order matters (2026-09-09 incident): rcedit hangs and fails to write the icon on a SEA exe that
# already contains NODE_SEA_BLOB (its signature is corrupted by postject). So set the icon on the
# plain node.exe copy FIRST, then inject the blob; postject does not touch the resource section.
$rcedit = Join-Path $root 'node_modules\rcedit\bin\rcedit.exe'
$logoIco = Join-Path $root 'logo.ico'
$hasRcedit = Test-Path $rcedit
$hasIcon = Test-Path $logoIco
if ($hasRcedit -and $hasIcon) {
    $rceditProc = Start-Process -FilePath $rcedit -ArgumentList @($exeOut, '--set-icon', $logoIco) -PassThru -NoNewWindow
    # Safety net: cap at 120s (on a non-postjected exe it exits normally right away)
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
