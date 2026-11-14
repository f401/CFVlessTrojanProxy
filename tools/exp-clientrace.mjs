// 客户端竞速组能不能修好「出口族」问题？node tools/exp-clientrace.mjs
// 三种健康检查 × 三种规模 × 是否要求「连测通过」：
//   1. health — url: https://<host>/health（默认）：只测「中继能不能到 CF」，看不到出口族
//   2. target — url: https://<site>/（?tu=）：真站点，403 判不健康（唯一端到端证据）
//   3. none   — 没有竞速组，按顺序挑
// 关键机制：坏中继（v6 出口 / 族对但站点拒）单次测试有 p=0.125 的概率「蒙对」而被判健康，
// 所以「连测 N 次都通过才算健康」能把蒙对概率从 0.125 压到 0.125^N。

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
  goodRatio: 0.375, // 3/8 条 v4 出口（§13.6）
  pBad: 0.125, // v6 出口或族对但站点拒（§13.8 / §13.6）
  flipPerCycle: 0.02, // D11：状态会变
  testEveryMs: 180_000,
  requestEveryMs: 120_000,
  hours: 6,
};

function world(seed, members) {
  const r = rng(seed);
  return {
    r,
    members: Array.from({ length: members }, (_, i) => ({ id: i, good: r() < CFG.goodRatio, streak: 0, healthy: true })),
  };
}

const pOf = (m) => (m.good ? 1.0 : CFG.pBad);

function run(mode, members, confirm, seed) {
  const { r, list } = (() => {
    const w = world(seed, members);
    return { r: w.r, list: w.members };
  })();
  let ok = 0;
  let n = 0;
  const total = (CFG.hours * 3600_000) / CFG.requestEveryMs;
  const tests = Math.floor((CFG.hours * 3600_000) / CFG.testEveryMs);
  const perTest = Math.max(1, Math.round(total / tests)); // 两次测试之间发生多少次用户请求

  for (let c = 0; c < tests; c++) {
    // 1) 健康检查
    if (mode !== "none") {
      for (const m of list) {
        if (r() < CFG.flipPerCycle) m.good = !m.good;
        const pass = mode === "health" ? true : r() < pOf(m);
        if (pass) m.streak++;
        else m.streak = 0;
        m.healthy = m.streak >= confirm;
      }
    } else {
      for (const m of list) if (r() < CFG.flipPerCycle) m.good = !m.good;
    }
    // 2) 用户请求（url-test 在健康集合里挑；none 模式全量挑）
    for (let i = 0; i < perTest; i++) {
      const pool = mode === "none" ? list : list.filter((m) => m.healthy);
      const from = pool.length ? pool : list;
      const m = from[Math.floor(r() * from.length)];
      n++;
      if (r() < pOf(m)) ok++;
    }
  }
  return ok / n;
}

const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";

function avg(mode, members, confirm) {
  const rs = seeds.map((s) => run(mode, members, confirm, s * 7919));
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  return { mean, min: Math.min(...rs) };
}

console.log(`配置：好中继 ${(CFG.goodRatio * 100).toFixed(1)}% / 坏中继 p=${CFG.pBad} / 测试 ${CFG.testEveryMs / 60000}min / 请求 ${CFG.requestEveryMs / 60000}min / 翻转 ${CFG.flipPerCycle} / ${CFG.hours}h × ${seeds.length} 种子\n`);
console.log("组类型   成员数  连测通过  平均成功率  最差种子");
const rows = [];
for (const mode of ["none", "health", "target"]) {
  for (const members of [4, 6, 10]) {
    for (const confirm of mode === "target" ? [1, 2, 3] : [1]) {
      const { mean, min } = avg(mode, members, confirm);
      rows.push({ mode, members, confirm, mean, min });
      console.log(`${mode.padEnd(8)} ${String(members).padStart(3)}      ${String(confirm).padStart(2)}     ${pct(mean)}      ${pct(min)}`);
    }
  }
}

const pick = (mode, members, confirm) => rows.find((r) => r.mode === mode && r.members === members && r.confirm === confirm).mean;
const bad = [];
if (!(pick("none", 6, 1) < 0.6)) bad.push("没有竞速组时应接近盲选（<60%）");
if (!(pick("health", 10, 1) < pick("target", 10, 2) - 0.3)) bad.push("health 组应远弱于 target 组（它看不到出口族）");
if (!(pick("target", 10, 2) > 0.95)) bad.push(`target + 连测2 + 10 成员应 >95%，实际 ${pct(pick("target", 10, 2))}`);
if (!(pick("target", 6, 2) > pick("target", 6, 1))) bad.push("连测通过应当优于单次测试");
if (!(pick("target", 10, 2) > pick("target", 6, 2))) bad.push("成员越多应当越好（更多好中继留在池里）");
if (bad.length) { console.log("\nFAIL:"); for (const b of bad) console.log("  -", b); process.exit(1); }
console.log("\n断言通过");
