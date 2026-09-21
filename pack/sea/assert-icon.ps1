<#
  assert-icon.ps1 -- prove FROM THE ARTIFACT that our logo really is inside the EXE (2026-09-21)

  Why this file exists (audit findings, 2026-09-21):
    * build-sea.ps1 used to judge the icon by "the EXE's LastWriteTime moved" -- a METADATA proxy;
    * the rcedit-timeout branch SKIPPED the check entirely (a half-written EXE could ship);
    * and the first version of THIS script only compared RT_GROUP_ICON #1 with node.exe's group,
      i.e. it proved "different from node" but not "is OUR logo" (and it was only run BEFORE postject).

  Judgment (executable, two independent signals):
    (1) FINGERPRINT: the image block inside logo.ico must appear as one of the EXE's RT_ICON resources
        (hash equality) -- that is the only thing that actually proves "our logo is in the file";
    (2) BASELINE: the EXE's RT_GROUP_ICON #1 must DIFFER from the original node.exe's group
        (node.exe ships its own group, so "has a group" proves nothing).
    Both must pass; anything ambiguous exits 1 and the caller (build-sea.ps1) must throw.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File assert-icon.ps1 -Exe <path> -BaseNode <path> -Ico <path>

  NOTE: pure ASCII on purpose (R13: a .ps1 containing non-ASCII MUST carry a UTF-8 BOM; staying ASCII
  sidesteps the whole class of PowerShell 5.1 ANSI-decoding failures).
#>
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$BaseNode,
    [Parameter(Mandatory = $true)][string]$Ico
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Ric {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr LoadLibraryEx(string p, IntPtr h, uint f);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr FindResource(IntPtr m, IntPtr n, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr LoadResource(IntPtr m, IntPtr r);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr LockResource(IntPtr r);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint SizeofResource(IntPtr m, IntPtr r);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeLibrary(IntPtr m);
  // LOAD_LIBRARY_AS_DATAFILE (0x2) | LOAD_LIBRARY_AS_IMAGE_RESOURCE (0x20) -> read resources of an EXE/DLL
  public static byte[] Resource(string path, int id, int type) {
    IntPtr h = LoadLibraryEx(path, IntPtr.Zero, 0x2 | 0x20);
    if (h == IntPtr.Zero) throw new Exception("cannot open for resource reading: " + path);
    try {
      IntPtr res = FindResource(h, (IntPtr)id, (IntPtr)type);
      if (res == IntPtr.Zero) return null;
      uint size = SizeofResource(h, res);
      IntPtr data = LockResource(LoadResource(h, res));
      if (data == IntPtr.Zero || size == 0) return null;
      byte[] buf = new byte[size];
      Marshal.Copy(data, buf, 0, (int)size);
      return buf;
    } finally { FreeLibrary(h); }
  }
}
'@

function Get-Hash([byte[]]$bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '')
}

function Get-GroupIconHash([string]$path) {
    $b = [Ric]::Resource($path, 1, 14) # 14 = RT_GROUP_ICON
    if ($null -eq $b) { return '' }
    return (Get-Hash $b)
}

function Get-IconImageHashes([string]$path) {
    # all RT_ICON (type 3) images rcedit may write; we only need a set for membership testing
    $set = New-Object System.Collections.Generic.HashSet[string]
    for ($id = 1; $id -le 32; $id++) {
        $b = [Ric]::Resource($path, $id, 3)
        if ($null -ne $b) { [void]$set.Add((Get-Hash $b)) }
    }
    return $set
}

function Get-IcoImageHash([string]$icoPath) {
    $raw = [System.IO.File]::ReadAllBytes($icoPath)
    if ($raw.Length -lt 22) { throw "not a valid .ico (too small): $icoPath" }
    $count = [BitConverter]::ToUInt16($raw, 4)
    if ($count -lt 1) { throw "not a valid .ico (no images): $icoPath" }
    $len = [BitConverter]::ToUInt32($raw, 6 + 8)
    $off = [BitConverter]::ToUInt32($raw, 6 + 12)
    if ($len -le 0 -or ($off + $len) -gt $raw.Length) { throw "not a valid .ico (bad image block): $icoPath" }
    $img = New-Object byte[] $len
    [Array]::Copy($raw, $off, $img, 0, $len)
    return (Get-Hash $img)
}

$exeGroup = Get-GroupIconHash $Exe
$baseGroup = Get-GroupIconHash $BaseNode

if ([string]::IsNullOrEmpty($exeGroup)) {
    Write-Host "[icon] FAIL: no RT_GROUP_ICON #1 found in $Exe (the icon was not written at all)"
    exit 1
}
if ([string]::IsNullOrEmpty($baseGroup)) {
    Write-Host "[icon] FAIL: the node.exe base has no RT_GROUP_ICON #1 to compare against -> cannot prove ours was applied"
    exit 1
}

# (1) FINGERPRINT: is OUR image actually inside the EXE?
$want = Get-IcoImageHash $Ico
$have = Get-IconImageHashes $Exe
if (-not $have.Contains($want)) {
    Write-Host "[icon] FAIL: the image inside $Ico is NOT present among the EXE's RT_ICON resources -> our logo was not embedded"
    Write-Host "[icon]       (expected image hash $($want.Substring(0,16))..., EXE has $($have.Count) icon image(s))"
    exit 1
}

# (2) BASELINE: the group icon must no longer be node.exe's own
if ($exeGroup -eq $baseGroup) {
    Write-Host "[icon] FAIL: the EXE's RT_GROUP_ICON #1 is IDENTICAL to node.exe's -> our group icon was not applied"
    exit 1
}

Write-Host "[icon] OK: logo.ico's image found among the EXE's RT_ICONs, and RT_GROUP_ICON #1 differs from node.exe."
Write-Host "[icon]     image=$($want.Substring(0,16))... group.exe=$($exeGroup.Substring(0,16))... group.node=$($baseGroup.Substring(0,16))..."
exit 0
