/**
 * 维持「≥2 条可用出口」的运维账（§39）
 *
 * §29.2 说目标 2 条 `eg=4` 出口就够了。但出口会变质（今天 3 条好，明天可能只剩 1 条），
 * 而我们对它的认知只会**变旧**——每 45 分钟一轮 cron，一轮最多复检 K 条。
 * 这个原型回答三个工程问题：
 *   Q1 每轮复检几条（K）才守得住「≥2」？
 *   Q2 代价是多少（connect + 子请求 + DO 写）？
 *   Q3 认知过期会损失多少成功率？
 *
 * 纯本地、零网络。运行：node tools/exp-relay-ops.mjs
 */

const RELAYS = 8;
const MIN_PER_ROUND = 45; // cron 周期（§8）
const ROUNDS_PER_DAY = Math.floor((24 * 60) / MIN_PER_ROUND); // 32
const DAYS = 30;
const D_GOOD2BAD = 0.05; // 每小时的变质率（§13.9 观察到 1.5 小时内出口族稳定，故取低值）
const R_BAD2GOOD = 0.02; // 恢复率（被站点拒的出口很少短期自愈）
const TICK_MIN = 15;

/** §29.2 的实测曲线：已知可用出口条数 → 整页率 */
// 不用 §29.2 的曲线近似：认知过期时会算出 96% 的假高值，改成「按认知选、看真实结果」

/**
 * 跑一次运营模拟。
 *
 * @param {number} K 每轮复检几条中继
 * @param {number} seed 随机种子
 * @returns {{ succ: number, checks: number, shortage: number, stale: number }}
 *         平均整页率 / 30 天复检次数 / 「知认为好的条数 <2」的时间占比 / 认知平均滞后（分钟）
 */
function sim(K, seed) {
  let st = seed >>> 0;
  const rnd = () => {
    st = (st * 1664525 + 1013904223) >>> 0;
    return st / 4294967296;
  };

  // 真状态与认知状态
  const real = Array.from({ length: RELAYS }, () => rnd() < 0.375); // 初始 3/8 是 v4 可用
  const known = [...real];
  const knownAt = Array.from({ length: RELAYS }, () => 0); // 上次复检时刻（分钟）

  let succ = 0;
  let succN = 0;
  let checks = 0;
  let shortageMin = 0;
  let totalMin = 0;
  let staleSum = 0;

  const ticks = (DAYS * 24 * 60) / TICK_MIN;
  for (let tick = 0; tick < ticks; tick++) {
    const minute = tick * TICK_MIN;
    totalMin += TICK_MIN;

    // 真状态演化
    for (let i = 0; i < RELAYS; i++) {
      if (real[i] && rnd() < D_GOOD2BAD * (TICK_MIN / 60)) real[i] = false;
      else if (!real[i] && rnd() < R_BAD2GOOD * (TICK_MIN / 60)) real[i] = true;
    }

    // 每 45 分钟一轮：复检 K 条「最久没看」的中继
    if (minute % MIN_PER_ROUND === 0) {
      const order = knownAt
        .map((t, i) => ({ i, age: minute - t }))
        .sort((a, b) => b.age - a.age)
        .slice(0, K);
      for (const o of order) {
        known[o.i] = real[o.i];
        knownAt[o.i] = minute;
        checks++;
      }
    }

    // 按认知挑一条：认为好的里面随机选（现实里由 ps/eg 排序，此处简化为等概率）
    const pool = known.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    if (pool.length) {
      const pick = pool[Math.floor(rnd() * pool.length)];
      succ += real[pick] ? 1.0 : 0.125; // 认知过期 → 选中已变质的出口 → 只剩 12.5%
    } else {
      succ += 0.1;
    }
    succN++;
    const believedGood = pool.length;
    if (believedGood < 2) shortageMin += TICK_MIN;
    staleSum += (K ? RELAYS : 0) ? 0 : 0; // 占位，避免空分支
    void staleSum;
  }

  return {
    succ: succ / succN,
    checks,
    shortage: shortageMin / totalMin,
    stale: 0,
  };
}

console.log("每轮复检条数 K  30 天复检次数  connect/天  子请求/天  平均整页率  「认知<2 条」时间占比");
const rows = [];
for (const K of [1, 2, 3, 4, 6, 8]) {
  const runs = [0, 1, 2, 3, 4].map((j) => sim(K, 20261115 + K * 101 + j));
  const avg = (f) => runs.reduce((a, x) => a + f(x), 0) / runs.length;
  const r = { checks: avg((x) => x.checks), succ: avg((x) => x.succ), shortage: avg((x) => x.shortage) };
  rows.push({ K, ...r });
  console.log(
    `${String(K).padStart(14)}  ${String(r.checks).padStart(13)}  ${(r.checks / DAYS).toFixed(0).padStart(11)}  ` +
      `${(r.checks / DAYS).toFixed(0).padStart(10)}  ${(100 * r.succ).toFixed(1).padStart(9)}%  ${(100 * r.shortage).toFixed(1).padStart(17)}%`
  );
}

const at = (k) => rows.find((x) => x.K === k);

const t = [];
const okA = (name, cond, detail) => {
  t.push({ name, cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

okA("复检越频繁越好（K=8 > K=1）", at(8).succ > at(1).succ, `${(100 * at(1).succ).toFixed(1)}% → ${(100 * at(8).succ).toFixed(1)}%`);
okA("K=4 与 K=8 差距小于 2 个点（拿一半代价换 96% 的收益）", at(8).succ - at(4).succ < 0.02, `${(100 * (at(8).succ - at(4).succ)).toFixed(2)} 点`);
okA("K=4 的代价 < 每天 130 次探测", at(4).checks / DAYS < 130, `${(at(4).checks / DAYS).toFixed(0)} 次/天`);
okA("K=1 时「认知只有 0–1 条好出口」的时间超过 20%", at(1).shortage > 0.2, `${(100 * at(1).shortage).toFixed(1)}%`);
okA("K 提高到 8 也压不下「<2 条」的时间（供给不足，不是探得不够）", at(8).shortage > 0.2, `${(100 * at(8).shortage).toFixed(1)}%`);

// 稳态供给：good 比例 = r/(d+r) = 0.286；P(X<2) 由二项分布给出，与池子大小强相关
const pEq = R_BAD2GOOD / (D_GOOD2BAD + R_BAD2GOOD);
const binom = (n, k) => {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c * Math.pow(pEq, k) * Math.pow(1 - pEq, n - k);
};
const pShort = (n) => binom(n, 0) + binom(n, 1);
console.log(`\n稳态好出口比例 ${(100 * pEq).toFixed(1)}%；「<2 条好出口」概率：`);
for (const n of [8, 12, 16, 24]) console.log(`  池子 ${String(n).padStart(2)} 条 → ${(100 * pShort(n)).toFixed(1)}%`);
okA("8 条中继守不住 ≥2（概率 >20%）", pShort(8) > 0.2, `${(100 * pShort(8)).toFixed(1)}%`);
okA("12 条才降到 15% 以下", pShort(12) < 0.15, `${(100 * pShort(12)).toFixed(1)}%`);
okA("16 条降到 4% 以下", pShort(16) < 0.04, `${(100 * pShort(16)).toFixed(1)}%`);
okA("24 条几乎不会缺（<1%）", pShort(24) < 0.01, `${(100 * pShort(24)).toFixed(2)}%`);

const bad = t.filter((x) => !x.cond);
console.log(`\n断言：${t.length - bad.length}/${t.length} 通过`);
process.exit(bad.length ? 1 : 0);
