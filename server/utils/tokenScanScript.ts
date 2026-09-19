/**
 * 「一键获取 token」的**内存扫描器**源码（PowerShell 5.1 + Add-Type P/Invoke）
 *
 * 为什么把脚本作为**字符串常量**放在这里：发布物是 **Node SEA 单文件 EXE**，
 * 外部 .ps1 不会被打进去 —— 内嵌后由服务端在运行时写到临时目录再执行，dev 与 EXE 行为一致。
 *
 * 移植自用户提供的 `open-totoro-token`（MIT，`memory_scanner.py`；见 `_mp-analyze/token便携获取-内存扫描法.md`）：
 *   - 只读扫描 `WeChatAppEx.exe`（PC 微信小程序宿主）内存，找 `WXXCX` + base64、长度 ≥80 的候选串；
 *   - 标准 Win32 调试 API（`OpenProcess(PROCESS_VM_READ)` / `ReadProcessMemory` / `VirtualQueryEx`），
 *     **不写内存、不注入、不 hook、不需要管理员**；
 *   - 只把**候选列表**回传到本地端点，由服务端**逐个验活**（避免拿到内存里残留的旧 token）。
 *
 * ⚠️ 源码必须**纯 ASCII**（本机 PS 5.1 读无 BOM 文件按系统 ANSI 解码，见 ERROR.md E14）——
 *    因此"龙猫"二字用 `[char]0x9F99 + [char]0x732B` 拼出来，而不是字面量。
 */

/* ⚠️ 2026-09-19 删除**零引用**的 `TOKEN_SCAN_TIMEOUT_MS`：真实超时由
   `tokenScanRunner.ts` 的轮询间隔与 PS 脚本内的 `-TimeoutSec` 决定，这个常量从未被读取。 */

export const TOKEN_SCAN_PS1 = `param(
  [Parameter(Mandatory=$true)][string]$Endpoint,
  [Parameter(Mandatory=$true)][string]$Nonce,
  [int]$Max = 12,
  [string]$TitleNeedle = ''
)
$ErrorActionPreference = 'Stop'

# "龙猫" 的 ASCII-only 写法（避免无 BOM 中文被 PS 5.1 按 ANSI 误解码）
if ([string]::IsNullOrEmpty($TitleNeedle)) { $TitleNeedle = -join ([char]0x9F99, [char]0x732B) }

$cs = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class TotoroMemScan {
  [StructLayout(LayoutKind.Sequential)]
  public struct MEMORY_BASIC_INFORMATION {
    public IntPtr BaseAddress;
    public IntPtr AllocationBase;
    public uint AllocationProtect;
    public UIntPtr RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, IntPtr mbi, IntPtr len);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint PROCESS_VM_READ = 0x0010;
  const uint PROCESS_QUERY_INFORMATION = 0x0400;
  const uint MEM_COMMIT = 0x1000;
  const uint MEM_PRIVATE = 0x20000;
  const uint MEM_MAPPED = 0x40000;
  const uint MEM_IMAGE = 0x1000000;
  const uint PAGE_GUARD = 0x100;
  const int CHUNK = 1048576;
  const int OVERLAP = 4096;
  const int MIN_LEN = 80;
  const long MAX_REGION = 536870912L;

  static void ScanBuffer(byte[] buf, int len, List<string> found, int max) {
    for (int i = 0; i + 5 <= len; i++) {
      if (!(buf[i] == 87 && buf[i + 1] == 88 && buf[i + 2] == 88 && buf[i + 3] == 67 && buf[i + 4] == 88)) continue;
      int end = i + 5;
      while (end < len) {
        byte b = buf[end];
        bool okc = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 43 || b == 47 || b == 61;
        if (!okc) break;
        end++;
      }
      int l = end - i;
      if (l >= MIN_LEN) {
        string s = Encoding.ASCII.GetString(buf, i, l);
        if (!found.Contains(s)) { found.Add(s); if (found.Count >= max) return; }
      }
      i = end - 1;
    }
  }

  public static string[] Scan(int pid, int max) {
    List<string> found = new List<string>();
    IntPtr h = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return found.ToArray();
    try {
      int mbiSize = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
      IntPtr mbiPtr = Marshal.AllocHGlobal(mbiSize);
      try {
        long addr = 0;
        byte[] buf = new byte[CHUNK];
        while (addr >= 0 && addr < 0x7FFFFFFFFFFF) {
          if (VirtualQueryEx(h, new IntPtr(addr), mbiPtr, new IntPtr(mbiSize)) == IntPtr.Zero) break;
          MEMORY_BASIC_INFORMATION mbi = (MEMORY_BASIC_INFORMATION)Marshal.PtrToStructure(mbiPtr, typeof(MEMORY_BASIC_INFORMATION));
          long region = (long)mbi.RegionSize.ToUInt64();
          if (region <= 0) break;
          bool wanted = mbi.State == MEM_COMMIT && region <= MAX_REGION &&
            (mbi.Type == MEM_PRIVATE || mbi.Type == MEM_MAPPED || mbi.Type == MEM_IMAGE) &&
            (mbi.Protect & PAGE_GUARD) == 0;
          if (wanted) {
            long off = 0;
            long baseAddr = mbi.BaseAddress.ToInt64();
            while (off < region) {
              int readSize = (int)Math.Min((long)CHUNK, region - off);
              IntPtr got;
              if (ReadProcessMemory(h, new IntPtr(baseAddr + off), buf, new IntPtr(readSize), out got)) {
                int n = (int)got;
                if (n > 0) {
                  ScanBuffer(buf, n, found, max);
                  if (found.Count >= max) return found.ToArray();
                }
              }
              if (off + readSize >= region) break;
              off += readSize - OVERLAP;
            }
          }
          addr += region;
        }
      } finally { Marshal.FreeHGlobal(mbiPtr); }
    } finally { CloseHandle(h); }
    return found.ToArray();
  }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp | Out-Null

$procs = @(Get-Process -Name 'WeChatAppEx' -ErrorAction SilentlyContinue | Where-Object { $_ -ne $null })
$tokens = New-Object System.Collections.Generic.List[string]
$scanError = ''

if ($procs.Count -eq 0) {
  $scanError = 'NO_PROCESS'
} else {
  $withTitle = @($procs | Where-Object { $_.MainWindowTitle -like ('*' + $TitleNeedle + '*') })
  $without = @($procs | Where-Object { -not ($_.MainWindowTitle -like ('*' + $TitleNeedle + '*')) })
  $ordered = @($withTitle) + @($without)
  foreach ($p in $ordered) {
    try {
      $r = [TotoroMemScan]::Scan($p.Id, $Max)
      if ($r -and $r.Count -gt 0) {
        foreach ($t in $r) { if (-not $tokens.Contains($t)) { $tokens.Add($t) } }
        if ($tokens.Count -ge $Max) { break }
      }
    } catch {
      Write-Host ('scan pid ' + $p.Id + ' failed: ' + $_.Exception.Message)
    }
  }
  if ($tokens.Count -eq 0) { $scanError = 'NO_TOKEN' }
}

$payload = @{
  nonce = $Nonce
  tokens = @($tokens)
  error = $scanError
  processes = $procs.Count
} | ConvertTo-Json -Depth 3 -Compress

$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
try {
  Invoke-RestMethod -Method Post -Uri $Endpoint -ContentType 'application/json' -Body $bytes -TimeoutSec 30 | Out-Null
} catch {
  Write-Host ('POST failed: ' + $_.Exception.Message)
  exit 1
}
exit 0
`
