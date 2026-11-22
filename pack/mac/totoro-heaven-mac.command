#!/bin/bash
# 双击启动 totoro-heaven Mac 版（2026-11-22）
# Finder 双击 .command ⇒ 打开终端并执行本脚本：定位仓库根 → node pack/mac/launch.mjs。
# 端口/单实例/自动构建/开浏览器等语义都在 launch.mjs 里（见其头部说明）。
set -u
cd "$(cd "$(dirname "$0")" && pwd)/../.." || exit 1
exec node pack/mac/launch.mjs
