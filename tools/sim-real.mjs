// "接近真实"的仿真：对数正态延迟/带宽、相关故障（Markov up/down）、节点换血、
// 昼夜流量、混合负载（小请求 vs 10MB）、站点侧失败。仍然跑真实 pick/bumpFail/nsProbe。
//   用法：node test/mk_test.mjs && node tools/sim-real.mjs [小时数]
import * as W from "../test/_bundle.mjs";

const S = W.S;
const MB = 1048576;
const K = 1024;

let NOW = Date.UTC(2026, 1, 2);
Date.now = () => NOW;
let seed = 7;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = rnd;
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

if (process.env.PRIOR_BPS) W.SC.PRIOR_BPS = Number(process.env.PRIOR_BPS);
if (process.env.LAT_TS !== undefined) W.SC.LAT_TS = Number(process.env.LAT_TS);
if (process.env.TS_COLD_PASS !== undefined) W.SC.TS_COLD_PASS = Number(process.env.TS_COLD_PASS);
if (process.env.TS_FB !== undefined) W.SC.TS_FB = Number(process.env.TS_FB);
if (process.env.TS_CURSOR !== undefined) W.SC.TS_CURSOR = Number(process.env.TS_CURSOR);
if (process.env.TS_TTL !== undefined) W.SC.TS_TTL = Number(process.env.TS_TTL);
if (process.env.TRIAL_TPUT) W.SC.TRIAL_TPUT = Number(process.env.TRIAL_TPUT);
if (process.env.ROUTE_T_LAT) W.SC.ROUTE_T_LAT = Number(process.env.ROUTE_T_LAT);
if (process.env.ROUTE_T_TPUT) W.SC.ROUTE_T_TPUT = Number(process.env.ROUTE_T_TPUT);

const ENV = { pxDwellMin: 0, pxShadow: 0.05, pxSchedH: 6 };

if (process.env.RANK === "ts") {
  const gate = Number(process.env.GATE || 0.02);
  W.SEL.pick = (_env, mode) => {
    const all = W.candsFor(mode);
    if (!all.length) return "";
    const K = Number(process.env.KTOP || 0);
    let pool = all;
    if (K > 0) {
      pool = all
        .map((x) => ({ x, p: W.scoreParts(x.k, mode) }))
        .filter((r) => r.p.pFailRisk <= gate)
        .sort((a, b) => a.p.latencyMs - b.p.latencyMs)
        .slice(0, K)
        .map((r) => r.x);
    }
    let best = "", bv = Infinity;
    for (const x of pool) {
      const p = W.scoreParts(x.k, mode);
      if (K === 0 && p.pFailRisk > gate) continue;
      let v = 0;
      if (mode === "tput") {
        // e10 的后验：对数正态，相对误差 ~0.5/sqrt(有效窗口数)
        const sg = 0.5 / Math.sqrt(Math.max(1, p.nEff));
        v = p.e10Ms * Math.exp(gauss() * sg) + 0.5 * p.latencyMs;
      } else {
        // 延迟的后验：正态，标准差 = latency / sqrt(样本数)
        const sd = p.latencyMs / Math.sqrt(Math.max(1, p.latN));
        v = p.latencyMs + gauss() * sd;
      }
      if (v < bv) { bv = v; best = x.k; }
    }
    return best || all[0].k;
  };
}
if (process.env.RANK === "rawsoft") {
  const gate = Number(process.env.GATE || 0.02);
  const T = Number(process.env.TEMP || 20);
  W.SEL.pick = (_env, mode) => {
    const all = W.candsFor(mode);
    const list = [];
    for (const x of all) {
      const p = W.scoreParts(x.k, mode);
      if (p.pFailRisk > gate) continue;
      const v = mode === "tput" ? p.e10Ms + 0.5 * p.latencyMs : p.latencyMs + 2500 * p.pStall;
      list.push({ k: x.k, v });
    }
    if (!list.length) return all.length ? all[0].k : "";
    list.sort((a, b) => a.v - b.v);
    const top = list.slice(0, 12);
    const v0 = top[0].v;
    let tot = 0;
    const w = top.map((x) => { const e = Math.exp(-(x.v - v0) / T); tot += e; return e; });
    let r = Math.random() * tot;
    for (let i = 0; i < top.length; i++) { r -= w[i]; if (r <= 0) return top[i].k; }
    return top[0].k;
  };
}
if (process.env.RANK === "raw") {
  const gate = Number(process.env.GATE || 0.02);
  W.SEL.pick = (_env, mode) => {
    const list = W.candsFor(mode);
    if (!list.length) return "";
    let best = "", bv = Infinity;
    for (const x of list) {
      const p = W.scoreParts(x.k, mode);
      if (p.pFailRisk > gate) continue;
      const v = mode === "tput" ? p.e10Ms + 0.5 * p.latencyMs : p.latencyMs;
      if (v < bv) { bv = v; best = x.k; }
    }
    return best || list[0].k;
  };
}

