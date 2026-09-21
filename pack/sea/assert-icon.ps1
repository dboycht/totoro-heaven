<#
  assert-icon.ps1 -- prove FROM THE ARTIFACT that our logo was really applied to the EXE (2026-09-21)

  Why this file exists (audit finding):
    build-sea.ps1 used to judge the icon by "the EXE's LastWriteTime moved", which is a METADATA proxy, not the
    icon itself:
      * rcedit could write *something* while the icon never took effect -> the pack would still pass;
      * the rcedit-timeout branch SKIPPED the check entirely -> a half-written EXE could be shipped.
    Also note: node.exe ships its OWN icon group, so "the EXE has an icon group" is NOT proof that ours was set.

  Judgment (executable):
    read RT_GROUP_ICON #1 out of BOTH the produced EXE and the original node.exe base, hash them, and require
    them to DIFFER. Exit 0 = ours applied; exit 1 = not applied (or unreadable) -> callers must throw.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File assert-icon.ps1 -Exe <path> -BaseNode <path>

  NOTE: this file is intentionally pure ASCII (R13: a .ps1 with non-ASCII must carry a UTF-8 BOM; keeping it
  ASCII avoids the whole class of PowerShell 5.1 ANSI-decoding failures).
#>
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$BaseNode
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
  public static byte[] GroupIcon(string path) {
    // LOAD_LIBRARY_AS_DATAFILE (0x2) | LOAD_LIBRARY_AS_IMAGE_RESOURCE (0x20) -> read resources of an EXE/DLL
    IntPtr h = LoadLibraryEx(path, IntPtr.Zero, 0x2 | 0x20);
    if (h == IntPtr.Zero) throw new Exception("cannot open for resource reading: " + path);
    try {
      IntPtr res = FindResource(h, (IntPtr)1, (IntPtr)14); // 14 = RT_GROUP_ICON, id 1
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

function Get-GroupIconHash([string]$path) {
    $bytes = [Ric]::GroupIcon($path)
    if ($null -eq $bytes) { return '' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '')
}

$exeHash = Get-GroupIconHash $Exe
$baseHash = Get-GroupIconHash $BaseNode

if ([string]::IsNullOrEmpty($exeHash)) {
    Write-Host "[icon] FAIL: no RT_GROUP_ICON #1 found in $Exe (the icon was not written at all)"
    exit 1
}
if ([string]::IsNullOrEmpty($baseHash)) {
    Write-Host "[icon] FAIL: the node.exe base has no icon group to compare against -> cannot prove ours was applied"
    exit 1
}
if ($exeHash -eq $baseHash) {
    Write-Host "[icon] FAIL: the EXE's icon group is IDENTICAL to node.exe's -> our logo was NOT applied"
    exit 1
}
Write-Host "[icon] OK: icon group differs from node.exe (ours applied). exe=$($exeHash.Substring(0,16)) base=$($baseHash.Substring(0,16))"
exit 0
