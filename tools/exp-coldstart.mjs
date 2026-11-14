// 冷启动专项：facts 的 colo 缓存命中率随「本 colo 请求速率」变化时，v8 的首连命中怎么走。
// node tools/exp-coldstart.mjs
// 说明：命中率不是我们能「设定」的参数，它是 λ（请求/分钟/colo）与 TTL 的函数：
//   命中率 ≈ 1 - exp(-λ · TTL/60)
// 这条式子假设：缓存只被真实请求填充（没有预热），且 TTL 内至少有一次请求就能命中。

import { simulate } from "./exp-v8sim.mjs";

const LAMBDAS = [0.2, 0.5, 1, 2, 5, 10, 20]; // 每 colo 每分钟的用户请求数
const TTLS = [30, 60, 120];

const hitOf = (lambda, ttlSec) => 1 - Math.exp((-lambda * ttlSec) / 60);

const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";
console.log("λ(请求/分)  TTL  缓存命中   v8首连(200ms)  v8首连(0ms)   v8冷启动(200ms)");
const rows = [];
for (const ttl of TTLS) {
  for (const lambda of LAMBDAS) {
    const hit = hitOf(lambda, ttl);
    const withBlock = simulate("v8", { coldHit: hit, blockMs: 200 });
    const noBlock = simulate("v8", { coldHit: hit, blockMs: 0 });
    rows.push({ lambda, ttl, hit, a: withBlock.sites["x-like"].page, b: noBlock.sites["x-like"].page, cold: withBlock.sites["x-like"].coldPage });
    console.log(
      `${String(lambda).padStart(6)}     ${String(ttl).padStart(3)}s  ${pct(hit)}     ${pct(withBlock.sites["x-like"].page)}         ` +
        `${pct(noBlock.sites["x-like"].page)}        ${pct(withBlock.sites["x-like"].coldPage)}`
    );
  }
}

// 断言：三条与设计相关的结论
const at = (lambda, ttl) => rows.find((r) => r.lambda === lambda && r.ttl === ttl);
const bad = [];
const low = at(0.2, 60);
const high = at(20, 60);
if (!(low.hit < 0.2)) bad.push(`低流量下命中率应 <20%，实际 ${pct(low.hit)}`);
if (!(high.hit > 0.95)) bad.push(`高流量下命中率应 >95%，实际 ${pct(high.hit)}`);
if (!(at(1, 60).b < at(1, 60).a)) bad.push("200ms 预算在低流量下应当带来收益");
if (!(at(20, 60).b > at(20, 60).a - 0.02)) bad.push("高流量下 200ms 预算不应有代价");
if (!(at(1, 120).a > at(1, 30).a)) bad.push("更长 TTL 在低流量下应更好");
if (bad.length) { console.log("\nFAIL:"); for (const b of bad) console.log("  -", b); process.exit(1); }
console.log("\n断言通过");
