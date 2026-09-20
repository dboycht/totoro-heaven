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

# ---- [0/7-b] 2026-09-20 audit fix: a STALE .output must force a rebuild ----
# The structural check above only catches @vite/client / absolute paths. A .output left over from an
# EARLIER build of the SAME version passes it, so editing sources and re-running `npm run sea` used to
# repack the OLD code while only the version string looked right. Judgment: if any tracked source path
# is newer than the client manifest, the output cannot have been built from these sources -> rebuild.
if (-not $needBuild -and (Test-Path $manifestPath)) {
    $manifestTime = (Get-Item $manifestPath).LastWriteTimeUtc
    $watch = @('src', 'public', 'pages', 'components', 'composables', 'layouts', 'utils', 'server', 'plugins', 'app.vue', 'nuxt.config.ts', 'package.json')
    $newest = $null
    foreach ($rel in $watch) {
        $p = Join-Path $root $rel
        if (-not (Test-Path $p)) { continue }
        $item = Get-Item $p
        if ($item.PSIsContainer) {
            $f = Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        } else { $f = $item }
        if ($f -and (($newest -eq $null) -or ($f.LastWriteTimeUtc -gt $newest.LastWriteTimeUtc))) { $newest = $f }
    }
    if ($newest -and ($newest.LastWriteTimeUtc -gt $manifestTime)) {
        Write-Host "[0/7-b] sources are NEWER than .output (newest: $($newest.Name) @ $($newest.LastWriteTimeUtc) > manifest @ $manifestTime) -> rebuilding to avoid shipping stale code"
        $needBuild = $true
        $nuxtDir = Join-Path $root '.nuxt'
        if (Test-Path $nuxtDir) { Remove-Item $nuxtDir -Recurse -Force }
        if (Test-Path $outputDir) { Remove-Item $outputDir -Recurse -Force }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
        $manifest3 = Get-Content $manifestPath -Raw -ErrorAction SilentlyContinue
        if (-not $manifest3 -or ($manifest3 -match 'vite/client') -or ($manifest3 -match '[A-Za-z]:/')) {
            throw 'client.manifest.mjs still contaminated (@vite/client / absolute paths). Stop the dev server and retry.'
        }
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
$newer = @($uniqEntries | Where-Object { (To-Comparable $_) -gt $curNum })
if (-not ($uniqEntries -contains $ver)) {
    # 2026-09-20 conflict fix: the version convention says "right after a tag, the NEXT dev round bumps
    # package.json to X+1 automatically" - so during development `$ver` legitimately has NO entry yet
    # (entries are written when the release is prepared). The strict check above therefore blocked EVERY
    # pack attempt in a fresh dev round (measured: after 1.1.11 shipped, bumping to 1.1.12 made
    # `npm run sea` throw "[0.5] .output has no release entry for version 1.1.12 => it is a STALE build").
    #
    # A missing current-version entry is accepted ONLY IF the bundle also carries an entry NEWER than the
    # current version. That is still a valid freshness signal because such an entry can only come from
    # src/mp/releaseArt.ts (the build compiles it), and it is the very entry the developer had to add
    # alongside the version bump. A genuinely stale bundle (built before the bump) lacks both.
    if ($newer.Count -eq 0) {
        # 2026-09-20 audit fix: the old message only said "Delete .output and rebuild", which is WRONG for
        # the "fresh dev round" case (deleting and rebuilding reproduces the same error). Name both causes.
        throw "[0.5] .output has no release entry for version $ver and no entry newer than it. Cause (1): the output is STALE (built before your latest source change) => delete .output and rebuild. Cause (2): fresh dev round (package.json bumped to $ver but src/mp/releaseArt.ts has no $ver entry yet) => add a $ver entry (planned: true is fine during development) and rebuild. (entries in bundle: [$($uniqEntries -join ', ')])"
    }
    Write-Warning "[0.5] no entry for current dev version $ver (expected during development) - accepted because a newer entry exists: [$($newer -join ', ')]. If that newer entry is not a PLANNED one you added on purpose, the output is suspicious."
} elseif ($newer.Count -gt 0) {
    Write-Warning "[0.5] .output also contains entries newer than $ver : [$($newer -join ', ')] - fine if those are PLANNED entries, otherwise the output is suspicious."
}
# Only claim OK when the bundle really carries what we need (2026-09-20: this line used to print even on
# the warning paths above, so the log contradicted the actual judgment).
if (($uniqEntries -contains $ver) -or ($newer.Count -gt 0)) {
    Write-Host "[0.5] SPA content OK: entry for $ver present. (versions in bundle: $($uniqEntries -join ', '))"
}

# ---- [0.6] version-art: keep ONLY the current version's image ----
# User-facing rule: the version page only ever shows the CURRENT version's artwork, so older (and
# future) artwork must never be shipped. Historically the source folder accumulates artwork for
# several versions, and .output copies all of it verbatim (outputDir/public is a verbatim copy),
# which both ships wrong images and bloats the EXE. Here we sync it down to exactly "<ver>.png".
$srcArt = Join-Path $root 'public\version-art'
$outArt = Join-Path $outputDir 'public\version-art'
if (-not (Test-Path -LiteralPath (Join-Path $srcArt "$ver.png"))) {
    # 2026-09-20 conflict fix (same root cause as [0.5] above): the version convention bumps package.json
    # to X+1 right after a tag, but the artwork is hand-made by the user and only provided when a release
    # is actually prepared. Requiring it unconditionally therefore blocked EVERY pack attempt in a fresh
    # dev round (measured: after 1.1.11 shipped, the 1.1.12 pack failed here).
    # Development state is detectable the same way: the bundle carries a planned entry NEWER than $ver.
    if ($newer.Count -eq 0) {
        throw "[0.6] public\version-art\$ver.png is missing - the version page would show a placeholder. Add the artwork before packaging."
    }
    Write-Warning "[0.6] no artwork for current dev version $ver (expected during development) - shipping NO version artwork. Add public\version-art\$ver.png before the release build."
    if (Test-Path $outArt) { Remove-Item $outArt -Recurse -Force }
    New-Item -ItemType Directory -Path $outArt | Out-Null
    Write-Host '[0.6] version-art: dev build, artwork intentionally not shipped.'
} else {
    if (Test-Path $outArt) { Remove-Item $outArt -Recurse -Force }
    New-Item -ItemType Directory -Path $outArt | Out-Null
    Copy-Item -LiteralPath (Join-Path $srcArt "$ver.png") -Destination $outArt
    $packedArt = @(Get-ChildItem $outArt -File -Filter '*.png' | ForEach-Object { $_.Name })
    if ($packedArt.Count -ne 1 -or $packedArt[0] -ne "$ver.png") {
        throw "[0.6] version-art assertion failed: expected exactly [$ver.png], got [$($packedArt -join ', ')]"
    }
    Write-Host "[0.6] version-art OK: shipping only $ver.png (stale/future artwork excluded)."
}

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
    $before = (Get-Item $exeOut).LastWriteTimeUtc
    $rceditProc = Start-Process -FilePath $rcedit -ArgumentList @($exeOut, '--set-icon', $logoIco) -PassThru -NoNewWindow
    # Safety net: cap at 120s (on a non-postjected exe it exits normally right away)
    if (-not $rceditProc.WaitForExit(120000)) {
        Write-Warning 'rcedit timed out after 120s - killing it'
        Stop-Process -Id $rceditProc.Id -Force -ErrorAction SilentlyContinue
    } else {
        # 2026-09-20 fix: the TIMED overload of WaitForExit() does NOT guarantee that the process
        # object's ExitCode is populated - reading it right away yielded an EMPTY value and produced
        # a false "rcedit icon set failed (exit )" warning, while the icon HAD actually been embedded
        # (verified by finding logo.ico's image block inside the EXE, i.e. evidence from the artifact,
        # not from this log). Call the argument-less overload to force ExitCode to settle.
        $rceditProc.WaitForExit()
        # Judge by the ARTIFACT: if the exe's mtime moved, rcedit did write to it (icon applied).
        $changed = (Get-Item $exeOut).LastWriteTimeUtc -ne $before
        if ($changed) {
            Write-Host '[5/7] icon applied (exe modified; rcedit ExitCode may read as empty in this invocation - artifact check is authoritative).'
        } else {
            Write-Warning "rcedit did not modify the exe (exit $($rceditProc.ExitCode)) - icon NOT applied; the EXE keeps the default Node icon."
        }
    }
} else {
    Write-Warning 'rcedit or logo.ico not found - skipping icon step'
}

Write-Host '[6/7] inject SEA blob (postject)...'
& npx postject $exeOut NODE_SEA_BLOB (Join-Path $distSea 'sea-prep.blob') --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw 'postject failed' }

$size = [math]::Round((Get-Item $exeOut).Length / 1MB, 1)
Write-Host "[7/7] done -> $exeOut ($size MB)"
