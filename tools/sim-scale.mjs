// 规模测试：节点数从 50 涨到 3200，测"选得准不准"和"算得多贵"。
//   用法：node test/mk_test.mjs && node tools/sim-scale.mjs [小时数]
import * as W from "../test/_bundle.mjs";

const S = W.S;
const MB = 1048576;

let NOW = Date.UTC(2026, 0, 1);
Date.now = () => NOW;
let seed = 12345;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = rnd;

const ENV = { pxDwellMin: 0, pxShadow: 0.05, pxSchedH: 6 };
if (process.env.ACTIVE_LAT) W.SC.ACTIVE_LAT = Number(process.env.ACTIVE_LAT);
if (process.env.ACTIVE_TPUT) W.SC.ACTIVE_TPUT = Number(process.env.ACTIVE_TPUT);

/* 一个唯一最优 + N-1 个严格更差的填充（保证上帝视角稳定） */
function buildPool(n, cc) {
  const out = [
    { id: "good", key: "good:443", tcp: 60, tls: 40, pFail: 0.005, bw: 12, stall: 0, probeTcp: 60, cc },
  ];
  for (let i = 1; i < n; i++) {
    const tcp = 150 + (i % 5) * 40;
    out.push({
      id: "f" + i,
      key: "f" + i + ":443",
      tcp,
      tls: 40,
      pFail: 0.02 + (i % 3) * 0.01,
      bw: 5,
      stall: 0,
      probeTcp: tcp,
      cc,
    });
  }
  return out;
}

function reset() {
  NOW = Date.UTC(2026, 0, 1);
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
  S.rankCache = { t: 0, at: {}, v: {}, step: {} };
  S.candN = 0;
  S.pxFailMem = 0;
  S.pxFailSeen = 0;
  S.seedAt = NOW;
}

function install(pool) {
  for (const n of pool) {
    S.alive.set(n.key, { h: n.id, p: 443, cc: n.cc, ms: n.probeTcp + n.tls });
    const s = W.STATS.nsGet(n.key);
    s.tcp = n.probeTcp;
    s.tls = n.tls;
    s.at = NOW;
  }
}

const rttOf = (n) => n.tcp + n.tls * 1.2;
const trueCost = (n) => {
  const bytes = 0.2 * MB;
  return (rttOf(n) + (bytes / (n.bw * MB)) * 1000) / (1 - n.pFail);
};

async function request(n) {
  if (rnd() < n.pFail) {
    await W.SEL.bumpFail(ENV, "lat", n.key, false);
    return;
  }
  const bytes = 0.2 * MB;
  const dur = rttOf(n) + (bytes / (n.bw * MB)) * 1000;
  W.STATS.nsSpeed(n.key, bytes / (dur / 1000), bytes, ENV, Math.min(1, dur / 1000));
  W.STATS.nsOk(n.key, 0, 0);
  W.STATS.nsLatency(n.key, rttOf(n));
}

function cron(pool) {
  for (const n of pool) W.STATS.nsProbe(n.key, (n.probeTcp + n.tls) * 1.0, n.probeTcp, n.tls);
  W.SEL.afterScan(ENV);
}

function bench(fn, times = 20, rounds = 5) {
  const out = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < 3; i++) fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < times; i++) fn();
    out.push(Number(process.hrtime.bigint() - t0) / times / 1000);
  }
  out.sort((a, b) => a - b);
  return out[Math.floor(out.length / 2)];
}

async function benchAsync(fn, times = 30, rounds = 3) {
  const out = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < 3; i++) await fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < times; i++) await fn();
    out.push(Number(process.hrtime.bigint() - t0) / times / 1000);
  }
  out.sort((a, b) => a - b);
  return out[Math.floor(out.length / 2)];
}

