// 节点选择的"地面真值"仿真：批量伪造节点（真实延迟/失败率/带宽/卡顿），
// 用真实的 pick / region / bumpFail / nsProbe / nsSpeed 跑，最后和上帝视角对比。
//   用法：node test/mk_test.mjs && node tools/sim-select.mjs [小时数]
import * as W from "../test/_bundle.mjs";

const S = W.S;
const MB = 1048576;

/* ---------- 可控时钟 + 可复现随机 ---------- */
let NOW = Date.UTC(2026, 0, 1);
Date.now = () => NOW;
let seed = 20260101;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = rnd;

if (process.env.TRIAL_N) W.SC.TRIAL_N = Number(process.env.TRIAL_N);
if (process.env.BETA_A) W.SC.BETA_A = Number(process.env.BETA_A);
if (process.env.BETA_B) W.SC.BETA_B = Number(process.env.BETA_B);

const ENV = { pxDwellMin: 0, pxShadow: 0.05, pxSchedH: 6 };

/* ---------- 场景 ---------- */
// tcp/tls：真实握手；pFail：真实请求失败率；bw：真实带宽；stall：背压占比
// probeTcp：探活看到的延迟（可以和真实值不同，用来伪造"探活很快"的节点）
const N = (id, tcp, pFail, bw, o = {}) => ({
  id,
  key: id + ":443",
  tcp,
  tls: o.tls === undefined ? 40 : o.tls,
  pFail,
  bw,
  stall: o.stall || 0,
  probeTcp: o.probeTcp === undefined ? tcp : o.probeTcp,
  cc: o.cc || "",
});

function basePool() {
  const out = [
    N("n0", 60, 0.005, 12), // 真·最优
    N("n1", 120, 0.002, 20), // tput 最优
    N("n2", 30, 0.08, 8), // 诱饵：最低延迟、高失败
    N("n3", 90, 0.02, 6),
    N("n4", 150, 0.01, 10),
    N("n5", 200, 0.03, 5),
    N("n6", 250, 0.0, 4),
  ];
  for (let i = 7; i < 20; i++) {
    out.push(N("n" + i, 70 + ((i * 37) % 320), ((i * 13) % 5) * 0.01, 1 + ((i * 7) % 15)));
  }
  return out;
}

const scenarios = [
  { name: "静态异质", pool: basePool, mode: "lat" },
  { name: "静态异质", pool: basePool, mode: "tput" },
  {
    name: "中途上新",
    pool: basePool,
    mode: "lat",
    joinAt: 2 * 3600,
    joinNode: N("fresh", 35, 0.003, 15),
  },
  {
    name: "中途劣化",
    pool: basePool,
    mode: "lat",
    degradeAt: 2 * 3600,
    degradeKey: "n0:443",
    degradeP: 0.45,
  },
  {
    name: "同质池",
    mode: "lat",
    pool: () => {
      const out = [];
      for (let i = 0; i < 10; i++) out.push(N("h" + i, 95 + i * 2, 0.01 + i * 0.001, 4 + i * 0.2));
      return out;
    },
  },
  {
    name: "探活伪装",
    pool: () => [N("fake", 350, 0.0, 10, { probeTcp: 25 }), ...basePool().slice(0, 8)],
    mode: "lat",
  },
  {
    name: "地区池",
    pool: () => [
      N("d0", 55, 0.01, 9, { cc: "DE" }),
      N("d1", 70, 0.02, 8, { cc: "DE" }),
      N("d2", 210, 0.0, 6, { cc: "DE" }),
      N("u0", 40, 0.0, 20, { cc: "US" }),
      N("u1", 80, 0.01, 12, { cc: "US" }),
    ],
    mode: "lat",
    region: "DE",
  },
];

/* ---------- 状态 ---------- */
const byKey = new Map();
let pool = [];

function reset() {
  S.alive.clear();
  S.nstat.clear();
  S.hostNode.clear();
  S.hostDirect.clear();
  S.hostRankCache.clear();
  S.curs = { lat: "", tput: "" };
  S.prev = { lat: "", tput: "" };
  S.lastSwitch = { lat: 0, tput: 0 };
  S.switchHits = { lat: [], tput: [] };
  S.inflight.clear();
  S.rankCache = { t: 0, v: {} };
  S.candN = 0;
  S.pxFailMem = 0;
  S.pxFailSeen = 0;
  S.seedAt = NOW;
  byKey.clear();
}

