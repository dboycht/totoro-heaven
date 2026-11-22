/**
 * 客户端平台识别（SSR 与客户端**同口径**，避免水合闪烁）：
 * · SSR：读请求头 User-Agent（`useRequestHeaders` 只能在 setup 期调用）；
 * · 客户端：读 `navigator.userAgent`；
 * · 判据只有一条：UA 带 `Macintosh` / `Mac OS X` ⇒ macOS（桌面 Safari/Chrome 的 macOS UA 都含
 *   「Macintosh; Intel Mac OS X」；Windows 是 `Windows NT`、Linux 是 `X11`/`Wayland`，互不误判）。
 *
 * ⚠️ 用途仅限「灰禁 Windows 专属功能」（一键获取 token 的扫描器只支持 Windows 微信客户端），
 *   **不是安全边界** —— UA 可以伪造，服务端另有 `tokenScanSupportedOn(process.platform)` 硬闸
 *   （`/api/local/token-scan/start` fail-closed，E111 同代的 2026-11-22 Mac 门控）。
 *   返回值非响应式（UA 在一次会话内不会变），调用方直接解构即可。
 */
export function useClientPlatform(): { isMac: boolean } {
  const ua =
    import.meta.server
      ? (useRequestHeaders(['user-agent'])['user-agent'] ?? '')
      : typeof navigator !== 'undefined'
        ? navigator.userAgent
        : ''
  const isMac = /Macintosh|Mac OS X/i.test(ua)
  return { isMac }
}
