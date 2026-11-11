// 节点选择的"地面真值"仿真：批量伪造节点（真实延迟/失败率/带宽/卡顿/探活撒谎），
// 用真实的 pick / region / bumpFail / nsProbe / nsSpeed 跑，最后和上帝视角对比。
//   用法：node test/mk_test.mjs && node tools/sim-select.mjs [小时数]
//   环境变量：SEEDS=3（每个场景跑几个随机种子）、SEED0=1、ONLY=场景名、RATE=请求/秒
import * as W from "../test/_bundle.mjs";

const S = W.S;
const MB = 1048576;

/* ---------- 可控时钟 + 可复现随机 ---------- */
const T0 = Date.UTC(2026, 0, 1);
let NOW = T0;
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

if (process.env.FAIL) W.SC.FAIL = Number(process.env.FAIL);
if (process.env.H_LAT_REL) W.SC.H_LAT_REL = Number(process.env.H_LAT_REL);
if (process.env.TRIAL_LAT) W.SC.TRIAL_LAT = Number(process.env.TRIAL_LAT);
if (process.env.TRIAL_TPUT) W.SC.TRIAL_TPUT = Number(process.env.TRIAL_TPUT);
if (process.env.BETA_A) W.SC.BETA_A = Number(process.env.BETA_A);
if (process.env.BETA_B) W.SC.BETA_B = Number(process.env.BETA_B);

const ENV = { pxDwellMin: 0, pxShadow: 0.05, pxSchedH: 6 };

/* ---------- 节点 ---------- */
// tcp/tls：真实握手；pFail：真实失败率；bw：真实带宽(MB/s)；stall：背压占比
// probeTcp：探活看到的延迟（可单独伪造，用来造"探活很快、实际很慢"的节点）
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
  burst: false,
  burstOnly: o.burstOnly || false,
});

