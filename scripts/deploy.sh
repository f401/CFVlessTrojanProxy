#!/bin/bash
# 构建 → 混淆 → 上传
#   用法：./scripts/deploy.sh [--no-obf]
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f config/config.env ] || { echo "缺少 config/config.env（参考 config/config.env.example）"; exit 1; }
# shellcheck disable=SC1091
source config/config.env

META="${META:-config/metadata.json}"
[ -f "$META" ] || { echo "缺少 $META（参考 config/metadata.example.json）"; exit 1; }

node tools/check-arch.js
node tools/tsc.js
node tools/bundle.js
node test/mk_test.mjs >/dev/null
node test/test_v3.mjs >/dev/null
node test/smoke_v3.mjs >/dev/null
node test/test_score.mjs >/dev/null
node test/sim_v3.mjs >/dev/null
node test/golden.mjs >/dev/null
echo "✓ 测试通过"

if [ "${1:-}" != "--no-obf" ]; then
  node obf/pre.js
  node obf/obf_mid.js
  SRC=_worker_v3.mid.js
else
  SRC=dist/_worker.js
fi

# 注意：filename=_worker.js 不能省，Cloudflare 用 multipart 的文件名当模块名
curl -sS --max-time 180 -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F "metadata=@$META;type=application/json" \
  -F "_worker.js=@$SRC;type=application/javascript+module;filename=_worker.js" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('✓ 已部署' if d.get('success') else d.get('errors'))"
