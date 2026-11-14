/**
 * §29 的适用边界（§29.1）：94.7% 在什么条件下成立、条件变了掉到多少
 *
 * §29 报的 94.7% 是**一组特定输入**下的数（3 条 v4 / 其中 1 条被站点拒 / `ps` 两侧可学）。
 * 这个原型扫三个维度，给出「承诺生效的边界」：
 *   ① 池子里有几条 v4（1..4 / 8）
 *   ② v4 里有几条「族对但站点拒」（0 / 1 / 全部）
 *   ③ `ps` 有没有负样本学习（关 = §38 的 P1，开 = §38 的 P2）
 *
 * 纯本地、零网络。运行：node tools/exp-envelope.mjs
 */

const RELAYS = 8;
const ISOLES = 300;
const CONNS = 3;
const EXPLORE = 0.08;

/**
 * 跑一个格子的 v8（eg 偏置 + 共享 ps + B 级负样本开关）。
 *
 * @param {number} v4N 池子里 v4 出口数量
 * @param {number} rejN v4 里「族对但站点拒」的数量
 * @param {boolean} learnNeg `ps` 是否学习负样本（§38 P1/P2）
 * @returns {{ ok: number, total: number }} 整页次数与总请求数
 */
function cell(v4N, rejN, learnNeg) {
  /** @type {{fam:number,p:number,q:number,n:number}[]} */
  const rel = [];
  for (let i = 0; i < RELAYS; i++) {
    const isV4 = i < v4N;
    const rejected = isV4 && i < rejN;
    rel.push({
      fam: isV4 ? 4 : 6,
      p: isV4 ? (rejected ? 0 : 1) : 0.125,
      q: 255 * 0.5,
      n: 8,
    });
  }
  for (const r of rel) r.q = 255 * (r.fam === 4 ? 0.95 : 0.5);

  /** EWMA：正负同阶（§38.3） */
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
      const pick = Math.random() < EXPLORE ? rel[Math.floor(Math.random() * RELAYS)] : scored[0].r;
      const win = Math.random() < pick.p;
      if (win) {
        ok++;
        learn(pick, true);
      } else if (learnNeg) {
        // B 级证据：tiny + 同窗口有整页对照（本模型里每条 isolate 的首条视为有对照）
        learn(pick, false);
      }
    }
  }
  return { ok, total };
}

console.log("v4 条数  被拒条数   ps 学负样本   整页率");
const table = [];
for (const v4N of [1, 2, 3, 4]) {
  for (const rejN of [0, 1, v4N]) {
    if (rejN > v4N) continue;
    for (const learnNeg of [false, true]) {
      const r = cell(v4N, rejN, learnNeg);
      const ratio = r.ok / r.total;
      table.push({ v4N, rejN, learnNeg, ratio });
      console.log(
        `${String(v4N).padStart(6)}  ${String(rejN).padStart(8)}  ${(learnNeg ? "开" : "关").padStart(10)}   ` +
          `${(100 * ratio).toFixed(1).padStart(6)}%`
      );
    }
  }
}

const find = (v4N, rejN, learnNeg) => table.find((x) => x.v4N === v4N && x.rejN === rejN && x.learnNeg === learnNeg).ratio;

const t = [];
const okA = (name, cond, detail) => {
  t.push({ name, cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

okA("§29 的基准格子（3 v4 / 1 被拒 / 学负样本）在 85% 以上", find(3, 1, true) > 0.85, `${(100 * find(3, 1, true)).toFixed(1)}%`);
okA("全部被拒时，学负样本也救不回来（<40%）", find(3, 3, true) < 0.4, `${(100 * find(3, 3, true)).toFixed(1)}%`);
okA("不学负样本 + 全部被拒 → 近乎归零", find(3, 3, false) < 0.15, `${(100 * find(3, 3, false)).toFixed(1)}%`);
okA("v4 越多，学负样本后的上限越高（4 条 > 1 条）", find(4, 1, true) > find(1, 1, true), `${(100 * find(1, 1, true)).toFixed(1)}% → ${(100 * find(4, 1, true)).toFixed(1)}%`);

const bad = t.filter((x) => !x.cond);
console.log(`\n断言：${t.length - bad.length}/${t.length} 通过`);
process.exit(bad.length ? 1 : 0);
