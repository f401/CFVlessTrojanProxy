// 端到端验收：同一批请求同时给出「成功率」与「延迟分布」
// node tools/exp-e2e.mjs
//
// 为什么需要这个：§29 只算成功率、§32 只算延迟，两者是独立模型。
// 真实用户体感是「同一条请求既要成功又要不太慢」，必须放进同一个时间轴。
//
// 模型要素（全部来自实测口径）：
//   - 8 条中继：3 条 v4 出口（x 类站点 p=1.00）、1 条「族对但站点拒」、4 条 v6 出口（p=0.125）
//   - 每次请求的基线 TTFB 2500ms（7.86 实测 p50 2.5–3.3s）；被封锁页只花 60ms（4xx 很快）
//   - connect 名额 6 个、每次 250ms；冷 isolate 里未知出口需要探测
//   - 20% 请求落在冷 isolate；冷 isolate 70% 能从 colo 缓存拿到 facts（§30）
//   - v8 的 ps 是**跨 isolate 共享**的 EWMA 成功率（§22），基线版本没有

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

const CFG = {
  waves: 700, // 700 波 × 3 条 = 2100 条请求
  perWave: 3,
  coldRatio: 0.2,
  cacheHitCold: 0.7,
  baseMs: 2500,
  blockedMs: 60,
  connectMs: 250,
  slots: 6,
  probeWave: 2,
  psDecay: 0.98,
  explore: 0.08, // 8% 请求走探索（§29 的天花板分解里就有这一项）
  jitter: 600, // 基线 TTFB 抖动 ±600ms（实测 p50 2.5s / p95 3.3s）
};

function members() {
  const list = [];
  for (let i = 0; i < 3; i++) list.push({ id: `v4-${i}`, fam: 4, p: 1.0 });
  list.push({ id: "v4-reject", fam: 4, p: 0.125 });
  for (let i = 0; i < 4; i++) list.push({ id: `v6-${i}`, fam: 6, p: 0.125 });
  return list;
}

// 共享的 ps 表（v8 用；基线版本不读）
const ps = new Map(); // id -> {q, n}
const psOf = (id) => ps.get(id) || { q: 0.5, n: 0 };
function psNote(id, ok) {
  const s = psOf(id);
  s.n = Math.min(255, s.n * CFG.psDecay + 1);
  s.q = (s.q * (s.n - 1 + CFG.psDecay) + (ok ? 255 : 0)) / (s.n + CFG.psDecay - 1 + 1);
  if (!Number.isFinite(s.q)) s.q = ok ? 1 : 0;
  ps.set(id, s);
}

// eg 事实（客观、共享）：这里的 8 条中继出口族已知
const eg = new Map(members().map((m) => [m.id, m.fam]));

