#!/bin/bash
# 一条命令跑完全部检查（与 deploy.sh 的验证段保持一致）
set -euo pipefail
cd "$(dirname "$0")/.."
node tools/check-arch.js
node tools/tsc.js
node tools/bundle.js
node test/mk_test.mjs >/dev/null
node test/test_v3.mjs
node test/smoke_v3.mjs
node test/test_score.mjs
node test/sim_v3.mjs
node test/golden.mjs