function basePool() {
  const out = [
    N("n0", 60, 0.005, 12), // 真·可靠最优
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

function bigPool() {
  const out = [N("b0", 60, 0.005, 14)];
  for (let i = 1; i < 100; i++) {
    out.push(N("b" + i, 100 + ((i * 53) % 300), 0.02 + ((i * 29) % 4) * 0.01, 1 + ((i * 17) % 20)));
  }
  return out;
}

function regionPool() {
  const out = [];
  for (const cc of ["DE", "JP", "US"]) {
    out.push(N(cc.toLowerCase() + "-good", 60, 0.005, 12, { cc }));
    out.push(N(cc.toLowerCase() + "-fast", 35, 0.07, 14, { cc }));
    out.push(N(cc.toLowerCase() + "-slow", 210, 0.0, 6, { cc }));
    for (let j = 0; j < 3; j++) out.push(N(cc.toLowerCase() + "-f" + j, 90 + j * 45, 0.01 + j * 0.015, 4 + j * 2, { cc }));
  }
  return out;
}

const scenarios = [
  { name: "静态异质", pool: basePool, mode: "lat" },
  { name: "静态异质", pool: basePool, mode: "tput" },
  { name: "大池100", pool: bigPool, mode: "lat", hours: 8 },
  { name: "大池100", pool: bigPool, mode: "tput", hours: 8 },
  { name: "中途上新", pool: basePool, mode: "lat", eventAt: 2 * 3600, eventNode: N("fresh", 35, 0.003, 15) },
  { name: "中途劣化", pool: basePool, mode: "lat", eventAt: 2 * 3600, eventKey: "n0:443", eventP: 0.45 },
  {
    name: "带宽崩塌",
    pool: basePool,
    mode: "tput",
    hours: 6,
    eventAt: 2 * 3600,
    eventKey: "n1:443",
    eventBw: 0.5,
  },
  {
    name: "同质池",
    pool: () => {
      const out = [];
      for (let i = 0; i < 10; i++) out.push(N("h" + i, 95 + i * 2, 0.01 + i * 0.001, 4 + i * 0.2));
      return out;
    },
    mode: "lat",
  },
  {
    name: "客户端限速",
    pool: () => {
      const out = [];
      for (let i = 0; i < 10; i++) out.push(N("c" + i, 60 + i * 4, 0.005, 1)); // 全部被客户端压到 1MB/s
      return out;
    },
    mode: "tput",
  },
  { name: "探活伪装", pool: () => [N("fake", 350, 0.0, 10, { probeTcp: 25 }), ...basePool().slice(0, 8)], mode: "lat" },
  {
    name: "三个撒谎",
    pool: () => [
      N("f1", 300, 0.0, 10, { probeTcp: 25 }),
      N("f2", 380, 0.004, 8, { probeTcp: 30 }),
      N("f3", 260, 0.0, 12, { probeTcp: 20 }),
      ...basePool().slice(0, 6),
    ],
    mode: "lat",
  },
  {
    name: "抖动节点",
    pool: () => [N("flap", 70, 0.2, 10, { burstOnly: true }), ...basePool().slice(0, 6)],
    mode: "lat",
    hours: 6,
    flap: true,
  },
  {
    name: "全坏池",
    pool: () => [0, 1, 2, 3, 4, 5].map((i) => N("bad" + i, 80 + i * 20, 0.15 + i * 0.05, 4 + i)),
    mode: "lat",
  },
  {
    name: "低流量",
    pool: basePool,
    mode: "lat",
    hours: 24,
    rate: 1 / 60, // 每分钟 1 个请求
  },
  { name: "地区DE", pool: regionPool, mode: "lat", region: "DE" },
  { name: "地区JP", pool: regionPool, mode: "lat", region: "JP" },
  { name: "地区US", pool: regionPool, mode: "lat", region: "US" },
];

/* ---------- 状态 ---------- */
const byKey = new Map();
let pool = [];

function reset() {
  NOW = T0;
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
  s.at = NOW;
  byKey.set(n.key, n);
}

const rttOf = (n) => n.tcp + n.tls * 1.2;
function trueCost(n, mode) {
  const bytes = mode === "tput" ? 10 * MB : 0.2 * MB;
  const work = (bytes / Math.max(1, n.bw * MB * (1 - n.stall))) * 1000;
  return (rttOf(n) + work) / (1 - n.pFail);
}

async function request(n, mode, burst) {
  const pf = burst ? 1 : n.burstOnly ? 0 : n.pFail;
  if (rnd() < pf) {
    await W.SEL.bumpFail(ENV, mode, n.key, false);
    return false;
  }
  const bytes = mode === "tput" ? 10 * MB : 0.2 * MB;
  const dur = rttOf(n) + (bytes / Math.max(1, n.bw * MB * (1 - n.stall))) * 1000;
  const bps = bytes / (dur / 1000);
  const w = Math.min(1, bytes / (512 * 1024)) * Math.min(1, dur / 1000);
  if (w > 0) W.nsSpeed(n.key, bps, bytes, ENV, Math.min(4, w));
  if (n.stall > 0) W.nsStall(n.key, n.stall * dur, dur);
  W.nsOk(n.key, 0, 0);
  W.nsLatency(n.key, rttOf(n)); // 真实首字节回流（对应 Connection.flush）
  return true;
}

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

/* ---------- 跑一个场景（一个种子） ---------- */
async function run(sc, hours, seedVal) {
  seed = seedVal;
  reset();
  pool = sc.pool();
  for (const n of pool) addNode(n);
  const mode = sc.mode;

  const scoped = sc.region ? pool.filter((n) => n.cc === sc.region) : pool;
  let best = null;
  let oracle = Infinity;
  let reliable = Infinity;
  const recompute = () => {
    oracle = Infinity;
    best = null;
    for (const n of sc.region ? pool.filter((x) => x.cc === sc.region) : pool) {
      const c = trueCost(n, mode);
      if (c < oracle) {
        oracle = c;
        best = n;
      }
    }
  };
  for (const n of scoped) if (n.pFail <= 0.05) reliable = Math.min(reliable, trueCost(n, mode));
  recompute();

  const rate = sc.rate || 1;
  const ticks = hours * 3600;
  let reqs = 0, fails = 0, direct = 0, costSum = 0, ratioSum = 0, bad = 0, top1 = 0;
  let switches = 0, lastCurs = "";
  let firstBestAt = -1, eventSeenAt = -1, leftEventAt = -1, fakeHits = 0, flapHits = 0;
  let badCursorTicks = 0, afterEventTicks = 0;
  const tailFrom = Math.floor(ticks * 0.75);
  let tailN = 0, tailTop = 0;
  const ratios = [];

  for (let t = 0; t < ticks; t++) {
    NOW += 1000;
    if (t % 1800 === 0) cron();

    if (sc.eventAt && t === sc.eventAt) {
      if (sc.eventNode) {
        pool.push(sc.eventNode);
        addNode(sc.eventNode);
      }
      if (sc.eventKey) {
        const n = byKey.get(sc.eventKey);
        if (sc.eventP !== undefined) n.pFail = sc.eventP;
        if (sc.eventBw !== undefined) n.bw = sc.eventBw;
      }
      recompute();
    }

    if (sc.flap) byKey.get("flap:443").burst = Math.floor(t / 600) % 5 === 0; // 每 10 分钟挂 2 分钟
    const nReq = Math.floor(rate) + (rnd() < rate - Math.floor(rate) ? 1 : 0);
    for (let q = 0; q < nReq; q++) {
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
      const ok = await request(n, mode, n.burst);
      if (!ok) fails++;
      const c = trueCost(n, mode);
      const ratio = oracle > 0 ? c / oracle : 1;
      costSum += c;
      ratioSum += ratio;
      ratios.push(ratio);
      if (ratio > 1.5) bad++;
      if (n === best) {
        top1++;
        if (firstBestAt < 0) firstBestAt = t;
      }
      if (sc.eventAt && t >= sc.eventAt) {
        afterEventTicks++;
        if (n.key === (sc.eventKey || (sc.eventNode && sc.eventNode.key))) {
          badCursorTicks++;
          if (leftEventAt < 0 && t > sc.eventAt + 1) leftEventAt = t;
        } else if (leftEventAt < 0) leftEventAt = t;
      }
      if (n.id.startsWith("fake") || n.id.startsWith("f")) fakeHits++;
      if (n.id === "flap") flapHits++;
      if (t >= tailFrom) {
        tailN++;
        if (n === best) tailTop++;
      }
    }
  }

  ratios.sort((a, b) => a - b);
  return {
    name: sc.name,
    mode,
    reqs,
    failPct: (fails / Math.max(1, reqs)) * 100,
    directPct: (direct / Math.max(1, reqs + direct)) * 100,
    meanRatio: ratioSum / Math.max(1, reqs),
    p95: ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.95))] || 1,
    meanCost: costSum / Math.max(1, reqs),
    oracle,
    reliable,
    badPct: (bad / Math.max(1, reqs)) * 100,
    top1Pct: (top1 / Math.max(1, reqs)) * 100,
    tailTopPct: (tailTop / Math.max(1, tailN)) * 100,
    swPerH: switches / hours,
    firstBest: firstBestAt < 0 ? "-" : fmt(firstBestAt),
    eventSeen: sc.eventAt ? (eventSeenAt < 0 ? "" : fmt(eventSeenAt)) : "",
    leaveEvent: sc.eventAt ? (leftEventAt < 0 ? "never" : fmt(leftEventAt - sc.eventAt)) : "",
    fakeShare: (fakeHits / Math.max(1, reqs)) * 100,
    flapShare: (flapHits / Math.max(1, reqs)) * 100,
    badCursorPct: sc.eventAt ? (badCursorTicks / Math.max(1, afterEventTicks)) * 100 : 0,
  };
}

