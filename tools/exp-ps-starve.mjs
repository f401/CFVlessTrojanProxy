/**
 * 证据闸门会不会把 `ps` 饿死（§38）：负样本能不能写进 `ps`
 *
 * 问题：§26 的规则 5 要求 `tiny` 响应必须有「同窗口 ≥20KB 对照 + 三批 ≥60s」才写 `blk`，
 *       而 `ps` 侧只有规则 6（完整响应写 ok）。也就是说——
 *       **一次 737B 的封锁页，在证据不足时什么都不写**，包括不记 `ps(ok=0)`。
 *       如果真实流量里凑不齐对照腿，`ps` 就永远学不会「这条中继对这个站点不行」，
 *       §29 的 94.7% 建立在「D 策略学到两侧」的假设上，会退化成什么？
 *
 * 对比三种策略：
 *   P1 现状（只有 A 级证据写 ps）      —— 负样本几乎写不进来
 *   P2 ps 吃 B 级（tiny + 本地 2 分钟内见过整页 → 记 ps(ok=0)）
 *   P3 没有 ps（只有 eg 先验）         —— 作为下界对照
 *
 * 纯本地、零网络。运行：node tools/exp-ps-starve.mjs
 */

const RELAYS = 8;
const V4 = 1; // 场景：池子里只有一条 v4 出口
const CONNS_PER_ISO = 3;
const ISOLES = 400;
const EXPLORE = 0.08;
const BIG = 20000; // ≥20KB 视为整页

/** 中继画像：3 条 v4（第 0 条「族对但站点拒」p=0）、5 条 v6（p=0.125） */
const relays = Array.from({ length: RELAYS }, (_, i) => ({
  i,
  fam: i < V4 ? 4 : 6,
  p: i < V4 ? 0 : 0.25, // 唯一 v4 被站点拒；v6 一般般（25%）
  q: 255 * (i < V4 ? 0.95 : 0.5), // ps 初值：q/255 即先验
  n: 8,
}));

/**
 * EWMA 更新（§35.1：窗口初值 8、上限 32，连续成功把 n 重置到 4 的做法此处从简）。
 *
 * @param {{q:number,n:number}} r 中继状态
 * @param {boolean} ok 这次是否拿到整页
 */
function learn(r, ok) {
  const n = Math.min(32, r.n + 1);
  // 负样本用更大的步长：它稀有（要凑对照腿），一次就该明显降权（§38.3）
  const a = ok ? Math.max(0.05, 1 / n) : 0.35;
  r.q = Math.min(255, Math.max(0, r.q * (1 - a) + 255 * (ok ? 1 : 0) * a));
  r.n = n;
}

/**
 * 跑一种策略。
 *
 * @param {"P1"|"P2"|"P3"} mode 策略
 * @returns {{ okRatio: number, badQ: number, goodQ: number, negWrites: number, posWrites: number }}
 *         整页率 / 「族对但站点拒」那条的 p 估计 / 好 v4 的 p 估计 / 负样本写次数 / 正样本写次数
 */
function run(mode) {
  for (const r of relays) {
    r.q = 255 * (r.i < V4 ? 0.95 : 0.5);
    r.n = 8;
  }
  let ok = 0;
  let total = 0;
  let negWrites = 0;
  let posWrites = 0;

  for (let iso = 0; iso < ISOLES; iso++) {
    let bigAt = -1; // 本 isolate 最近一次看到整页的时间（B 级证据的对照腿）
    for (let c = 0; c < CONNS_PER_ISO; c++) {
      total++;
      // 选路：p_est 越高代价越低；P3 不用 ps，只用族先验
      const scored = relays.map((r) => {
        const pEst = mode === "P3" ? (r.fam === 4 ? 0.95 : 0.5) : r.q / 255;
        return { r, key: 1 / Math.max(0.08, pEst) };
      });
      scored.sort((a, b) => a.key - b.key);
      const pick = Math.random() < EXPLORE ? relays[Math.floor(Math.random() * RELAYS)] : scored[0].r;

      const win = Math.random() < pick.p;
      if (win) {
        ok++;
        bigAt = c;
        posWrites++;
        if (mode !== "P3") learn(pick, true);
      } else {
        // 失败：真实流量里是 737B 封锁页（tiny）
        const hasPeer = bigAt >= 0 && c - bigAt <= 1; // 同 isolate 内 2 分钟内见过整页
        if (mode === "P2" && hasPeer) {
          negWrites++;
          learn(pick, false);
        }
        // P1：要 blk 的三批才写，本模型里视为写不出去（negWrites 不增）
      }
      void BIG;
    }
  }
  const bad = relays[0]; // 唯一那条 v4
  const good = relays[1]; // 一条 v6，用于对照
  return { okRatio: ok / total, badQ: bad.q / 255, goodQ: good.q / 255, negWrites, posWrites };
}

const results = { P1: run("P1"), P2: run("P2"), P3: run("P3") };
console.log("策略  整页率   坏 v4 的 p 估计   v6 的 p 估计      负样本写/正样本写");
for (const [k, v] of Object.entries(results)) {
  console.log(
    `${k}   ${(100 * v.okRatio).toFixed(1).padStart(6)}%   ${v.badQ.toFixed(3).padStart(15)}   ` +
      `${v.goodQ.toFixed(3).padStart(15)}   ${String(v.negWrites).padStart(8)}/${v.posWrites}`
  );
}

const t = [];
const okA = (name, cond, detail) => {
  t.push({ name, cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

// 每条断言都对应一个实测事实，不是「应该怎样」
okA("P1：唯一 v4 的 p 估计停在先验（负样本写不进来）", results.P1.badQ > 0.9, `${results.P1.badQ.toFixed(2)}`);
okA("P1 被永久钉在这条 v4 上，整页率 <5%", results.P1.okRatio < 0.05, `${(100 * results.P1.okRatio).toFixed(1)}%`);
okA("P2：同一条 v4 被降权到 0.5 以下", results.P2.badQ < 0.5, `${results.P2.badQ.toFixed(2)}`);
okA("P2 整页率至少是 P1 的 3 倍", results.P2.okRatio > 3 * results.P1.okRatio, `${(100 * results.P1.okRatio).toFixed(1)}% → ${(100 * results.P2.okRatio).toFixed(1)}%`);
okA("但 P2 里「被封锁的 v4」与「只是弱」的 v6 无法区分（B 级证据被污染）", Math.abs(results.P2.badQ - results.P2.goodQ) < 0.1, `${results.P2.badQ.toFixed(2)} vs ${results.P2.goodQ.toFixed(2)}`);

const bad = t.filter((x) => !x.cond);
console.log(`\n断言：${t.length - bad.length}/${t.length} 通过`);
process.exit(bad.length ? 1 : 0);