function run(mode, seed) {
  const r = rng(seed);
  const list = members();
  const slotFree = new Array(CFG.slots).fill(0);
  const takeSlot = (t) => {
    let i = 0;
    for (let j = 1; j < slotFree.length; j++) if (slotFree[j] < slotFree[i]) i = j;
    const st = Math.max(t, slotFree[i]);
    slotFree[i] = st + CFG.connectMs;
    return st + CFG.connectMs;
  };

  const lat = [];
  let okN = 0;
  let good = 0;
  const okLat = [];
  let t = 0;

  for (let w = 0; w < CFG.waves; w++) {
    t += 1000; // 每波间隔 1s，保证队列会累积但不会无限排队
    const cold = r() < CFG.coldRatio;
    const hasFacts = !cold || r() < CFG.cacheHitCold;

    // 这一波里需要探测的连接数（只有冷 isolate 且没有 facts 时才探测）
    let probes = 0;
    for (let i = 0; i < CFG.perWave; i++) {
      let now = t;
      const unknown = cold && !hasFacts;
      if (unknown && probes < CFG.probeWave) {
        probes++;
        now = takeSlot(now); // 探测排队
      } else {
        now = takeSlot(now); // 拨号本身也占名额
      }

      // 选出口
      let cands;
      if (mode === "v8" && (hasFacts || eg.size)) {
        // 族偏置 + 共享 ps 折价
        const score = (m) => {
          const prior = eg.get(m.id) === 4 ? 0.95 : 0.5;
          const p = (psOf(m.id).q / 255) * 0.6 + prior * 0.4;
          return p;
        };
        cands = [...list].sort((a, b) => score(b) - score(a));
        // 前 3 名里随机（保留探索；§21：不能确定性选）
        cands = cands.slice(0, 3);
      } else if (mode === "eg" && eg.size) {
        cands = list.filter((m) => eg.get(m.id) === 4);
        if (!cands.length) cands = list;
      } else {
        cands = list;
      }
      const explore = r() < CFG.explore;
      const m = explore ? list[Math.floor(r() * list.length)] : cands[Math.floor(r() * cands.length)];
      const pass = r() < m.p;
      if (mode === "v8") psNote(m.id, pass);

      const jit = Math.round((r() * 2 - 1) * CFG.jitter);
      const total = now - t + (pass ? CFG.baseMs + jit : CFG.blockedMs);
      lat.push(total);
      if (pass) {
        okN++;
        okLat.push(total);
        if (total <= 3000) good++;
      }
    }
  }

  lat.sort((a, b) => a - b);
  const q = (x) => lat[Math.min(lat.length - 1, Math.floor(x * lat.length))];
  okLat.sort((a, b) => a - b);
  const qo = (x) => (okLat.length ? okLat[Math.min(okLat.length - 1, Math.floor(x * okLat.length))] : 0);
  return {
    rate: okN / lat.length,
    p50: q(0.5),
    p95: q(0.95),
    p95ok: qo(0.95),
    max: lat[lat.length - 1],
    within: good / lat.length,
  };
}

const seeds = [11, 22, 33, 44, 55, 66, 77, 88];
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const modes = ["base", "eg", "v8"];

console.log(`配置：${CFG.waves} 波 × ${CFG.perWave} 条 / 冷 ${CFG.coldRatio * 100}% / 基线 ${CFG.baseMs}ms / 探测每波 ≤${CFG.probeWave} / connect ${CFG.connectMs}ms×${CFG.slots}\n`);
console.log("策略    成功率    p50      p95   成功p95   成功且≤3s");
const res = {};
for (const mode of modes) {
  // 每个种子重置 ps，避免上一轮的学习结果泄漏到下一轮
  ps.clear();
  const runs = seeds.map((s) => { ps.clear(); return run(mode, s); });
  res[mode] = {
    rate: med(runs.map((x) => x.rate)),
    p50: med(runs.map((x) => x.p50)),
    p95: med(runs.map((x) => x.p95)),
    p95ok: med(runs.map((x) => x.p95ok)),
    max: med(runs.map((x) => x.max)),
    within: med(runs.map((x) => x.within)),
  };
  const v = res[mode];
  console.log(
    `${mode.padEnd(7)} ${(v.rate * 100).toFixed(1).padStart(6)}%  ${String(v.p50).padStart(6)}  ${String(v.p95).padStart(6)}   ${String(v.p95ok).padStart(6)}   ${(v.within * 100).toFixed(1)}%`,
  );
}

const bad = [];
if (!(res.base.rate < 0.6)) bad.push("基线应接近盲选（<60%）");
if (!(res.v8.rate > res.base.rate + 0.3)) bad.push("v8 应比基线高 30 个点以上");
if (!(res.v8.p95ok <= res.base.p95ok + 60)) bad.push(`v8 的「成功请求 p95」不应明显劣于基线（${res.v8.p95ok} vs ${res.base.p95ok} ms）`);
if (!(res.v8.within > res.base.within + 0.3)) bad.push(`v8 的「成功且 ≤3s」应比基线高 30 个点以上（实际 ${(res.v8.within * 100).toFixed(1)}% vs ${(res.base.within * 100).toFixed(1)}%）`);
if (bad.length) {
  console.log("\nFAIL:");
  for (const b of bad) console.log("  -", b);
  process.exit(1);
}
console.log("\n断言通过");
