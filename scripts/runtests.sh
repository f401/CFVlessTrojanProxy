#!/bin/bash
# 一条命令跑完全部检查
set -euo pipefail
cd "$(dirname "$0")/.."
node tools/tsc.js
node build.js
node test/mk_test.mjs >/dev/null
node test/test_v3.mjs
node test/smoke_v3.mjs
node test/test_score.mjs
