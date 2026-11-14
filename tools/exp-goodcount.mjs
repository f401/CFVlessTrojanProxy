/**
 * 「几条好出口才够」（§29.2）：goodN × rejectedN 的整页率曲线
 *
 * §29.1 说前提是「至少一条好出口」，但工程上要问的是**具体几条**：
 * 1 条够不够？2 条呢？多出来的收益值不值得烧更多探测预算去维护？
 *
 * 模型：8 条中继 = goodN 条可用 v4（p=1.0）+ rejN 条「族对但站点拒」v4（p=0）
 *       + 其余 v6（p=0.125）；v8 选路（eg 偏置 + 共享 ps + B 级负样本学习）。
 *
 * 纯本地、零网络。运行：node tools/exp-goodcount.mjs
 */

const RELAYS = 8;
const ISOLES = 400;
const CONNS = 3;
const EXPLORE = 0.08;
const TRIALS = 5; // 每格跑 5 次取中位数，压掉随机波动

/**
 * 跑一格并返回整页率。
 *
 * @param {number} goodN 可用 v4 出口数量
 * @param {number} rejN 「族对但站点拒」的 v4 数量
 * @param {number} seed 随机种子（用简单 LCG 保证可复现）
 * @returns {number} 整页率 0..1
 */
function cell(goodN, rejN, seed) {
  let st = seed >>> 0;
  const rnd = () => {
    st = (st * 1664525 + 1013904223) >>> 0;
    return st / 4294967296;
  };

  /** @type {{fam:number,p:number,q:number,n:number}[]} */
  const rel = [];
  for (let i = 0; i < RELAYS; i++) {
    const isV4 = i < goodN + rejN;
    const rejected = isV4 && i >= goodN;
    rel.push({
      fam: isV4 ? 4 : 6,
      p: isV4 ? (rejected ? 0 : 1) : 0.125,
      q: 255 * (isV4 ? 0.95 : 0.5),
      n: 8,
    });
  }

  const learn = (r, ok) => {
    const n = Math.min(32, r.n + 1);
    const a = Math.max(0.05, 1 / n);
    r.q = Math.min(255, Math.max(0, r.q * (1 - a) + 255 * (ok ? 1 : 0) * a));
    r.n = n;
  };

  let ok = 0;
  let total = 0;
  for (let iso = 0; iso < ISOLES; iso++) {
    for (let c = 0; c < CONNS; c++) {
      total++;
      const scored = rel.map((r) => ({ r, key: 1 / Math.max(0.08, r.q / 255) }));
      scored.sort((a, b) => a.key - b.key);
      const pick = rnd() < EXPLORE ? rel[Math.floor(rnd() * RELAYS)] : scored[0].r;
      if (rnd() < pick.p) {
        ok++;
        learn(pick, true);
      } else {
        learn(pick, false); // B 级负样本（§38 P2）
      }
    }
  }
  return ok / total;
}

const med = (a) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
};

const table = new Map();
console.log("可用 v4 条数  被拒条数   整页率（5 次中位）");
for (const goodN of [0, 1, 2, 3, 4]) {
  for (const rejN of [0, 1, 2]) {
    if (goodN + rejN > RELAYS) continue;
    const runs = Array.from({ length: TRIALS }, (_, k) => cell(goodN, rejN, 12345 + k * 7919));
    const m = med(runs);
    table.set(`${goodN}/${rejN}`, m);
    console.log(`${String(goodN).padStart(11)}  ${String(rejN).padStart(8)}   ${(100 * m).toFixed(1).padStart(6)}%`);
  }
}

const at = (g, r) => table.get(`${g}/${r}`);

const t = [];
const okA = (name, cond, detail) => {
  t.push({ name, cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

okA("没有可用 v4 → 成功率不到 20%", at(0, 0) < 0.2, `${(100 * at(0, 0)).toFixed(1)}%`);
okA("1 条可用 v4 → 90% 以上", at(1, 0) > 0.9, `${(100 * at(1, 0)).toFixed(1)}%`);
// 断言按实测写（§35.4：断言是事实的固化，不是期望值）
okA("2 条可用 v4 比 1 条高（但只高不到 1 点）", at(2, 0) > at(1, 0) && at(2, 0) - at(1, 0) < 0.02, `${(100 * at(1, 0)).toFixed(1)}% → ${(100 * at(2, 0)).toFixed(1)}%`);
okA("2 条可用 v4 已经在 94% 以上", at(2, 0) > 0.94, `${(100 * at(2, 0)).toFixed(1)}%`);
okA("3 条以上收益递减（4 条 vs 3 条差 <2 点）", at(4, 0) - at(3, 0) < 0.02, `${(100 * (at(4, 0) - at(3, 0))).toFixed(1)} 点`);
okA("2 条好出口下，多 2 条被拒也不掉到 90% 以下", at(2, 2) > 0.9, `${(100 * at(2, 2)).toFixed(1)}%`);

const bad = t.filter((x) => !x.cond);
console.log(`\n断言：${t.length - bad.length}/${t.length} 通过`);
process.exit(bad.length ? 1 : 0);