/* 备选设计：乐观初始化 + 贪心（没测过的节点按"已知最好"估，而不是 51 秒先验） */
if (process.env.ALT === "optim") {
  W.SEL.pick = (_env, mode) => {
    const list = W.candsFor(mode);
    if (!list.length) return "";
    let bestE = Infinity;
    for (const x of list) {
      const p = W.scoreParts(x.k, mode);
      if (p.confB >= 0.2 && p.e10Ms < bestE) bestE = p.e10Ms;
    }
    if (!Number.isFinite(bestE)) bestE = 51000;
    let bk = "", bv = Infinity;
    for (const x of list) {
      const p = W.scoreParts(x.k, mode);
      const e = p.confB >= 0.2 ? p.e10Ms : Math.min(p.e10Ms, bestE * 1.3);
      const v = (mode === "tput" ? e + 0.5 * p.latencyMs : p.latencyMs) + 8000 * p.pFailRisk + 2500 * p.pStall;
      if (v < bv) { bv = v; bk = x.k; }
    }
    return bk;
  };
}

/* ---------- 节点画像 ---------- */
let seq = 0;
function mkNode(o = {}) {
  const tcp = o.tcp !== undefined ? o.tcp : clamp(70 * Math.exp(0.55 * gauss()), 25, 420);
  const bw = o.bw !== undefined ? o.bw : clamp(6 * Math.exp(0.7 * gauss()), 0.5, 60);
  const id = o.id || "r" + ++seq;
  return {
    id,
    key: id + ":443",
    tcp,
    tls: 40,
    bw,
    pFail: o.pFail !== undefined ? o.pFail : clamp(0.004 + 0.012 * Math.abs(gauss()), 0, 0.06),
    probeTcp: o.probeTcp !== undefined ? o.probeTcp : tcp * (0.85 + 0.3 * rnd()),
    cc: o.cc || "",
    up: true,
    until: 0, // 当前状态到期时间
    down: false,
    born: 0,
  };
}

const rttOf = (n) => n.tcp + n.tls * 1.2;
const costOf = (n, size) => {
  if (n.down) return Infinity;
  return (rttOf(n) + (size / (n.bw * MB)) * 1000) / (1 - n.pFail);
};

/* ---------- 状态 ---------- */
const byKey = new Map();
let pool = [];

function reset() {
  NOW = Date.UTC(2026, 1, 2);
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
  pool = [];
  seq = 0;
}

function install(n, isNew = false) {
  S.alive.set(n.key, { h: n.id, p: 443, cc: n.cc, ms: Math.round(n.probeTcp + n.tls) });
  const s = W.nsGet(n.key);
  s.tcp = n.probeTcp;
  s.tls = n.tls;
  s.at = NOW;
  n.born = isNew ? NOW : -1e9;
  byKey.set(n.key, n);
}

function drop(n) {
  S.alive.delete(n.key);
  byKey.delete(n.key);
  pool = pool.filter((x) => x !== n);
}

/* ---------- 一次请求 ---------- */
async function request(n, mode, size, siteShare, jitter) {
  const pf = n.down ? 1 : n.pFail;
  if (rnd() < pf) {
    // 一部分失败是站点侧的（0 字节关闭/被目标拒绝）：不该按节点算账
    const site = rnd() < siteShare;
    await W.SEL.bumpFail(ENV, mode, n.key, false, site ? "site" : "node");
    return { ok: false, site };
  }
  const rtt = rttOf(n) * (jitter ? 1 + (rnd() - 0.5) * jitter : 1);
  const dur = rtt + (size / (n.bw * MB)) * 1000;
  const bps = size / (dur / 1000);
  // 与 Connection 的采样门槛保持一致：<32KB 或 <300ms 的请求不进吞吐直方图
  // 与 Connection.flush 一致：dt>=50 且（dt>=300 或 ≥1MB）
  if (size >= 32 * K && dur >= 50 && (dur >= 300 || size >= MB)) {
    const w = Math.min(1, size / (512 * K)) * Math.min(1, dur / 1000);
    if (w > 0) W.nsSpeed(n.key, bps, size, ENV, Math.min(4, w));
  }
  W.nsOk(n.key, 0, 0);
  W.nsLatency(n.key, rtt);
  return { ok: true };
}

