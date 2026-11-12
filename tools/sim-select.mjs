// 节点选择的"地面真值"仿真：批量伪造节点（真实延迟/失败率/带宽/卡顿/探活撒谎），
// 用真实的 pick / region / bumpFail / nsProbe / nsSpeed 跑，最后和上帝视角对比。
//   用法：node test/mk_test.mjs && node tools/sim-select.mjs [小时数]
//   环境变量：SEEDS=3、SEED0=1、ONLY=名字、FAIL/H_LAT_REL/TRIAL_LAT... 覆盖 SC
import * as W from "../test/_bundle.mjs";

const S = W.S;
const MB = 1048576;

/* ---------- 可控时钟 + 可复现随机 ---------- */
const T0 = Date.UTC(2026, 0, 1);
let NOW = T0;
Date.now = () => NOW;
let seed = 1;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = rnd;

if (process.env.LAT_TS !== undefined) W.SC.LAT_TS = Number(process.env.LAT_TS);
if (process.env.ROUTE_T_LAT) W.SC.ROUTE_T_LAT = Number(process.env.ROUTE_T_LAT);
if (process.env.ROUTE_T_TPUT) W.SC.ROUTE_T_TPUT = Number(process.env.ROUTE_T_TPUT);
if (process.env.FAIL) W.SC.FAIL = Number(process.env.FAIL);
if (process.env.H_LAT_REL) W.SC.H_LAT_REL = Number(process.env.H_LAT_REL);
if (process.env.TRIAL_LAT) W.SC.TRIAL_LAT = Number(process.env.TRIAL_LAT);
if (process.env.TRIAL_TPUT) W.SC.TRIAL_TPUT = Number(process.env.TRIAL_TPUT);
if (process.env.BETA_A) W.SC.BETA_A = Number(process.env.BETA_A);
if (process.env.BETA_B) W.SC.BETA_B = Number(process.env.BETA_B);

const ENV = { pxDwellMin: 0, pxShadow: 0.05, pxSchedH: 6 };

/* 备选：失败率只做门槛，排序只看可测量（延迟/吞吐） */
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

/* 备选：地区模式"延迟优先"——失败率只做门槛，不进分数 */
if (process.env.RGN === "fast") {
  const gate = Number(process.env.RGN_GATE || 0.08);
  W.SEL.region = async (_env, cc, mode, avoid = "") => {
    const want = String(cc || "").toUpperCase();
    const list = W.candsFor(mode).filter((r) => {
      const a = S.alive.get(r.k);
      return a && String(a.cc || "").toUpperCase() === want && r.k !== avoid;
    });
    if (!list.length) return null;
    let best = "", bv = Infinity;
    for (const r of list) {
      const p = W.scoreParts(r.k, mode);
      if (p.pFailRisk > gate) continue; // 只挡"明显坏"的
      const v = p.latencyMs + 2500 * p.pStall;
      if (v < bv) { bv = v; best = r.k; }
    }
    if (!best) best = list[0].k;
    return S.alive.get(best) || null;
  };
}

/* 可选路由：softmax（按分数在 top-K 里抽签），用来和"单游标 + 滞回"对比 */
if (process.env.ROUTE === "softmax") {
  const K = Number(process.env.KTOP || 12);
  const T = Number(process.env.TEMP || 80);
  const draw = (list) => {
    if (!list.length) return "";
    const v0 = list[0].v;
    const w = list.map((x) => Math.exp(-(x.v - v0) / T));
    let tot = 0;
    for (const x of w) tot += x;
    let r = Math.random() * tot;
    for (let i = 0; i < list.length; i++) {
      r -= w[i];
      if (r <= 0) return list[i].k;
    }
    return list[0].k;
  };
  W.SEL.pick = (_env, mode) => draw(W.candsFor(mode).slice(0, K));
  W.SEL.region = async (_env, cc, mode, avoid = "") => {
    const want = String(cc || "").toUpperCase();
    if (!want) return null;
    const list = W.candsFor(mode)
      .filter((r) => {
        const a = S.alive.get(r.k);
        return a && String(a.cc || "").toUpperCase() === want && r.k !== avoid;
      })
      .slice(0, K);
    const k = draw(list);
    if (!k) return null;
    const a = S.alive.get(k);
    return a || null;
  };
}

/* ---------- 节点 ---------- */
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

const fillers = (n, f) => Array.from({ length: n }, (_, i) => f(i));

