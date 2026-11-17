// 用一组"手工设定真值"的假节点，把当前选优算法的行为摆出来看：
// 谁被选中、选中时离真·最优差多少、算法眼里的值和真值差在哪。
//   node test/mk_test.mjs && node tools/sim-show.mjs [小时数]
import * as W from "../test/_bundle.mjs";

const S = W.S;
const MB = 1048576;
const ENV = { pxDwellMin: 0, pxShadow: 0.05, pxSchedH: 6 };

let NOW = Date.UTC(2026, 2, 1);
Date.now = () => NOW;
let rs = 7;
const rnd = () => {
  rs |= 0;
  rs = (rs + 0x6d2b79f5) | 0;
  let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
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

/* ---------- 12 个假节点：覆盖各种"看起来好/实际好"的组合 ---------- */
const NODES = [
  { id: "fast", tcp: 45, bw: 25, pf: 0.005 }, // 真·六边形战士
  { id: "narrow", tcp: 50, bw: 1.5, pf: 0.002 }, // 延迟好、带宽窄
  { id: "flaky", tcp: 55, bw: 20, pf: 0.06 }, // 快但爱失败
  { id: "liar", tcp: 280, bw: 18, pf: 0.005, probeTcp: 22 }, // 探活 22ms，实际 280ms
  { id: "shy", tcp: 60, bw: 14, pf: 0.008, probeTcp: 420 }, // 探活 420ms，实际 60ms
  { id: "mid", tcp: 70, bw: 12, pf: 0.01 },
  { id: "stall", tcp: 75, bw: 18, pf: 0.01, stall: 0.3 }, // 带宽够但常卡
  { id: "bad", tcp: 85, bw: 5, pf: 0.15 }, // 又慢又坏
  { id: "lossy", tcp: 90, bw: 10, pf: 0.02 },
  { id: "solid", tcp: 110, bw: 12, pf: 0.008 },
  { id: "slow", tcp: 160, bw: 40, pf: 0.005 }, // 很慢但很宽
  { id: "new", tcp: 65, bw: 22, pf: 0.005, at: 3600 }, // 第 1 小时才入池
];
for (const n of NODES) {
  n.key = n.id + ":443";
  n.tls = 40;
  n.probe = n.probeTcp || n.tcp;
  n.born = n.at || 0;
}
const byKey = new Map(NODES.map((n) => [n.key, n]));

const rttOf = (n) => n.tcp + n.tls * 1.2;
const costOf = (n, size) => (n.pf >= 1 ? Infinity : (rttOf(n) + (size / (n.bw * MB)) * 1000) / (1 - n.pf));

const install = (n) => {
  S.alive.set(n.key, { h: n.id, p: 443, cc: "", ms: Math.round(n.probe + n.tls) });
  const s = W.STATS.nsGet(n.key);
  s.tcp = n.probe;
  s.tls = n.tls;
  s.at = NOW;
};

function reset() {
  NOW = Date.UTC(2026, 2, 1);
  rs = 7;
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
  W.STATS.invalidateRank();
  for (const n of NODES) install(n);
}

function cron() {
  for (const n of NODES) {
    if (NOW < n.born) continue;
    if (rnd() < n.pf * 0.4) W.STATS.nsProbeFail(n.key);
    else W.STATS.nsProbe(n.key, (n.probe + n.tls) * (0.95 + 0.1 * rnd()), n.probe, n.tls);
  }
  W.SEL.afterScan(ENV);
}

/* ---------- 跑一种模式 ---------- */
function run(mode, hours) {
  reset();
  const size = mode === "tput" ? 10 * MB : 0.2 * MB;
  const hits = new Map();
  const costSum = new Map();
  let reqs = 0, fails = 0, direct = 0, ratio = 0, best1 = 0;
  const live = () => NODES.filter((n) => NOW >= n.born);
  const oracle = () => Math.min(...live().map((n) => costOf(n, size)));

  for (let t = 0; t < hours * 3600; t++) {
    NOW += 1000;
    if (t % 1800 === 0) cron();
    if (t === 3600) install(byKey.get("new:443")); // 中途上新
    const k = W.SEL.pick(ENV, mode, { host: "" });
    const n = byKey.get(k);
    if (!n || NOW < n.born) {
      direct++;
      continue;
    }
    reqs++;
    hits.set(n.id, (hits.get(n.id) || 0) + 1);
    costSum.set(n.id, (costSum.get(n.id) || 0) + costOf(n, size));
    if (rnd() < n.pf) {
      W.SEL.bumpFail(ENV, mode, k, false);
      fails++;
    } else {
      const rtt = rttOf(n) * (0.95 + 0.1 * rnd());
      const dur = rtt + (size / (n.bw * MB)) * 1000 * (1 + (n.stall || 0));
      // 采样口径与线上一致：字节 / 墙钟（stall 也算在分母里）
      const bps = size / (dur / 1000);
      const w = Math.min(1, size / (512 * 1024)) * Math.min(1, dur / 1000);
      if (w > 0) W.STATS.nsSpeed(k, bps, size, ENV, Math.min(4, w));
      if (n.stall) W.STATS.nsStall(k, n.stall * dur, dur);
      W.STATS.nsOk(k, 0, 0);
      W.STATS.nsLatency(k, rtt);
    }
    ratio += costOf(n, size) / oracle();
    if (n.id === "fast") best1++;
  }
  return { mode, reqs, fails, direct, ratio, best1, hits, costSum, size };
}

const fmt = (s, n) => String(s).padEnd(n);
const pad = (s, n) => String(s).padStart(n);

for (const mode of ["lat", "tput"]) {
  const r = run(mode, Number(process.argv[2] || 3));
  const live = NODES.filter((n) => NOW >= n.born);
  const best = live.reduce((a, b) => (costOf(a, r.size) <= costOf(b, r.size) ? a : b));
  console.log(
    `\n【${mode} 模式】${process.argv[2] || 3} 小时 / ${r.reqs} 次经节点请求 / ${r.direct} 次无可用节点` +
      ` / 真·最优 = ${best.id}`,
  );
  console.log(
    fmt("节点", 9) + pad("真延迟", 7) + pad("真带宽", 7) + pad("真失败%", 8) + pad("算法看到", 9) + pad("估带宽", 7) +
      pad("估失败%", 7) + pad("被选%", 7) + pad("代价/最优", 10),
  );
  const rows = live
    .map((n) => {
      const s = W.STATS.nsGet(n.key);
      const p = W.scoreParts(n.key, mode);
      const h = r.hits.get(n.id) || 0;
      const c = h ? r.costSum.get(n.id) / h : 0;
      const capBps = mode === "tput" ? W.pcts(s).cap : 0;
      return {
        n,
        h,
        share: (h / Math.max(1, r.reqs)) * 100,
        lat: p.latencyMs,
        cap: capBps / MB,
        risk: p.pFailRisk * 100,
        c: h ? c / costOf(best, r.size) : 0,
      };
    })
    .sort((a, b) => costOf(a.n, r.size) - costOf(b.n, r.size));
  for (const x of rows) {
    console.log(
      fmt(x.n.id, 9) +
        pad(Math.round(rttOf(x.n)), 7) +
        pad(x.n.bw.toFixed(1), 7) +
        pad((x.n.pf * 100).toFixed(1), 8) +
        pad(Math.round(x.lat), 9) +
        pad(mode === "tput" ? x.cap.toFixed(1) : "-", 7) +
        pad(x.risk.toFixed(1), 7) +
        pad(x.share.toFixed(1), 7) +
        pad(x.h ? x.c.toFixed(2) + "x" : "-", 10),
    );
  }
  console.log(
    `合计：平均代价 ${(r.ratio / Math.max(1, r.reqs)).toFixed(2)}x（1.00 = 每次都选中真·最优）` +
      ` / 失败 ${((r.fails / Math.max(1, r.reqs)) * 100).toFixed(1)}%` +
      ` / 选中真最优 ${((r.best1 / Math.max(1, r.reqs)) * 100).toFixed(0)}%`,
  );
}
