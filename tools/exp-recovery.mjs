// 学错了能不能自己爬回来？—— ps 的恢复速度 与 blk 的假阳性代价
// node tools/exp-recovery.mjs
//
// 三个问题：
//   Q1 好中继偶发连续 k 次失败后，要几次成功才能重新进「前 3」？
//      关键变量是**计数上限 nCap**：§22.4 写的是 min(255, …)，那会让 EWMA 退化成累计平均。
//   Q2 在「1% 的请求会触发连续 3 次失败」的坏运气下，整体成功率损失多少？
//   Q3 blk 用「两个批次」还是「三个批次」：假阳性率差多少？

const PRIOR = 0.95; // v4 出口的族先验（§13.6）
const scoreOf = (q, n) => (q / 255) * 0.6 + PRIOR * 0.4;

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** 按 §22.4 的更新式模拟，带回「计数上限 nCap」这个参数 */
function mkState(nCap, startQ = 255, startN = 16) {
  let q = startQ;
  let n = startN;
  return {
    step(ok) {
      n = Math.min(nCap, n * 0.98 + 1);
      q = Math.round((q * (n - 1) + (ok ? 255 : 0)) / n);
    },
    get score() {
      return scoreOf(q, n);
    },
    get n() {
      return n;
    },
  };
}

function recover(k, nCap) {
  const s = mkState(nCap);
  for (let i = 0; i < k; i++) s.step(false);
  const seq = [s.score];
  for (let i = 0; i < 40; i++) {
    s.step(true);
    seq.push(s.score);
  }
  return seq;
}

// 同池另外 3 条中继的分数（都是 p=0.5 的普通通道，n 也降到 16 左右）
// 同池另外 3 条「差不多好」的中继（q≈0.92–0.96）——它们才是真正的竞争者
const others = [scoreOf(235, 64), scoreOf(240, 64), scoreOf(245, 64)];
const thirdPlace = Math.min(...others);

console.log("=== Q1 恢复速度（连续 k 次失败后，score 回到「前 3」需要几次成功）===\n");
console.log("nCap   k=2   k=3   k=5   k=8");
const caps = [255, 64, 32, 16];
const rec = {};
for (const cap of caps) {
  const cells = [];
  for (const k of [2, 3, 5, 8]) {
    const seq = recover(k, cap);
    const idx = seq.findIndex((x) => x >= thirdPlace);
    cells.push(idx < 0 ? ">40" : String(idx));
    rec[`${cap}:${k}`] = idx < 0 ? 99 : idx;
  }
  console.log(`${String(cap).padStart(4)}   ${cells.map((c) => c.padStart(3)).join("   ")}`);
}

// Q2 这一段的选择模型（4 条中继里挑前 3 再随机）与真实选路差得太远，
// 打印出来只作占位，**不要在任何结论里引用它的数字**（§35.4 已说明原因）。
console.log("\n=== Q2 坏运气下的整体损失（模型不可靠，勿引用）===\n");
console.log("nCap   成功率    被降权时间占比");
const demoted = {};
function loss(cap) {
  const r = rng(424242);
  const good = mkState(cap);
  const bads = [mkState(cap, 235, 64), mkState(cap, 240, 64), mkState(cap, 245, 64)];
  let ok = 0;
  let total = 0;
  let demoted = 0;
  for (let i = 0; i < 4000; i++) {
    const burst = r() < 0.01;
    if (burst) {
      for (let j = 0; j < 3; j++) good.step(false);
    } else {
      const passGood = r() < 0.95;
      good.step(passGood);
      for (const b of bads) b.step(r() < 0.5);

      // 选前 3：好中继被降权时就轮不到它（用 rivals 的实时第 3 名做门槛）
      const rivalSorted = [...bads].map((b) => b.score).sort((x, y) => y - x);
      const cut = Math.min(...rivalSorted);
      const inPool = good.score >= cut;
      const set = [good, ...bads].sort((a, b) => b.score - a.score).slice(0, 3);
      const picked = set[Math.floor(r() * set.length)];
      total++;
      const p = picked === good ? 0.95 : 0.5;
      if (r() < p) ok++;
      if (!inPool) demoted++;
    }
  }
  return { rate: ok / total, demoted: demoted / total };
}
for (const cap of caps) {
  const { rate, demoted: d } = loss(cap);
  demoted[cap] = d;
  console.log(`${String(cap).padStart(4)}   ${(rate * 100).toFixed(1)}%    ${(d * 100).toFixed(1)}%`);
}

console.log("\n=== Q3 blk 的假阳性：真实通过率 p 的好中继，被「连续 m 批失败」误封的概率 ===\n");
console.log("p       m=2      m=3      m=4");
const blk = {};
for (const p of [0.95, 0.9, 0.8, 0.5, 0.125]) {
  const cells = [2, 3, 4].map((m) => {
    const v = Math.pow(1 - p, m);
    blk[`${p}:${m}`] = v;
    return `${(v * 100).toFixed(2)}%`.padStart(8);
  });
  console.log(`${p.toFixed(3)} ${cells.join("  ")}`);
}

const bad = [];
if (!(rec["255:5"] >= 20)) bad.push("窗口 64 时，连续 5 次失败后恢复应 ≥20 次成功（恢复很慢，这是 D12 的证据）");
if (!(rec["16:5"] < rec["255:5"])) bad.push("窗口越小恢复越快（16 应优于 255）");
if (!(blk["0.95:2"] > blk["0.95:3"] * 2)) bad.push("两批规则的假阳性应显著高于三批");
if (!(blk["0.125:2"] < 0.8)) bad.push("对 p=0.125 的坏中继，两批规则应几乎必然命中");
if (bad.length) {
  console.log("\nFAIL:");
  for (const b of bad) console.log("  -", b);
  process.exit(1);
}
console.log("\n断言通过");