function addNode(n) {
  S.alive.set(n.key, { h: n.id, p: 443, cc: n.cc, ms: n.probeTcp + n.tls });
  const s = W.nsGet(n.key);
  s.tcp = n.probeTcp;
  s.tls = n.tls;
  s.msLocal = n.probeTcp + n.tls;
  s.at = NOW;
  byKey.set(n.key, n);
}

/* ---------- 真实代价（上帝视角） ---------- */
function trueCost(n, mode) {
  const rtt = n.tcp + n.tls * 1.2;
  const bytes = mode === "tput" ? 10 * MB : 0.2 * MB;
  const work = (bytes / Math.max(1, n.bw * MB * (1 - n.stall))) * 1000;
  return (rtt + work) / (1 - n.pFail);
}

/* ---------- 一次真实请求 ---------- */
async function request(n, mode) {
  if (rnd() < n.pFail) {
    await W.SEL.bumpFail(ENV, mode, n.key, false);
    return false;
  }
  const bytes = mode === "tput" ? 10 * MB : 0.2 * MB;
  const dur = n.tcp + n.tls * 1.2 + (bytes / Math.max(1, n.bw * MB * (1 - n.stall))) * 1000;
  const bps = bytes / (dur / 1000);
  const w = Math.min(1, bytes / (512 * 1024)) * Math.min(1, dur / 1000);
  if (w > 0) W.nsSpeed(n.key, bps, bytes, ENV, Math.min(4, w));
  if (n.stall > 0) W.nsStall(n.key, n.stall * dur, dur);
  W.nsOk(n.key, 0, 0);
  return true;
}

/* ---------- 一轮 cron：探活 + 重算游标 ---------- */
function cron() {
  for (const n of pool) {
    if (rnd() < n.pFail * 0.4) W.nsProbeFail(n.key);
    else {
      const j = 0.9 + rnd() * 0.2;
      W.nsProbe(n.key, (n.probeTcp + n.tls) * j, n.probeTcp * j, n.tls * j);
    }
  }
  W.SEL.afterScan(ENV);
}

/* ---------- 跑一个场景 ---------- */
async function run(sc, hours) {
  reset();
  pool = sc.pool();
  for (const n of pool) addNode(n);
  const mode = sc.mode;
  let best = null;
  let oracle = Infinity;
  let reliable = Infinity;
  for (const n of pool) {
    const c = trueCost(n, mode);
    if (c < oracle) {
      oracle = c;
      best = n;
    }
    if (n.pFail <= 0.05) reliable = Math.min(reliable, c);
  }

  const ticks = hours * 3600;
  let reqs = 0, fails = 0, direct = 0, costSum = 0, ratioSum = 0, bad = 0, top1 = 0;
  let switches = 0, lastCurs = "";
  let firstBestAt = -1, joinSeenAt = -1, leaveBadAt = -1, fakeHits = 0;
  const hits = new Map();
  let badCursorTicks = 0;
  const tailFrom = Math.floor(ticks * 0.75);
  let tailN = 0, tailTop = 0, tailRatio = 0;

  for (let t = 0; t < ticks; t++) {
    NOW += 1000;
    if (t % 1800 === 0) cron();

    if (sc.joinAt && t === sc.joinAt) {
      pool.push(sc.joinNode);
      addNode(sc.joinNode);
      if (trueCost(sc.joinNode, mode) < oracle) {
        oracle = trueCost(sc.joinNode, mode);
        best = sc.joinNode;
      }
    }
    if (sc.degradeAt && t === sc.degradeAt) {
      const n = byKey.get(sc.degradeKey);
      n.pFail = sc.degradeP;
      oracle = Infinity;
      for (const x of pool) {
        const c = trueCost(x, mode);
        if (c < oracle) {
          oracle = c;
          best = x;
        }
      }
    }

    let key = "";
    if (sc.region) {
      const x = await W.SEL.region(ENV, sc.region, mode);
      key = x ? x.h + ":" + x.p : "";
    } else {
      key = W.SEL.pick(ENV, mode, { host: "" });
    }
    const cur = S.curs[mode];
    if (cur && cur !== lastCurs) {
      switches++;
      lastCurs = cur;
    }

    const n = byKey.get(key);
    if (!n) {
      direct++;
      continue;
    }
    reqs++;
    const ok = await request(n, mode);
    if (!ok) fails++;
    const c = trueCost(n, mode);
    const ratio = c / oracle;
    costSum += c;
    ratioSum += ratio;
    if (ratio > 1.5) bad++;
    if (n === best) {
      top1++;
      if (firstBestAt < 0) firstBestAt = t;
    }
    hits.set(n.key, (hits.get(n.key) || 0) + 1);
    if (n.id === "fake") fakeHits++;
    if (sc.joinAt && n === sc.joinNode && joinSeenAt < 0) joinSeenAt = t;
    if (sc.degradeAt && n.key === sc.degradeKey && t > sc.degradeAt) {
      badCursorTicks++;
      if (leaveBadAt < 0 && t > sc.degradeAt + 1) leaveBadAt = t;
    } else if (sc.degradeAt && n.key !== sc.degradeKey && leaveBadAt < 0 && t > sc.degradeAt) {
      leaveBadAt = t;
    }
    if (t >= tailFrom) {
      tailN++;
      tailRatio += ratio;
      if (n === best) tailTop++;
    }
  }

  return {
    name: sc.name,
    mode,
    reqs,
    failPct: (fails / Math.max(1, reqs)) * 100,
    meanRatio: ratioSum / Math.max(1, reqs),
    meanCost: costSum / Math.max(1, reqs),
    oracle,
    reliable,
    badPct: (bad / Math.max(1, reqs)) * 100,
    top1Pct: (top1 / Math.max(1, reqs)) * 100,
    tailTopPct: (tailTop / Math.max(1, tailN)) * 100,
    tailRatio: tailRatio / Math.max(1, tailN),
    swPerH: switches / hours,
    firstBest: firstBestAt < 0 ? "-" : fmt(firstBestAt),
    joinSeen: sc.joinAt ? (joinSeenAt < 0 ? "never" : fmt(joinSeenAt)) : "",
    leaveBad: sc.degradeAt ? (leaveBadAt < 0 ? "never" : fmt(leaveBadAt - sc.degradeAt)) : "",
    fakeShare: (fakeHits / Math.max(1, reqs)) * 100,
    direct,
    badCursorPct: sc.degradeAt ? (badCursorTicks / Math.max(1, ticks - sc.degradeAt)) * 100 : 0,
  };
}

