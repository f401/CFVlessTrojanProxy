// 评分阶段 CPU 基准：按最大候选数压测
//   用法：node test/mk_test.mjs && node tools/bench-score.mjs [节点数]
import * as W from "../test/_bundle.mjs";

const N = Number(process.argv[2] || 200);
const S = W.S;
S.alive.clear(); S.nstat.clear();

for (let i = 0; i < N; i++) {
  const k = `n${i}:443`;
  S.alive.set(k, { h: `n${i}`, p: 443, cc: "", ms: 100 + (i % 50) });
  const s = W.STATS.nsGet(k);
  s.tcp = 50 + (i % 80); s.tls = 60; s.okW = 10 + (i % 20); s.failW = i % 3;
  s.hist[7] = 5; s.sumW = 5; s.sumW2 = 5; s.recentBytesW = 5 * 1048576; s.lastSampleAt = Date.now();
}

const bench = (name, fn, times = 200) => {
  for (let i = 0; i < 20; i++) fn(i);          // 预热
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < times; i++) fn(i);
  const t1 = process.hrtime.bigint();
  const per = Number(t1 - t0) / times;
  console.log(`${name.padEnd(22)} ${(per / 1e6).toFixed(2)} ms/次  ${(per / 1000).toFixed(1)} µs/次`);
  return per;
};

console.log(`节点数 ${N}`);
bench("candsFor(lat)", () => W.candsFor("lat"));
bench("candsFor(tput)", () => W.candsFor("tput"));
bench("pick(带站点偏好)", (i) => W.SEL.pick({ pxShadow: 0.05 }, "tput", { host: `site${i % 50}.test` }), 500);
bench("hostRank(tput)", () => W.HOSTS.rank("site1.test", "tput"), 500);
console.log(`候选数记录 S.candN = ${S.candN}`);
console.log(`单节点 costOf ≈ ${(bench("costOf x1", () => W.costOf("n0:443", "tput"), 2000) / 1000).toFixed(2)} µs`);
