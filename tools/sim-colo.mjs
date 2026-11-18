// 跨机房（isolate）合并的后果：同一个节点在 AMS 和 SIN 的最优程度不一样，
// 把别的机房的样本合进来，到低是"借样本"还是"带偏"？
//   node test/mk_test.mjs && node tools/sim-colo.mjs 12
// 环境变量：NODES / RATE(每秒请求) / GEN(每个 isolate 活多久，分钟) / SHAPE(延迟|吞吐|混合)
import * as W from "../test/_bundle.mjs";

const S = W.S,
  SC = W.SC,
  SEL = W.SEL;
const MB = 1048576,
  TEN = 10 * MB;
const ENV = { pxDwellMin: 0, pxShadow: 0.05, pxSchedH: 6 };

let NOW = Date.UTC(2026, 1, 2);
Date.now = () => NOW;

let rs = 13;
const rnd = () => {
  rs |= 0;
  rs = (rs + 0x6d2b79f5) | 0;
  let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = rnd;
const gauss = () => {
  let u = 0,
    v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/* ---------------- 拓扑：4 个机房、24 个节点 ---------------- */
const COLOS = ["AMS", "SIN", "LAX", "FRA"];
// 单向传播时延（ms），对角 0
const LINK = {
  AMS: { AMS: 0, SIN: 165, LAX: 135, FRA: 12 },
  SIN: { AMS: 165, SIN: 0, LAX: 180, FRA: 160 },
  LAX: { AMS: 135, SIN: 180, LAX: 0, FRA: 145 },
  FRA: { AMS: 12, SIN: 160, LAX: 145, FRA: 0 },
};
const NODES = Number(process.env.NODES || 24);
const pool = [];
for (let i = 0; i < NODES; i++) {
  const home = COLOS[i % COLOS.length];
  pool.push({
    id: "c" + i,
    key: "c" + i + ":443",
    home,
    tcp: clamp(30 * Math.exp(0.5 * gauss()), 12, 180), // 本机房内的建连时延
    bw: clamp(8 * Math.exp(0.8 * gauss()), 1, 60), // 本机房内的带宽 MB/s
    pFail: clamp(0.004 + 0.01 * Math.abs(gauss()), 0, 0.05),
  });
}
const byKey = new Map(pool.map((n) => [n.key, n]));
// 每个 (机房, 节点) 的固定线路系数：外地带宽只有 35%~85%，再多一跳固定时延
const PATH = {};
for (const c of COLOS) {
  PATH[c] = {};
  for (const n of pool) {
    PATH[c][n.key] = n.home === c ? { extra: 0, bwf: 1 } : { extra: LINK[c][n.home] * (0.85 + 0.3 * rnd()), bwf: 0.35 + 0.5 * rnd() };
  }
}
const rttOf = (c, n) => n.tcp + PATH[c][n.key].extra + 40; // +40 ≈ TLS
const bwOf = (c, n) => n.bw * PATH[c][n.key].bwf;
const costOf = (c, n, size) => (rttOf(c, n) + (size / (bwOf(c, n) * MB)) * 1000) / (1 - n.pFail);

/* ---------------- isolate 状态：把 S / SEL 换进换出 ---------------- */
const clone1 = (v) => {
  if (v instanceof Map) return new Map();
  if (v instanceof Set) return new Set();
  if (Array.isArray(v)) return [];
  if (v && typeof v === "object") return { ...v };
  return v;
};
const KEYS = Object.keys(S);
const BLANK = {};
for (const k of KEYS) BLANK[k] = clone1(S[k]);
const fresh = () => {
  const o = {};
  for (const k of KEYS) o[k] = clone1(BLANK[k]);
  return o;
};
function load(st) {
  for (const k of KEYS) S[k] = st[k];
  SEL.watch = { lat: [], tput: [] };
  SEL.watchAt = { lat: 0, tput: 0 };
}
function save() {
  const o = {};
  for (const k of KEYS) o[k] = S[k];
  return o;
}

function install(n, colo) {
  S.alive.set(n.key, { h: n.id, p: 443, cc: "", ms: Math.round(rttOf(colo, n)) });
  const s = W.NodeStatsTable.nsGet(n.key);
  s.at = NOW;
}

function birth(colo, entries) {
  load(fresh());
  S.colo = colo;
  for (const n of pool) install(n, colo);
  for (const e of entries) W.SeedStore.unpackNode(e);
}

/* ---------------- 一次请求 / 一次探活 ---------------- */
let stat = null;
function request(colo, mode, size) {
  const k = SEL.pick(ENV, mode, { host: "" });
  const n = byKey.get(k);
  if (!n) return 1;
  stat.reqs++;
  const pf = n.pFail;
  if (rnd() < pf) {
    SEL.bumpFail(ENV, mode, k, false, "node");
    stat.fails++;
  } else {
    const rtt = rttOf(colo, n) * (0.95 + 0.1 * rnd());
    const dur = rtt + (size / (bwOf(colo, n) * MB)) * 1000;
    if (size >= 32 * 1024 && dur >= 50 && (dur >= 300 || size >= MB)) {
      const bps = size / (dur / 1000);
      const w = Math.min(1, size / (512 * 1024)) * Math.min(1, dur / 1000);
      if (w > 0) W.NodeStatsTable.nsSpeed(k, bps, size, ENV, Math.min(4, w));
    }
    W.NodeStatsTable.nsOk(k, 0, 0);
    W.NodeStatsTable.nsLatency(k, rtt);
  }
  // 上帝视角：本地最优 / 别的机房最优
  let best = Infinity,
    bOther = Infinity;
  for (const x of pool) {
    const c = costOf(colo, x, size);
    if (c < best) best = c;
    if (x.home !== colo && c < bOther) bOther = c;
  }
  const c = costOf(colo, n, size);
  const ratio = c / best;
  stat.ratio += ratio;
  // "被别的机房带偏"：这个节点在本地排不进前 8，在它自己的机房里却排前三
  const rankLocal = pool.filter((x) => costOf(colo, x, size) < c).length;
  const rankHome = pool.filter((x) => costOf(n.home, x, size) < costOf(n.home, n, size)).length;
  if (rankLocal >= 8 && rankHome <= 2) stat.misled++;
  return ratio;
}

function cron(colo) {
  for (const n of pool) {
    if (rnd() < n.pFail * 0.4) W.NodeStatsTable.nsProbeFail(n.key);
    else W.NodeStatsTable.nsProbe(n.key, rttOf(colo, n) * (0.9 + 0.2 * rnd()), n.tcp, 40);
  }
  SEL.afterScan(ENV);
}

/* ---------------- 种子桶：写 / 读（跨机房合并就在这里） ---------------- */
let buckets = {};
const die = (colo) => {
  const b = new Map();
  for (const k of S.nstat.keys()) {
    const s = S.nstat.get(k);
    if (!s || (s.okW || 0) + (s.failW || 0) < 1) continue;
    if (!S.alive.has(k)) continue;
    b.set(k, W.SeedStore.packNode(k));
  }
  buckets[colo] = b;
};

function merged() {
  const agg = new Map(); // k -> {k,h,p,cc,n,f,b,tcp,tls,ms}
  for (const c of COLOS) {
    for (const [k, e] of buckets[c] || []) {
      const o = agg.get(k) || { ...e, n: 0, f: 0, b: 0, wb: 0 };
      const n = e.n || 0;
      o.n += n;
      o.f += e.f || 0; // 失败次数直接相加（e.f 已经是次数）
      o.wb += (e.b || 0) * n;
      o.tcp = o.tcp || e.tcp;
      o.tls = o.tls || e.tls;
      agg.set(k, o);
    }
  }
  const out = [];
  for (const o of agg.values()) {
    const b = o.n > 0 ? Math.round(o.wb / o.n) : 0;
    out.push({ k: o.k, h: o.h, p: o.p, cc: o.cc, n: o.n, f: o.f, b, sb: b, tcp: o.tcp, tls: o.tls, at: NOW });
  }
  return out;
}

function seedFor(colo, strategy) {
  if (strategy === "none") return [];
  const local = buckets[colo] || new Map();
  if (strategy === "local") return [...local.values()];
  const all = merged();
  if (strategy === "cross") return all;
  // 分离两条通道：失败率先验（n/f）与带宽先验（b）分别来自合并 / 本地
  return all.map((e) => {
    const l = local.get(e.k);
    if (strategy === "cross-fail") return { ...e, b: l ? l.b : 0, sb: l ? l.b : 0, tcp: l ? l.tcp : 0, tls: l ? l.tls : 0 };
    if (strategy === "cross-bps") return { ...e, n: l ? l.n : 0, f: l ? l.f : 0, tcp: l ? l.tcp : 0, tls: l ? l.tls : 0 };
    if (strategy === "cross-tcp") return { ...e, n: l ? l.n : 0, f: l ? l.f : 0, b: l ? l.b : 0, sb: l ? l.b : 0 };
    if (strategy === "cross-cap") {
      // 均值用合并的，但置信度按"本地样本数"封顶：验证"合并变差"有多少来自过度自信
      const n = l && l.n ? Math.min(e.n, l.n) : 0;
      return { ...e, n, f: e.n > 0 ? (e.f * n) / e.n : 0 };
    }
    return e;
  });
}

/* ---------------- 主流程 ---------------- */
const hours = Number(process.argv[2] || 12);
const rate = Number(process.env.RATE || 1);
const genMin = Number(process.env.GEN || 60);
const seeds = Number(process.env.SEEDS || 3);
const BASE = Date.UTC(2026, 1, 2);
const shapes = [
  { name: "延迟", tputShare: 0 },
  { name: "吞吐", tputShare: 1 },
  { name: "混合", tputShare: 0.25 },
];
const only = process.env.SHAPE ? shapes.filter((x) => x.name.includes(process.env.SHAPE)) : shapes;
const strategies = ["none", "local", "cross", "cross-cap", "cross-tcp", "cross-bps"];
const fmt = (x, n) => String(x).padEnd(n);
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

function runOne(strategy, sh, rsVal) {
  rs = rsVal;
  NOW = BASE;
  buckets = {}; // 每个策略都从"机房之间没有共享数据"开始，避免上一轮残留
  SC.SEED_CONF = strategy === "cross-strong" ? 1 : 0.25;
  stat = { reqs: 0, fails: 0, ratio: 0, misled: 0, coldR: 0, coldN: 0, sw: 0 };
  const gens = Math.floor((hours * 60) / genMin);
  let lastCur = { lat: "", tput: "" };
  for (let g = 0; g < gens; g++) {
    const t0 = NOW;
    for (const colo of COLOS) {
      NOW = t0;
      birth(colo, seedFor(colo, strategy));
      const ticks = genMin * 60;
      for (let t = 0; t < ticks; t++) {
        NOW += 1000;
        if (t % 1800 === 0) cron(colo);
        for (let q = 0; q < rate; q++) {
          const mode = sh.tputShare && rnd() < sh.tputShare ? "tput" : "lat";
          const size = mode === "tput" ? TEN : rnd() < 0.85 ? 90 * 1024 : 600 * 1024;
          const r = request(colo, mode, size);
          if (t < 300) {
            stat.coldN++;
            stat.coldR += r;
          }
          const cur = S.curs[mode];
          if (cur && cur !== lastCur[mode]) {
            stat.sw++;
            lastCur[mode] = cur;
          }
        }
      }
      die(colo);
    }
    NOW = t0 + genMin * 60000;
  }
  return stat;
}

console.log(`跨机房合并仿真 ${hours}h × ${seeds} 种子 / ${NODES} 节点 / ${COLOS.length} 个机房 / isolate 活 ${genMin} 分钟 / ${rate} 请求每秒`);
console.log(`线路：AMS-FRA 12ms，AMS-SIN 165ms，LAX-SIN 180ms；外地带宽 35%~85%\n`);
console.log(
  fmt("负载", 8) + fmt("策略", 12) + fmt("失败%", 7) + fmt("倍率", 8) + fmt("被带偏%", 9) + fmt("开机 300 请求", 14) + "切/小时",
);
for (const sh of only) {
  for (const strategy of strategies) {
    const rs2 = [];
    for (let i = 0; i < seeds; i++) rs2.push(runOne(strategy, sh, 100 + i * 7));
    const g = (k) => mean(rs2.map((r) => r[k]));
    console.log(
      fmt(sh.name, 8) +
        fmt(strategy, 12) +
        fmt(g("reqs"), 7) +
        fmt(((g("fails") / Math.max(1, g("reqs"))) * 100).toFixed(1), 7) +
        fmt((g("ratio") / Math.max(1, g("reqs"))).toFixed(2) + "x", 8) +
        fmt(((g("misled") / Math.max(1, g("reqs"))) * 100).toFixed(1), 9) +
        fmt((g("coldR") / Math.max(1, g("coldN"))).toFixed(2) + "x", 14) +
        (g("sw") / (hours * COLOS.length)).toFixed(1),
    );
  }
  console.log("");
}