const fmt = (s) => (s < 90 ? s + "s" : s < 5400 ? Math.round(s / 60) + "m" : (s / 3600).toFixed(1) + "h");
const p = (s, n) => String(s).padEnd(n);

const hours = Number(process.argv[2] || 4);
console.log(`仿真 ${hours} 小时 / 每 tick 1 秒 / 每 30 分钟一次 cron 探活\n`);
console.log(
  p("场景", 10) + p("模式", 6) + p("请求", 7) + p("失败%", 7) + p("代价倍率", 10) +
    p(">1.5x", 7) + p("命中真最优", 12) + p("末段命中", 10) + p("切/小时", 9) + "首次命中",
);

const rows = [];
const list = process.env.ONLY ? scenarios.filter((x) => x.name.includes(process.env.ONLY)) : scenarios;
for (const sc of list) {
  const r = await run(sc, hours);
  rows.push(r);
  console.log(
    p(r.name, 10) + p(r.mode, 6) + p(r.reqs, 7) + p(r.failPct.toFixed(1), 7) +
      p(r.meanRatio.toFixed(2) + "x", 10) + p(r.badPct.toFixed(1) + "%", 7) +
      p(r.top1Pct.toFixed(0) + "%", 12) + p(r.tailTopPct.toFixed(0) + "%", 10) +
      p(r.swPerH.toFixed(1), 9) + r.firstBest,
  );
}

console.log("\n细节：");
for (const r of rows) {
  const extra = [];
  if (r.joinSeen) extra.push(`新节点首次被选 ${r.joinSeen}`);
  if (r.leaveBad && r.leaveBad !== "never") extra.push(`劣化后 ${r.leaveBad} 才换走，坏节点仍占 ${r.badCursorPct.toFixed(0)}% 请求`);
  if (r.name === "探活伪装") extra.push(`探活 25ms / 真实 350ms 的节点吃掉 ${r.fakeShare.toFixed(0)}% 流量`);
  extra.push(`上帝视角 ${Math.round(r.oracle)}ms，可靠最优 ${Math.round(r.reliable)}ms，本算法 ${Math.round(r.meanCost)}ms`);
  console.log(`- ${r.name}/${r.mode}: ${extra.join("；")}`);
}