async function run(n, hours, seedVal) {
  seed = seedVal;
  reset();
  const mem0 = process.memoryUsage().heapUsed;
  const pool = buildPool(n, "");
  install(pool);
  const mem = (process.memoryUsage().heapUsed - mem0) / MB;

  const candLat = bench(() => {
    S.rankCache = { t: 0, at: {}, v: {}, step: {} };
    W.candsFor("lat");
  });
  const candTput = bench(() => {
    S.rankCache = { t: 0, at: {}, v: {}, step: {} };
    W.candsFor("tput");
  }, 10);
  S.seedAt = NOW + 3600e3; // 让 SEEDS.read 直接返回，只量选路本身
  const reg = await benchAsync(() => W.SEL.region(ENV, "DE", "lat"), 10);
  const pickUs = bench(() => W.SEL.pick(ENV, "lat", { host: "" }), 500);

  const pool2 = buildPool(n, "DE");
  reset();
  install(pool2);
  const byKey = new Map(pool2.map((x) => [x.key, x]));
  const oracle = trueCost(pool2[0]);
  const ticks = hours * 3600;
  let reqs = 0, ratioSum = 0, bad = 0, top = 0, sw = 0, last = "";
  const hits = new Map();
  const tailFrom = Math.floor(ticks * 0.7);
  let tailN = 0, tailTop = 0;
  for (let t = 0; t < ticks; t++) {
    NOW += 1000;
    if (t % 1800 === 0) cron(pool2);
    const key = W.SEL.pick(ENV, "lat", { host: "" });
    if (S.curs.lat && S.curs.lat !== last) {
      sw++;
      last = S.curs.lat;
    }
    hits.set(key, (hits.get(key) || 0) + 1);
    const node = byKey.get(key);
    if (!node) continue;
    reqs++;
    await request(node);
    const ratio = trueCost(node) / oracle;
    ratioSum += ratio;
    if (ratio > 1.5) bad++;
    if (node.id === "good") top++;
    if (t >= tailFrom) {
      tailN++;
      if (node.id === "good") tailTop++;
    }
  }

  // seed 体积：SEED_MAX=40，看看 40 个节点占多少字节
  const seedBytes = (() => {
    const rows = pool2.slice(0, 40).map((x) => W.SEEDS.packNode(x.key));
    return JSON.stringify(rows).length;
  })();

  if (process.env.DUMP) {
    const hits = new Map();
    // 只统计最后一次 pick 的分数分布
    const rows = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.log("[dump]", n, "active", S.active.lat.size, "hasGood", S.active.lat.has("good:443"), "candN", S.candN,
      rows.map(([k, v]) => {
        const nd = byKey.get(k);
        return k + ":" + v + (nd ? "(" + Math.round(nd.tcp) + "ms," + Math.round(100 * nd.pFail) + "%)" : "");
      }).join(" "));
  }
  let seen = 0;
  for (const st of S.nstat.values()) if ((st.okW || 0) + (st.failW || 0) >= 2) seen++;
  return {
    n,
    seen,
    candLat,
    candTput,
    reg,
    pickUs,
    mem,
    ratio: ratioSum / Math.max(1, reqs),
    bad: (bad / Math.max(1, reqs)) * 100,
    top: (top / Math.max(1, reqs)) * 100,
    tailTop: (tailTop / Math.max(1, tailN)) * 100,
    sw: sw / hours,
    seedBytes,
  };
}

const p = (s, n) => String(s).padEnd(n);
const hours = Number(process.argv[2] || 2);
const sizes = (process.env.SIZES || "50,100,200,400,800,1600,3200").split(",").map(Number);
console.log(`规模测试：每个规模跑 ${hours}h / 1 请求每秒 / 唯一最优 60ms + N-1 个 ≥150ms 填充\n`);
console.log(
  p("节点数", 8) + p("candsFor", 10) + p("tput", 9) + p("region", 9) + p("pick", 7) +
    p("内存", 8) + p("倍率（种子间）", 16) + p(">1.5x", 8) + p("有样本", 7) + p("末段", 7) + "切/小时",
);
const SEEDS = Number(process.env.SEEDS || 3);
const SEED0 = Number(process.env.SEED0 || 1);
const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
for (const n of sizes) {
  const rs = [];
  for (let i = 0; i < SEEDS; i++) rs.push(await run(n, hours, SEED0 + i));
  const rat = rs.map((r) => r.ratio);
  console.log(
    p(n, 8) + p(avg(rs.map((r) => r.candLat)).toFixed(0) + "µs", 10) +
      p(avg(rs.map((r) => r.candTput)).toFixed(0) + "µs", 9) +
      p(avg(rs.map((r) => r.reg)).toFixed(0) + "µs", 9) +
      p(avg(rs.map((r) => r.pickUs)).toFixed(1) + "µs", 7) +
      p(avg(rs.map((r) => r.mem)).toFixed(1) + "MB", 8) +
      p(`${avg(rat).toFixed(2)}x (${Math.min(...rat).toFixed(2)}-${Math.max(...rat).toFixed(2)})`, 16) +
      p(avg(rs.map((r) => r.bad)).toFixed(0) + "%", 8) +
      p(avg(rs.map((r) => (r.seen / r.n) * 100)).toFixed(0) + "%", 7) +
      p(avg(rs.map((r) => r.tailTop)).toFixed(0) + "%", 7) +
      avg(rs.map((r) => r.sw)).toFixed(1),
  );
}
console.log("\n注：region 每次连接都重算（没有 20s 缓存）；candsFor 是冷算（清缓存）的一次耗时。");
