// 一条命令跑完全部门禁，默认**不部署**。
//   node tools/preflight.mjs            # 类型/架构/包/四段测试/golden/混淆/关键字 + v8 链路验收 + 本地路由模拟
//   node tools/preflight.mjs --deploy   # 全绿后再真部署（等价手动跑 .tmp-sim/deploy-746.mjs）
//   node tools/preflight.mjs --fast     # 跳过 golden 与 sim_v3（改文案/注释时用）
import { spawnSync } from "node:child_process";

const NODE = process.execPath;
const args = new Set(process.argv.slice(2));
const fast = args.has("--fast");
const deploy = args.has("--deploy");

const steps = [
  ["类型检查", ["tools/tsc.js"]],
  ["架构门禁", ["tools/check-arch.js"]],
  ["注释门禁", ["tools/doc-audit.mjs", "--max", "0", "--top", "5"]],
  ["打包", ["tools/bundle.js"]],
  ["测试包", ["test/mk_test.mjs"]],
  ["协议单测", ["test/test_v3.mjs"]],
  ["冒烟", ["test/smoke_v3.mjs"]],
  ["评分单测", ["test/test_score.mjs"]],
  ...(fast ? [] : [["场景仿真", ["test/sim_v3.mjs"]], ["golden", ["test/golden.mjs"]]]),
  ["混淆-预处理", ["obf/pre.js"]],
  ["混淆-主体", ["obf/obf_mid.js"]],
  ["混淆自检", ["tools/check-obf.js", "_worker_v3.mid.js"]],
  ["接线扫描", ["tools/check-wire.mjs"]],
  ["v8 链路验收", ["tools/exp-v8chain.mjs"]],
  ["v8 闭环证明", ["tools/exp-v8proof.mjs"]],
  ["本地路由模拟", ["tools/simrun.mjs"]],
];

const t0 = Date.now();
const failed = [];
for (const [name, argv] of steps) {
  const t = Date.now();
  const r = spawnSync(NODE, argv, { stdio: "inherit", cwd: process.cwd() });
  const ms = Date.now() - t;
  if (r.status !== 0) {
    failed.push(name);
    console.log(`\n✗ ${name} 失败（${ms} ms，退出码 ${r.status}）—— 后续步骤跳过`);
    break;
  }
  console.log(`✓ ${name}（${ms} ms）`);
}

if (failed.length) {
  console.log(`\npreflight 失败：${failed.join(", ")}  总计 ${Date.now() - t0} ms`);
  process.exit(1);
}

console.log(`\npreflight 全绿（${Math.round((Date.now() - t0) / 1000)} s），未部署。`);
if (!deploy) {
  console.log("确认要上线时再执行：node tools/preflight.mjs --deploy  或  node .tmp-sim/deploy-746.mjs");
  process.exit(0);
}

const d = spawnSync(NODE, [".tmp-sim/deploy-746.mjs"], { stdio: "inherit" });
process.exit(d.status === 0 ? 0 : 1);