const fmt = (s) => (s < 90 ? s + "s" : s < 5400 ? Math.round(s / 60) + "m" : (s / 3600).toFixed(1) + "h");
const p = (s, n) => String(s).padEnd(n);
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

const hours = Number(process.argv[2] || 4);
const seeds = Number(process.env.SEEDS || 3);
const seed0 = Number(process.env.SEED0 || 1);
console.log(`仿真 ${hours} 小时 × ${seeds} 个随机种子 / 每 30 分钟 cron / 默认 1 请求每秒\n`);
console.log(
  p("场景", 12) + p("模式", 5) + p("请求", 8) + p("失败%", 7) + p("直连%", 7) +
    p("代价倍率", 18) + p("P95", 7) + p(">1.5x", 7) + p("末段命中", 9) + "切/小时",
);

const list = process.env.ONLY ? scenarios.filter((x) => x.name.includes(process.env.ONLY)) : scenarios;
const rows = [];
for (const sc of list) {
  const h = sc.hours || hours;
  const rs = [];
  for (let i = 0; i < seeds; i++) rs.push(await run(sc, h, seed0 + i));
  const ratios = rs.map((r) => r.meanRatio);
  const row = {
    name: sc.name,
    mode: sc.mode,
    reqs: mean(rs.map((r) => r.reqs)),
    failPct: mean(rs.map((r) => r.failPct)),
    directPct: mean(rs.map((r) => r.directPct)),
    meanRatio: mean(ratios),
    lo: Math.min(...ratios),
    hi: Math.max(...ratios),
    p95: mean(rs.map((r) => r.p95)),
    badPct: mean(rs.map((r) => r.badPct)),
    top1Pct: mean(rs.map((r) => r.top1Pct)),
    tailTopPct: mean(rs.map((r) => r.tailTopPct)),
    swPerH: mean(rs.map((r) => r.swPerH)),
    firstBest: rs[0].firstBest,
    leaveEvent: rs[0].leaveEvent,
    fakeShare: mean(rs.map((r) => r.fakeShare)),
    badCursorPct: mean(rs.map((r) => r.badCursorPct)),
    oracle: rs[0].oracle,
    reliable: rs[0].reliable,
    meanCost: mean(rs.map((r) => r.meanCost)),
  };
  rows.push(row);
  console.log(
    p(row.name, 12) + p(row.mode, 5) + p(Math.round(row.reqs), 8) + p(row.failPct.toFixed(1), 7) +
      p(row.directPct.toFixed(0) + "%", 7) +
      p(`${row.meanRatio.toFixed(2)}x (${row.lo.toFixed(2)}-${row.hi.toFixed(2)})`, 18) +
      p(row.p95.toFixed(1) + "x", 7) + p(row.badPct.toFixed(0) + "%", 7) +
      p(row.tailTopPct.toFixed(0) + "%", 9) + row.swPerH.toFixed(1),
  );
}

console.log("\n细节：");
for (const r of rows) {
  const extra = [];
  if (r.leaveEvent && r.leaveEvent !== "never") extra.push(`事件后 ${r.leaveEvent} 换走，旧节点仍占 ${r.badCursorPct.toFixed(0)}%`);
  if (r.name.includes("撒谎") || r.name === "探活伪装") extra.push(`撒谎节点吃掉 ${r.fakeShare.toFixed(0)}%`);
  extra.push(`上帝 ${Math.round(r.oracle)}ms / 可靠 ${Math.round(r.reliable)}ms / 本算法 ${Math.round(r.meanCost)}ms`);
  console.log(`- ${r.name}/${r.mode}: ${extra.join("；")}`);
}