function cron(probeFail) {
  for (const n of pool) {
    // 死掉的节点探活必须失败，否则 seed 会把死节点当好的传播出去
    if (n.down || rnd() < n.pFail * 0.4 * probeFail) W.nsProbeFail(n.key);
    else W.nsProbe(n.key, (n.probeTcp + n.tls) * (0.9 + rnd() * 0.2), n.probeTcp, n.tls);
  }
  W.SEL.afterScan(ENV);
}

/* ---------- 一个画像 ---------- */
async function run(p, hours, seedVal) {
  seed = seedVal;
  reset();
  for (let i = 0; i < p.nodes; i++) {
    const n = mkNode();
    pool.push(n);
    install(n);
  }
  if (p.markov) for (const n of pool) n.until = 1800 + Math.floor(rnd() * 5400);

  const ticks = hours * 3600;
  let reqs = 0, fails = 0, siteFails = 0, costSum = 0, ratioSum = 0, bad = 0, top = 0;
  let sw = 0, lastLat = "", lastTput = "", newSeen = 0, newTotal = 0, downHits = 0, ratioRelSum = 0;
  const tailFrom = Math.floor(ticks * 0.7);
  let tailN = 0, tailTop = 0, tailRatio = 0;
  const ratios = [];
  const downLeft = [];
  const hits = new Map();

  for (let t = 0; t < ticks; t++) {
    NOW += 1000;
    if (t % 1800 === 0) cron(p.probeFail === undefined ? 0.3 : p.probeFail);

    // Markov up/down：up 持续 30–120 分钟，down 持续 2–15 分钟
    if (p.markov) {
      for (const n of pool) {
        if (t < n.until) continue;
        n.down = !n.down;
        n.until = t + (n.down ? 120 + Math.floor(rnd() * 780) : 1800 + Math.floor(rnd() * 5400));
      }
    }

    // 节点换血：每 30 分钟换掉 p.churn 个
    if (p.churn && t > 0 && t % 1800 === 0) {
      for (let i = 0; i < p.churn; i++) {
        const old = pool[Math.floor(rnd() * pool.length)];
        if (old) drop(old);
        const n = mkNode();
        pool.push(n);
        install(n, true);
        newTotal++;
      }
    }

    // 昼夜：0.25x ~ 2x
    let rate = p.rate || 1;
    if (p.diurnal) rate *= 0.25 + 1.75 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 86400 - Math.PI / 2));
    let nReq = Math.floor(rate) + (rnd() < rate - Math.floor(rate) ? 1 : 0);

    for (let q = 0; q < nReq; q++) {
      const mode = p.tputShare && rnd() < p.tputShare ? "tput" : "lat";
      const size = mode === "tput" ? 10 * MB : rnd() < 0.85 ? 90 * K : 600 * K;
      const key = W.SEL.pick(ENV, mode, { host: "" });
      const curNow = S.curs[mode];
      if (mode === "tput") {
        if (curNow && curNow !== lastTput) {
          sw++;
          lastTput = curNow;
        }
      } else if (curNow && curNow !== lastLat) {
        sw++;
        lastLat = curNow;
      }
      const n = byKey.get(key);
      if (!n) continue;
      reqs++;
      if (n.down) downHits++;
      hits.set(n.key, (hits.get(n.key) || 0) + 1);
      const r = await request(n, mode, size, p.siteShare || 0, p.jitter || 0);
      if (!r.ok) {
        fails++;
        if (r.site) siteFails++;
      }
      // 上帝视角：当前活着的最优
      let best = Infinity, bestRel = Infinity;
      for (const x of pool) {
        if (x.down) continue;
        const c = costOf(x, size);
        if (c < best) best = c;
        if (x.pFail <= 0.02 && c < bestRel) bestRel = c;
      }
      const c = Number.isFinite(costOf(n, size)) ? costOf(n, size) : (Number.isFinite(best) ? best * 2 : 1e6);
      const ratio = Number.isFinite(best) && best > 0 ? c / best : 1;
      const ratioRel = Number.isFinite(bestRel) && bestRel > 0 ? c / bestRel : 1;
      costSum += c;
      ratioSum += ratio;
      ratioRelSum += ratioRel;
      ratios.push(ratio);
      if (ratio > 1.5) bad++;
      if (n === pool[0]) top++;
      if (t - n.born < 3600) newSeen++;
      if (t >= tailFrom) {
        tailN++;
        tailRatio += ratio;
        if (ratio <= 1.2) tailTop++;
      }
      if (p.markov) {
        // 记录"节点刚 down 后还被用了多久"
        if (n.down && n.until > t) downLeft.push(0);
      }
    }
  }

  if (process.env.DUMP) {
    const rows = [...byKey.values()].map((n) => ({ k: n.key, bw: +n.bw.toFixed(1), tcp: Math.round(n.tcp), pf: +n.pFail.toFixed(3), sc: Math.round(W.costOf(n.key, "tput")), hits: hits.get(n.key) || 0, cost: Math.round(costOf(n, 10 * MB)) }));
    rows.sort((a, b) => a.cost - b.cost);
    console.log("[dump]", p.name, "cur", S.curs.tput);
    console.log("[dump] oracle", rows[0], "cursor", rows.find((r) => r.k === S.curs.tput));
    console.log("[dump] top-score", rows.slice().sort((a, b) => a.sc - b.sc).slice(0, 3));
  }
  if (process.env.DUMP) {
    const rows = [...byKey.values()].map((n) => ({ k: n.key, tcp: Math.round(n.tcp), pf: +n.pFail.toFixed(3), hits: hits.get(n.key) || 0, sc: Math.round(W.costOf(n.key, "lat")), lat: Math.round(W.scoreParts(n.key, "lat").latencyMs), n: Math.round(W.scoreParts(n.key, "lat").latN) }));
    rows.sort((a, b) => b.hits - a.hits);
    console.log("[hits]", p.name, rows.slice(0, 5).map((r) => `${r.k}:${r.hits}(${r.tcp}ms,${r.pf},n=${r.n})`).join(" "));
  }
  ratios.sort((a, b) => a - b);
  return {
    name: p.name,
    reqs,
    failPct: (fails / Math.max(1, reqs)) * 100,
    sitePct: (siteFails / Math.max(1, reqs)) * 100,
    ratio: ratioSum / Math.max(1, reqs),
    ratioRel: ratioRelSum / Math.max(1, reqs),
    p95: ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.95))] || 1,
    bad: (bad / Math.max(1, reqs)) * 100,
    sw: sw / hours,
    tail: tailRatio / Math.max(1, tailN),
    downPct: (downHits / Math.max(1, reqs)) * 100,
    newShare: (newSeen / Math.max(1, reqs)) * 100,
  };
}

