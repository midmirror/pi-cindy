#!/usr/bin/env bash
# pi-cindy 安装脚本
# 在 pi-cindy 目录下运行: bash install.sh
set -euo pipefail
cd "$(dirname "$0")"
npm install --omit=dev 2>&1
echo "pi-cindy installed"
