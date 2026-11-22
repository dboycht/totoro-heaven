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
 *    🔴 这条规则**在 2026-10-14 被实测打脸过一次**：模板里漏了一行中文注释（17 个 CJK 字符），
 *    于是运行期写盘的 .ps1 根本不是纯 ASCII（当时只是"站在坑边"、还没踩响，见 ERROR.md E80）。
 *    现在有单测 `tests/mp/tokenScanLaunch.test.ts` 直接对 `TOKEN_SCAN_PS1` 断言纯 ASCII。
 *
 * 🆕 2026-10-14（E80 轮，起因：有用户在 Windows 26H2 上报"扫描器未回传结果（退出码 4294967295）"）：
 *   ① **加 `trap`：任何未捕获错误都先把失败原因回传**，不再让界面只看到一个冷冰冰的退出码；
 *   ② **`$script:TotoroPhase` 记录"死在哪一步"**，随载荷一起回传（start/compile/enumerate/scan/post）；
 *   ③ **参数名 `-Endpoint` → `-CallbackUrl`**：⚠️ 口径 —— 这**不是**根因，而且**已被实测否掉**：
 *      「宿主把 `-Endpoint` 当自己的开关吃掉」这个假说，在**真 Windows 11 26H2（build 26300.9711）**上
 *      用四个用例验过 —— 原名 / 改名 / 原名+`-NonInteractive` **全部退 0**，宿主级 `-Endpoint` 退 1
 *      （"无法识别为 cmdlet"），且那台宿主的 `-Help` 开关表里**没有 `-Endpoint`**（只有 `-WorkingDirectory` 这类）。
 *      ⇒ **名字当年不是原因**。改名留着只是**零成本避嫌**（万一将来换了内核、多了同名宿主开关时不容易撞），
 *      但**谁也别再把它写成"修复了什么"**。
 *      复现探针：`_mp-analyze/scratch/probe-26h2-endpoint.ps1`；那份实测报告：`download/report.txt`（详见 ERROR.md E80）。
 *   ④ **把 `[Console]::OutputEncoding` 固定成 UTF-8**：否则中文错误信息在 GBK 控制台下会写成乱码，
 *      抓回来也读不懂（`tokenScanRunner.ts` 另有一层 GBK 兜底解码）。
 */

/* ⚠️ 2026-09-19 删除**零引用**的 `TOKEN_SCAN_TIMEOUT_MS`：真实超时由
   `tokenScanRunner.ts` 的轮询间隔与 PS 脚本内的 `-TimeoutSec` 决定，这个常量从未被读取。 */

/**
 * 🔒 启动扫描器的**参数表唯一出口**（顺序在单测里钉死）。
 *
 * ⚠️ `-NonInteractive` **必须在 `-File` 之前**：`-File` 之后的一切都被宿主当成"脚本自己的参数"，
 *    放到后面会让脚本收到一个它不认识的参数而**当场报错退出**（2026-10-14 实测）。
 * ⚠️ 位置参数（脚本路径、回传地址、nonce）也必须守在 `-File` 之后，这是宿主文档规定的语义：
 *    "File must be the last parameter in the command… all values typed after the File parameter
 *     are interpreted as the script filepath and parameters passed to that script."
 */
export function tokenScannerArgs(script: string, callbackUrl: string, nonce: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-CallbackUrl',
    callbackUrl,
    '-Nonce',
    nonce,
  ]
}

/**
 * 🔒 平台硬闸（2026-11-22 Mac 门控）：扫描器用 Win32 调试 API
 * （`OpenProcess` / `ReadProcessMemory` / `VirtualQueryEx`）读 **Windows 微信**的进程内存 ⇒
 * 只有 `win32` 支持。Mac（darwin）/Linux 上 `/api/local/token-scan/start` **fail-closed**；
 * 前端的按钮灰禁（`composables/useClientPlatform.ts`，按 UA 判）只是 UI 引导，**这里才是判据**
 * —— UA 可以伪造，`process.platform` 不会。Mac 拿 token 走「粘贴 → 读取真实账号与任务」。
 */
export function tokenScanSupportedOn(platform: string = process.platform): boolean {
  return platform === 'win32'
}

export const TOKEN_SCAN_PS1 = `param(
  [Parameter(Mandatory=$true)][string]$CallbackUrl,
  [Parameter(Mandatory=$true)][string]$Nonce,
  [int]$Max = 12,
  [string]$TitleNeedle = ''
)
$ErrorActionPreference = 'Stop'

# "long mao" (totoro) written as char codes on purpose: a BOM-less .ps1 is decoded as
# the system ANSI codepage by PS 5.1, so THIS FILE MUST STAY PURE ASCII (ERROR.md E14/E80).
if ([string]::IsNullOrEmpty($TitleNeedle)) { $TitleNeedle = -join ([char]0x9F99, [char]0x732B) }

# Keep console output UTF-8 so Chinese error text survives the pipe back to Node
# (tokenScanRunner also has a GBK fallback for the case where we die before this line).
# The catch below is intentionally silent: this is cosmetic, scanning must not depend on it.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {
  # best effort only: we still scan, the caller just decodes the text as ANSI instead
}

$script:TotoroPhase = 'start'

# Report any uncaught failure back BEFORE exiting: otherwise the UI only ever sees a bare
# exit code and nobody can tell "parameter rejected" from "blocked" from "killed" (ERROR.md E80).
trap {
  $detail = ''
  try {
    $detail = [string]$_.Exception.Message
    if ($_.InvocationInfo -and $_.InvocationInfo.ScriptLineNumber) {
      $detail = ('line ' + $_.InvocationInfo.ScriptLineNumber + ': ' + $detail)
    }
  } catch {
    # best effort: $detail is a nice-to-have, never let its failure replace the real error
  }
  try {
    $fail = @{
      nonce = $Nonce
      tokens = @()
      error = 'SCRIPT_FAILED'
      processes = -1
      phase = [string]$script:TotoroPhase
      detail = $detail
      psVersion = $PSVersionTable.PSVersion.ToString()
    } | ConvertTo-Json -Depth 3 -Compress
    Invoke-RestMethod -Method Post -Uri $CallbackUrl -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($fail)) -TimeoutSec 10 | Out-Null
  } catch {
    # best effort: the callback endpoint itself is unreachable - the runner still records our stdout
  }
  exit 1
}

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

$script:TotoroPhase = 'compile'
Add-Type -TypeDefinition $cs -Language CSharp | Out-Null

$script:TotoroPhase = 'enumerate'
$procs = @(Get-Process -Name 'WeChatAppEx' -ErrorAction SilentlyContinue | Where-Object { $_ -ne $null })
$tokens = New-Object System.Collections.Generic.List[string]
$scanError = ''

if ($procs.Count -eq 0) {
  $scanError = 'NO_PROCESS'
} else {
  $script:TotoroPhase = 'scan'
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
  phase = [string]$script:TotoroPhase
  psVersion = $PSVersionTable.PSVersion.ToString()
} | ConvertTo-Json -Depth 3 -Compress

$script:TotoroPhase = 'post'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
try {
  Invoke-RestMethod -Method Post -Uri $CallbackUrl -ContentType 'application/json' -Body $bytes -TimeoutSec 30 | Out-Null
} catch {
  Write-Host ('POST failed: ' + $_.Exception.Message)
  exit 1
}
exit 0
`