const fmt = (s, n) => String(s).padEnd(n);
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

const profiles = [
  { name: "真实画像 lat", nodes: 30, mode: "lat" },
  { name: "真实画像 tput", nodes: 30, tputShare: 1 },
  { name: "混合负载", nodes: 30, tputShare: 0.25 },
  { name: "相关故障", nodes: 30, markov: true },
  { name: "站点失败 30%", nodes: 30, siteShare: 0.3 },
  { name: "节点换血 3/30min", nodes: 30, churn: 3 },
  { name: "昼夜流量", nodes: 30, diurnal: true },
  { name: "延迟抖动 40%", nodes: 30, jitter: 0.4 },
  { name: "全真实", nodes: 30, tputShare: 0.25, markov: true, siteShare: 0.2, churn: 2, diurnal: true, jitter: 0.3 },
];

const hours = Number(process.argv[2] || 12);
const seeds = Number(process.env.SEEDS || 2);
const list = process.env.ONLY ? profiles.filter((x) => x.name.includes(process.env.ONLY)) : profiles;
console.log(`真实画像仿真 ${hours}h × ${seeds} 种子 / 30 个节点 / 对数正态延迟与带宽\n`);
console.log(
  fmt("画像", 18) + fmt("请求", 9) + fmt("失败%", 7) + fmt("其中站点%", 11) +
    fmt("倍率/可靠倍率", 20) + fmt("P95", 7) + fmt(">1.5x", 7) + fmt("末段", 7) + fmt("切/小时", 8) + fmt("新节点%", 9) + "打到死节点%",
);

for (const p of list) {
  const rs = [];
  const s0 = Number(process.env.SEED0 || 100);
  for (let i = 0; i < seeds; i++) rs.push(await run(p, hours, s0 + i));
  const rat = rs.map((r) => r.ratio);
  console.log(
    fmt(p.name, 18) + fmt(Math.round(mean(rs.map((r) => r.reqs))), 9) +
      fmt(mean(rs.map((r) => r.failPct)).toFixed(1), 7) +
      fmt(mean(rs.map((r) => r.sitePct)).toFixed(1), 11) +
      fmt(`${mean(rat).toFixed(2)}x / ${mean(rs.map((r) => r.ratioRel)).toFixed(2)}x`, 20) +
      fmt(mean(rs.map((r) => r.p95)).toFixed(1) + "x", 7) +
      fmt(mean(rs.map((r) => r.bad)).toFixed(0) + "%", 7) +
      fmt(mean(rs.map((r) => r.tail)).toFixed(2) + "x", 7) +
      fmt(mean(rs.map((r) => r.sw)).toFixed(1), 8) +
      fmt(mean(rs.map((r) => r.newShare)).toFixed(1), 9) +
      mean(rs.map((r) => r.downPct)).toFixed(1),
  );
}