function bigPool() {
  return [N("b0", 60, 0.005, 14), ...fillers(99, (i) => N("b" + (i + 1), 100 + ((i * 53) % 300), 0.02 + ((i * 29) % 4) * 0.01, 1 + ((i * 17) % 20)))];
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

/* ---------- 场景 ---------- */
const scenarios = [
  /* 池子规模 */
  { group: "规模", name: "1 节点", pool: () => [N("s0", 60, 0.005, 12)], mode: "lat" },
  { group: "规模", name: "5 节点", pool: () => [N("s0", 60, 0.005, 12), ...fillers(4, (i) => N("s" + (i + 1), 120 + i * 40, 0.01 + i * 0.01, 6))], mode: "lat" },
  { group: "规模", name: "20 节点", pool: basePool, mode: "lat" },
  { group: "规模", name: "100 节点", pool: bigPool, mode: "lat", hours: 8 },
  { group: "规模", name: "300 节点", pool: () => [N("b0", 60, 0.005, 14), ...fillers(299, (i) => N("b" + (i + 1), 100 + ((i * 53) % 300), 0.02 + ((i * 29) % 4) * 0.01, 1 + ((i * 17) % 20)))], mode: "lat", hours: 8, seeds: 1 },

  /* 失败率分布 */
  { group: "失败分布", name: "全好池", pool: () => fillers(10, (i) => N("g" + i, 60 + i * 30, i * 0.0005, 4 + i)), mode: "lat" },
  { group: "失败分布", name: "长尾", pool: () => fillers(20, (i) => N("t" + i, 60 + i * 15, Math.pow(i / 19, 3) * 0.3, 3 + i * 0.5)), mode: "lat" },
  { group: "失败分布", name: "双峰", pool: () => [...fillers(10, (i) => N("ok" + i, 80 + i * 20, 0.005, 6)), ...fillers(10, (i) => N("bad" + i, 50 + i * 10, 0.2, 10))], mode: "lat" },
  { group: "失败分布", name: "全坏池", pool: () => fillers(6, (i) => N("bad" + i, 80 + i * 20, 0.15 + i * 0.05, 4 + i)), mode: "lat" },

  /* 故障动态（2h 时触发） */
  { group: "故障动态", name: "永久死亡", pool: basePool, mode: "lat", hours: 6, eventAt: 7200, eventKey: "n0:443", eventP: 1 },
  { group: "故障动态", name: "死亡后恢复", pool: () => [N("phoenix", 70, 1, 10), ...basePool().slice(0, 6)], mode: "lat", hours: 8, eventAt: 7200, eventKey: "phoenix:443", eventP: 0.005 },
  { group: "故障动态", name: "周期抖动", pool: () => [N("flap", 70, 0.2, 10, { burstOnly: true }), ...basePool().slice(0, 6)], mode: "lat", hours: 6, flap: true },
  { group: "故障动态", name: "线性劣化", pool: basePool, mode: "lat", hours: 6, eventAt: 7200, eventKey: "n0:443", ramp: { from: 0.005, to: 0.4, ms: 3600 } },
  { group: "故障动态", name: "线性恢复", pool: () => [N("cured", 70, 0.4, 10), ...basePool().slice(0, 6)], mode: "lat", hours: 8, eventAt: 7200, eventKey: "cured:443", ramp: { from: 0.4, to: 0.005, ms: 3600 } },

  /* 延迟分布 */
  { group: "延迟", name: "同延迟", pool: () => fillers(10, (i) => N("h" + i, 100, 0.005 + i * 0.001, 5 + i * 0.5)), mode: "lat" },
  { group: "延迟", name: "宽分布", pool: () => fillers(10, (i) => N("w" + i, 40 + i * 40, 0.005, 5)), mode: "lat" },
  { group: "延迟", name: "抖动 30%", pool: () => fillers(10, (i) => N("j" + i, 60 + i * 20, 0.005, 5)), mode: "lat", jitter: 0.3 },

  /* 探活与真实不一致 */
  { group: "探活", name: "探活撒谎", pool: () => [N("fake", 350, 0.0, 10, { probeTcp: 25 }), ...basePool().slice(0, 8)], mode: "lat" },
  { group: "探活", name: "反向撒谎", pool: () => [N("shy", 60, 0.005, 20, { probeTcp: 420 }), ...basePool().slice(0, 8)], mode: "lat", hours: 8 },
  { group: "探活", name: "撒谎×3", pool: () => [N("f1", 300, 0.0, 10, { probeTcp: 25 }), N("f2", 380, 0.004, 8, { probeTcp: 30 }), N("f3", 260, 0.0, 12, { probeTcp: 20 }), ...basePool().slice(0, 6)], mode: "lat" },
  { group: "探活", name: "探活抖动", pool: () => [N("pj", 65, 0.005, 12), ...basePool().slice(0, 8)], mode: "lat", probeJitter: true },

  /* 流量强度 */
  { group: "流量", name: "1/分钟", pool: basePool, mode: "lat", hours: 24, rate: 1 / 60 },
  { group: "流量", name: "1/秒", pool: basePool, mode: "lat" },
  { group: "流量", name: "5/秒", pool: basePool, mode: "lat", rate: 5 },

  /* 地区 */
  { group: "地区", name: "单节点", pool: () => [N("d0", 60, 0.005, 12, { cc: "DE" })], mode: "lat", region: "DE" },
  { group: "地区", name: "全坏", pool: () => fillers(3, (i) => N("d" + i, 80 + i * 20, 0.2, 5, { cc: "DE" })), mode: "lat", region: "DE" },
  { group: "地区", name: "空地区", pool: regionPool, mode: "lat", region: "FR" },
  { group: "地区", name: "正常 DE", pool: regionPool, mode: "lat", region: "DE" },

  /* 链路 */
  { group: "链路", name: "客户端限速", pool: () => fillers(10, (i) => N("c" + i, 60 + i * 4, 0.005, 1)), mode: "tput" },
  { group: "链路", name: "卡顿 30%", pool: () => fillers(6, (i) => N("st" + i, 60 + i * 20, 0.005, 10, { stall: i < 3 ? 0.3 : 0 })), mode: "tput" },
  { group: "链路", name: "带宽崩塌", pool: basePool, mode: "tput", hours: 6, eventAt: 7200, eventKey: "n1:443", eventBw: 0.5 },

  /* 池子变动 */
  { group: "池变动", name: "加 5 个节点", pool: basePool, mode: "lat", eventAt: 7200, eventAdd: fillers(5, (i) => N("new" + i, 40 + i * 15, 0.004, 18 - i)) },
  { group: "池变动", name: "删当前最优", pool: basePool, mode: "lat", eventAt: 7200, eventDel: "n10:443" },

  /* 长跑 */
  { group: "长跑", name: "24h", pool: basePool, mode: "lat", hours: 24, seeds: 1 },
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
  S.rankCache = { t: 0, at: {}, v: {} };
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
  if (n.pFail >= 1) return Infinity;
  const bytes = mode === "tput" ? 10 * MB : 0.2 * MB;
  const work = (bytes / Math.max(1, n.bw * MB * (1 - n.stall))) * 1000;
  return (rttOf(n) + work) / (1 - n.pFail);
}

async function request(n, mode, burst, jitter) {
  const pf = burst ? 1 : n.burstOnly ? 0 : n.pFail;
  if (rnd() < pf) {
    await W.SEL.bumpFail(ENV, mode, n.key, false);
    return false;
  }
  const rtt = rttOf(n) * (jitter ? 1 + (rnd() - 0.5) * jitter : 1);
  const bytes = mode === "tput" ? 10 * MB : 0.2 * MB;
  const dur = rtt + (bytes / Math.max(1, n.bw * MB * (1 - n.stall))) * 1000;
  const bps = bytes / (dur / 1000);
  const w = Math.min(1, bytes / (512 * 1024)) * Math.min(1, dur / 1000);
  if (w > 0) W.nsSpeed(n.key, bps, bytes, ENV, Math.min(4, w));
  if (n.stall > 0) W.nsStall(n.key, n.stall * dur, dur);
  W.nsOk(n.key, 0, 0);
  W.nsLatency(n.key, rtt); // 真实首字节回流（对应 Connection.flush）
  return true;
}

function cron(sc) {
  for (const n of pool) {
    if (rnd() < n.pFail * 0.4) W.nsProbeFail(n.key);
    else {
      const j = 0.9 + rnd() * 0.2;
      const pj = sc.probeJitter ? 0.4 + rnd() * 1.2 : 1;
      W.nsProbe(n.key, (n.probeTcp * pj + n.tls) * j, n.probeTcp * pj * j, n.tls * j);
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

  const scoped = () => (sc.region ? pool.filter((n) => n.cc === sc.region) : pool);
  let best = null;
  let oracle = Infinity;
  let reliable = Infinity;
  const recompute = () => {
    oracle = Infinity;
    best = null;
    for (const n of scoped()) {
      const c = trueCost(n, mode);
      if (c < oracle) {
        oracle = c;
        best = n;
      }
    }
  };
  for (const n of scoped()) if (n.pFail > 0 && n.pFail <= 0.05) reliable = Math.min(reliable, trueCost(n, mode));
  recompute();

  const rate = sc.rate || 1;
  const ticks = hours * 3600;
  let reqs = 0, fails = 0, direct = 0, costSum = 0, ratioSum = 0, bad = 0, top1 = 0;
  let switches = 0, lastCurs = "", regionFail = 0;
  let firstBestAt = -1, leaveEventAt = -1, reuseAt = -1, fakeHits = 0, afterEvent = 0, onEvent = 0;
  const hits = new Map();
  const tailFrom = Math.floor(ticks * 0.75);
  let tailN = 0, tailTop = 0;
  const ratios = [];

  for (let t = 0; t < ticks; t++) {
    NOW += 1000;
    if (t % 1800 === 0) cron(sc);

    if (sc.eventAt && t === sc.eventAt) {
      if (sc.eventNode) {
        pool.push(sc.eventNode);
        addNode(sc.eventNode);
      }
      if (sc.eventAdd) for (const n of sc.eventAdd) {
        pool.push(n);
        addNode(n);
      }
      if (sc.eventDel) {
        S.alive.delete(sc.eventDel);
        byKey.delete(sc.eventDel);
        pool = pool.filter((x) => x.key !== sc.eventDel);
      }
      if (sc.eventKey) {
        const n = byKey.get(sc.eventKey);
        if (sc.eventP !== undefined) n.pFail = sc.eventP;
        if (sc.eventBw !== undefined) n.bw = sc.eventBw;
      }
      recompute();
    }
    if (sc.ramp && t >= sc.eventAt && t < sc.eventAt + sc.ramp.ms && t % 300 === 0) {
      const n = byKey.get(sc.eventKey);
      const f = (t - sc.eventAt) / sc.ramp.ms;
      n.pFail = sc.ramp.from + (sc.ramp.to - sc.ramp.from) * f;
      recompute();
    }
    if (sc.flap) byKey.get("flap:443").burst = Math.floor(t / 600) % 5 === 0;

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
        if (sc.region) regionFail++;
        else direct++;
        continue;
      }
      reqs++;
      const ok = await request(n, mode, n.burst, sc.jitter);
      if (!ok) fails++;
      const c = trueCost(n, mode);
      const ratio = Number.isFinite(oracle) && oracle > 0 && Number.isFinite(c) ? c / oracle : 1;
      costSum += Number.isFinite(c) ? c : Number.isFinite(oracle) ? oracle * 2 : 1e6;
      ratioSum += ratio;
      ratios.push(ratio);
      if (ratio > 1.5) bad++;
      if (n === best) {
        top1++;
        if (firstBestAt < 0) firstBestAt = t;
      }
      if (sc.eventAt && t >= sc.eventAt) {
        afterEvent++;
        const ek = sc.eventKey || (sc.eventDel || "");
        if (n.key === ek) {
          onEvent++;
          if (leaveEventAt < 0 && t > sc.eventAt + 1) leaveEventAt = t;
        } else if (leaveEventAt < 0) leaveEventAt = t;
        if (reuseAt < 0 && ek && n.key === ek) reuseAt = t;
      }
      hits.set(n.key, (hits.get(n.key) || 0) + 1);
      if (n.id.startsWith("fake") || n.id.startsWith("f")) fakeHits++;
      if (t >= tailFrom) {
        tailN++;
        if (n === best) tailTop++;
      }
    }
  }

  if (process.env.DUMP && sc.name === "带宽崩塌" && mode === "tput") {
    const rows = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log("[dump]", rows.map(([k, v]) => `${k}:${v}(${Math.round(W.costOf(k, "tput"))}ms,n=${Math.round((W.nsGet(k).okW||0))})`).join(" "));
  }
  ratios.sort((a, b) => a - b);
  return {
    name: sc.name,
    mode,
    reqs,
    failPct: (fails / Math.max(1, reqs)) * 100,
    directPct: (direct / Math.max(1, reqs + direct)) * 100,
    regionFailPct: (regionFail / Math.max(1, reqs + regionFail + direct)) * 100,
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
    leaveEvent: sc.eventAt ? (leaveEventAt < 0 ? "never" : fmt(leaveEventAt - sc.eventAt)) : "",
    reuse: reuseAt < 0 ? "" : fmt(reuseAt - (sc.eventAt || 0)),
    fakeShare: (fakeHits / Math.max(1, reqs)) * 100,
    onEventPct: sc.eventAt ? (onEvent / Math.max(1, afterEvent)) * 100 : 0,
  };
}

const fmt = (s) => (s < 90 ? s + "s" : s < 5400 ? Math.round(s / 60) + "m" : (s / 3600).toFixed(1) + "h");
const p = (s, n) => String(s).padEnd(n);
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

const hours = Number(process.argv[2] || 4);
const seeds = Number(process.env.SEEDS || 3);
const seed0 = Number(process.env.SEED0 || 1);
console.log(`仿真 ${hours}h × ${seeds} 种子 / cron 30 分钟 / 默认 1 请求每秒\n`);
console.log(
  p("场景", 14) + p("模式", 5) + p("请求", 8) + p("失败%", 7) + p("直连%", 7) +
    p("代价倍率", 18) + p("P95", 7) + p(">1.5x", 7) + p("末段", 7) + "切/小时",
);

const list = process.env.ONLY ? scenarios.filter((x) => x.name.includes(process.env.ONLY)) : scenarios;
const rows = [];
let group = "";
for (const sc of list) {
  if (sc.group !== group) {
    group = sc.group;
    console.log(`\n[${group}]`);
  }
  const h = sc.hours || hours;
  const nSeed = sc.seeds || seeds;
  const rs = [];
  for (let i = 0; i < nSeed; i++) rs.push(await run(sc, h, seed0 + i));
  const ratios = rs.map((r) => r.meanRatio);
  const row = {
    name: sc.name,
    mode: sc.mode,
    reqs: mean(rs.map((r) => r.reqs)),
    failPct: mean(rs.map((r) => r.failPct)),
    directPct: mean(rs.map((r) => r.directPct)),
    regionFailPct: mean(rs.map((r) => r.regionFailPct)),
    meanRatio: mean(ratios),
    lo: Math.min(...ratios),
    hi: Math.max(...ratios),
    p95: mean(rs.map((r) => r.p95)),
    badPct: mean(rs.map((r) => r.badPct)),
    tailTopPct: mean(rs.map((r) => r.tailTopPct)),
    swPerH: mean(rs.map((r) => r.swPerH)),
    leaveEvent: rs[0].leaveEvent,
    reuse: rs[0].reuse,
    fakeShare: mean(rs.map((r) => r.fakeShare)),
    onEventPct: mean(rs.map((r) => r.onEventPct)),
    oracle: rs[0].oracle,
    reliable: rs[0].reliable,
    meanCost: mean(rs.map((r) => r.meanCost)),
  };
  rows.push(row);
  console.log(
    p(row.name, 14) + p(row.mode, 5) + p(Math.round(row.reqs), 8) + p(row.failPct.toFixed(1), 7) +
      p((row.regionFailPct > row.directPct ? row.regionFailPct : row.directPct).toFixed(0) + "%", 7) +
      p(`${row.meanRatio.toFixed(2)}x (${row.lo.toFixed(2)}-${row.hi.toFixed(2)})`, 18) +
      p(row.p95.toFixed(1) + "x", 7) + p(row.badPct.toFixed(0) + "%", 7) +
      p(row.tailTopPct.toFixed(0) + "%", 7) + row.swPerH.toFixed(1),
  );
}

console.log("\n事件/细节：");
for (const r of rows) {
  const extra = [];
  if (r.leaveEvent) extra.push(`事件后 ${r.leaveEvent} 离开，旧节点仍占 ${r.onEventPct.toFixed(0)}%`);
  if (r.reuse) extra.push(`${r.reuse} 后重新用上`);
  if (r.regionFailPct > 0) extra.push(`1011 失败 ${r.regionFailPct.toFixed(0)}%`);
  if (r.name.includes("撒谎")) extra.push(`撒谎节点吃 ${r.fakeShare.toFixed(0)}%`);
  extra.push(`上帝 ${Number.isFinite(r.oracle) ? Math.round(r.oracle) : "∞"}ms / 本算法 ${Math.round(r.meanCost)}ms`);
  console.log(`- ${r.name}: ${extra.join("；")}`);
}
