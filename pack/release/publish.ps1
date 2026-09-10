# 一键发布 totoro-heaven release（读 Windows 凭据管理器 token -> 设 GH_TOKEN -> node release.cjs）
# 用法：.\pack\release\publish.ps1   （可选 -Tag 1.0.4 覆盖 TAG）
param([string]$Tag = '1.0.4')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Cred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr credentialPtr);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static string GetStr(string target, int type) {
    IntPtr p; if (!CredRead(target, type, 0, out p)) return "";
    var c = Marshal.PtrToStructure<CREDENTIAL>(p);
    string s="";
    if (c.CredentialBlobSize>0 && c.CredentialBlob!=IntPtr.Zero) {
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      s = System.Text.Encoding.Unicode.GetString(b);
    }
    CredFree(p);
    return s;
  }
}
'@

$tok = [Cred]::GetStr('git:https://github.com', 1)
if ($tok -match '^gho_') {
  $env:GH_TOKEN = $tok
  Write-Host ("token ok (len " + $tok.Length + ") -> publishing tag " + $Tag)
  node --use-system-ca (Join-Path $PSScriptRoot 'release.cjs')
} else {
  Write-Host '未能从 Windows 凭据管理器读取 GitHub token（git:https://github.com）'
  exit 1
}
