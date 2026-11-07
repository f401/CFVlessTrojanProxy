#!/bin/bash
# 拉取构建依赖：typescript（npm 或 jsDelivr）+ 混淆器（jsDelivr 单文件）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/2] typescript"
if [ -d node_modules/typescript ]; then
  echo "  已存在，跳过"
else
  npm install --no-audit --no-fund --loglevel=error
fi

echo "[2/2] obfuscator"
if [ -f obf/obfuscator-browser.js ]; then
  echo "  已存在，跳过"
else
  curl -fL -o obf/obfuscator-browser.js \
    https://cdn.jsdelivr.net/npm/javascript-obfuscator@4.1.1/dist/index.browser.js
fi

echo "完成。"
