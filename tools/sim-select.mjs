// 节点选择的"地面真值"仿真：批量伪造节点（真实延迟/失败率/带宽/卡顿/探活撒谎），
// 用真实的 pick / region / bumpFail / nsProbe / nsSpeed 跑，最后和上帝视角对比。
//   用法：node test/mk_test.mjs && node tools/sim-select.mjs [小时数]
//   环境变量：SEEDS=3、SEED0=1、ONLY=名字、BUNDLE=另一份 bundle 路径（A/B 用）、FAIL/H_LAT_REL/TRIAL_LAT... 覆盖 SC
// 默认读 test/_bundle.mjs；BUNDLE 可指向 .tmp-sim/bundle-base.mjs 之类的旧构建，省得反复 stash + 重建。
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = await import(process.env.BUNDLE ? pathToFileURL(resolve(process.env.BUNDLE)).href : "../test/_bundle.mjs");

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

if (process.env.FAIL) W.SC.FAIL = Number(process.env.FAIL);
if (process.env.H_LAT_REL) W.SC.H_LAT_REL = Number(process.env.H_LAT_REL);
if (process.env.BETA_A) W.SC.BETA_A = Number(process.env.BETA_A);
if (process.env.BETA_B) W.SC.BETA_B = Number(process.env.BETA_B);
if (process.env.TS_BETA !== undefined) W.SC.TS_BETA = Number(process.env.TS_BETA);
if (process.env.TS_BAND !== undefined) W.SC.TS_BAND = Number(process.env.TS_BAND);
if (process.env.TS_SD_MIN !== undefined) W.SC.TS_SD_MIN = Number(process.env.TS_SD_MIN);
if (process.env.TS_EXTRA !== undefined) W.SC.TS_EXTRA = Number(process.env.TS_EXTRA);
if (process.env.TS_K !== undefined) W.SC.TS_K = Number(process.env.TS_K);
if (process.env.JIT_W !== undefined) W.SC.JIT_W = Number(process.env.JIT_W);
if (process.env.REAL_W !== undefined) W.SC.REAL_W = Number(process.env.REAL_W);
if (process.env.FAILSCALE !== undefined) W.SC.FAIL_SCALE = Number(process.env.FAILSCALE);
if (process.env.TSHIER !== undefined) W.SC.TS_HIER = Number(process.env.TSHIER);

const ENV = { pxDwellMin: 0, pxShadow: process.env.PXSHADOW === undefined ? 0.05 : Number(process.env.PXSHADOW), pxSchedH: 6 };

/* 备选：失败率只做门槛，排序只看可测量（延迟/吞吐） */
if (process.env.RANK === "raw") {
  const gate = Number(process.env.GATE || 0.02);
  W.SEL.pick = (_env, mode) => {
    const list = W.CANDS.list(mode);
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
    const list = W.CANDS.list(mode).filter((r) => {
      const a = W.NODE_MEMORY.alive.get(r.k);
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
    return W.NODE_MEMORY.alive.get(best) || null;
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
  W.SEL.pick = (_env, mode) => draw(W.CANDS.list(mode).slice(0, K));
  W.SEL.region = async (_env, cc, mode, avoid = "") => {
    const want = String(cc || "").toUpperCase();
    if (!want) return null;
    const list = W.CANDS.list(mode)
      .filter((r) => {
        const a = W.NODE_MEMORY.alive.get(r.k);
        return a && String(a.cc || "").toUpperCase() === want && r.k !== avoid;
      })
      .slice(0, K);
    const k = draw(list);
    if (!k) return null;
    const a = W.NODE_MEMORY.alive.get(k);
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

// 真实规模的池子：一个明确的王者（60ms/0.5%）+ 大量平庸节点（100~400ms，失败率 2~5%，带宽 1~20MB/s）
function poolOf(n) {
  return [N("b0", 60, 0.005, 14), ...fillers(n - 1, (i) => N("b" + (i + 1), 100 + ((i * 53) % 300), 0.02 + ((i * 29) % 4) * 0.01, 1 + ((i * 17) % 20)))];
}

// 更贴近真的 IP 池：延迟挤在 60~200ms（大部分 90~130），失败率长尾（多数 1~6%，少数 0.2%），
// 带宽 2~24MB/s。探活值和真实值一致（不撒谎），只有 1~2 个明确的赢家。
function realPool(n) {
  const out = [N("r0", 62, 0.004, 18), N("r1", 78, 0.006, 22), N("r2", 55, 0.012, 9)];
  for (let i = 3; i < n; i++) {
    const lat = 60 + ((i * 97) % 90) + ((i * 31) % 7) * 6;
    const pf = i % 17 === 0 ? 0.002 + ((i * 7) % 40) / 10000 : 0.008 + ((i * 13) % 55) / 1000;
    out.push(N("r" + i, lat, pf, 2 + ((i * 19) % 23)));
  }
  return out;
}

// 线上 cronScan 会把 alive 裁到 800：按探活延迟留最快的 800 个
function trimmedPool(n, keep) {
  return poolOf(n)
    .sort((a, b) => a.tcp - b.tcp)
    .slice(0, keep);
}

// 跨模式池：A 低延迟窄带、B 中等、C 均衡、D 高延迟宽带 —— lat 的 64KB 最优是 A，tput 的 16MB 最优是 D
function crossPool() {
  return [N("A", 60, 0.004, 2), N("B", 120, 0.004, 20), N("C", 90, 0.004, 8), N("D", 300, 0.004, 40)];
}

// 并发场景的池子：失败率压到 0.1%（高请求率下 2% 的池子会被失败阶梯拉黑），
// 带宽从 2MB/s 到 40MB/s 分层，单节点吃不下需求，只有"按容量分摊"才是最优。
function concPool() {
  return [N("q1", 60, 0.001, 2), N("q2", 70, 0.001, 4), N("q3", 80, 0.001, 8), N("q4", 90, 0.001, 20), N("q5", 100, 0.001, 20), N("q6", 160, 0.001, 40)];
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
const junkPool = (n, deadPct) => {
  const arr = poolOf(n);
  const deadN = Math.floor(n * deadPct);
  for (let i = n - deadN; i < n; i++) {
    arr[i].pFail = 1;
    arr[i].dead = true;
  }
  return arr;
};
const shufflePool = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const scenarios = [
  /* 池子规模 */
  { group: "规模", name: "1 节点", pool: () => [N("s0", 60, 0.005, 12)], mode: "lat" },
  { group: "规模", name: "5 节点", pool: () => [N("s0", 60, 0.005, 12), ...fillers(4, (i) => N("s" + (i + 1), 120 + i * 40, 0.01 + i * 0.01, 6))], mode: "lat" },
  { group: "规模", name: "20 节点", pool: basePool, mode: "lat" },
  { group: "规模", name: "100 节点", pool: bigPool, mode: "lat", hours: 8 },
  { group: "规模", name: "300 节点", pool: () => [N("b0", 60, 0.005, 14), ...fillers(299, (i) => N("b" + (i + 1), 100 + ((i * 53) % 300), 0.02 + ((i * 29) % 4) * 0.01, 1 + ((i * 17) % 20)))], mode: "lat", hours: 8 },
  // 线上真实规模：池子 1k~2k 条，但 cronScan 会把 alive 裁到 800。先看 800 的稳态，再看不裁的 2000。
  { group: "规模", name: "800 节点", pool: () => poolOf(800), mode: "lat", hours: 8 },
  { group: "规模", name: "2000 节点", pool: () => poolOf(2000), mode: "lat", hours: 8 },
  { group: "规模", name: "3000 节点", pool: () => poolOf(3000), mode: "lat", hours: 8 },
  { group: "规模", name: "2000 节点 12/s", pool: () => poolOf(2000), mode: "lat", hours: 6, rate: 12 },
  { group: "规模", name: "3000 节点 12/s", pool: () => poolOf(3000), mode: "lat", hours: 6, rate: 12 },
  { group: "规模", name: "3000 节点 60/s", pool: () => poolOf(3000), mode: "lat", hours: 4, rate: 60 },
  { group: "规模", name: "3000 池留 800", pool: () => trimmedPool(3000, 800), mode: "lat", hours: 8 },
  { group: "规模", name: "1000 真实画像", pool: () => realPool(1000), mode: "lat", hours: 8 },
  { group: "规模", name: "2000 池留 800", pool: () => trimmedPool(2000, 800), mode: "lat", hours: 8 },

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
  // S 参数化：同一池子里"低延迟窄带"与"高延迟宽带"各有胜场，只有换了 sz 才该换节点
  { group: "流量", name: "交互 64KB", pool: () => [N("lo", 60, 0.005, 2), N("hi", 120, 0.005, 20)], mode: "lat", sz: 65536, hours: 6 },
  { group: "流量", name: "批量 16MB", pool: () => [N("lo", 60, 0.005, 2), N("hi", 120, 0.005, 20)], mode: "lat", sz: 16777216, hours: 6 },
  // 并发场景：6 个节点、失败率 0.1%（否则 2 个节点在 8/s 下会被失败阶梯长期拉黑，
  // 场景退化成"选不到节点"）。需求 12×2MB=24MB/s 已经超过单节点最大带宽，最优解是分摊。
  { group: "并发", name: "12/s 2MB", pool: concPool, mode: "tput", sz: 2097152, rate: 12, conc: true },
  { group: "并发", name: "12/s 256KB", pool: concPool, mode: "lat", sz: 262144, rate: 12, conc: true },
  { group: "并发", name: "2/s 2MB", pool: concPool, mode: "tput", sz: 2097152, rate: 2, conc: true },

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

  /* 跨模式：低延迟节点（A）与大带宽节点（D）是两套最优，两种模式必须各选各的 */
  { group: "跨模式", name: "lat 64KB 选低延迟", pool: crossPool, mode: "lat", sz: 65536, hours: 6 },
  { group: "跨模式", name: "tput 16MB 选大带宽", pool: crossPool, mode: "tput", sz: 16777216, hours: 6 },

  /* 覆盖速度：2000 个候选，冷启动只有 200 个在池里，其余靠 cron 每轮探到 scanMax 个 */
  { group: "覆盖", name: "2000 冷启动 120/轮", pool: () => shufflePool(poolOf(2000)), mode: "lat", hours: 4, discover: { online: 200, scanMax: 120 } },
  { group: "覆盖", name: "2000 冷启动 300/轮", pool: () => shufflePool(poolOf(2000)), mode: "lat", hours: 4, discover: { online: 200, scanMax: 300 } },
  { group: "覆盖", name: "2000 冷启动 500/轮", pool: () => shufflePool(poolOf(2000)), mode: "lat", hours: 4, discover: { online: 200, scanMax: 500 } },
  { group: "覆盖", name: "2000 冷启动 400/轮", pool: () => shufflePool(poolOf(2000)), mode: "lat", hours: 4, discover: { online: 200, scanMax: 400 } },
  { group: "覆盖", name: "2000 冷启动 800/轮", pool: () => shufflePool(poolOf(2000)), mode: "lat", hours: 4, discover: { online: 200, scanMax: 800 } },
  { group: "覆盖", name: "2000 冷启动 全量", pool: () => shufflePool(poolOf(2000)), mode: "lat", hours: 4, discover: { online: 200, scanMax: 2000 } },

  /* 垃圾比例：95% 的候选探不通，看跳过死候选能不能把探测预算省给活候选 */
  { group: "覆盖", name: "2000 冷启动 95%垃圾 不跳过", pool: () => shufflePool(junkPool(2000, 0.95)), mode: "lat", hours: 8, discover: { online: 100, scanMax: 400, junkSkip: false } },
  { group: "覆盖", name: "2000 冷启动 95%垃圾 跳过", pool: () => shufflePool(junkPool(2000, 0.95)), mode: "lat", hours: 8, discover: { online: 100, scanMax: 400, junkSkip: true } },
  { group: "覆盖", name: "2000 冷启动 48/轮", pool: () => shufflePool(poolOf(2000)), mode: "lat", hours: 8, discover: { online: 200, scanMax: 48 } },
  { group: "覆盖", name: "2000 冷启动 48/轮 95%垃圾 跳过", pool: () => shufflePool(junkPool(2000, 0.95)), mode: "lat", hours: 8, discover: { online: 100, scanMax: 48, junkSkip: true } },
];

/* ---------- 状态 ---------- */
const byKey = new Map();
let pool = [];
/* 并发模型（只对 sc.conc 场景生效）：节点是一条带宽水管，忙到什么时刻 + 当前在途条数 */
let CONC = false;
let universe = [];
let pending = [];
let dcur = 0;
let probeN = 0;
const busyUntil = new Map();
const qn = new Map();

function reset() {
  NOW = T0;
  W.NODE_MEMORY.alive.clear();
  W.NODE_MEMORY.stats.clear();
  W.HOSTS.nodes.clear();
  W.HOSTS.direct.clear();
  W.NODE_MEMORY.rankCache.clear();
  W.SELECTION_MEMORY.current = { lat: "", tput: "" };
  W.SELECTION_MEMORY.previous = { lat: "", tput: "" };
  W.SELECTION_MEMORY.switchedAt = { lat: 0, tput: 0 };
  W.SELECTION_MEMORY.switches = { lat: [], tput: [] };
  W.NODE_MEMORY.inflight.clear();

  W.NODE_MEMORY.candidateCount = 0;
  W.SELECTION_MEMORY.failCount = 0;
  W.SELECTION_MEMORY.failSeen = 0;

  byKey.clear();
}

function addNode(n) {
  W.NODE_MEMORY.alive.set(n.key, { h: n.id, p: 443, cc: n.cc, ms: n.probeTcp + n.tls });
  const s = W.NodeStatsTable.nsGet(n.key);
  s.tcp = n.probeTcp;
  s.tls = n.tls;
  s.at = NOW;
  byKey.set(n.key, n);
}

const rttOf = (n) => n.tcp + n.tls * 1.2;
function trueCost(n, mode, bytes = 0) {
  if (n.pFail >= 1) return Infinity;
  const sz = bytes > 0 ? bytes : mode === "tput" ? 10 * MB : 0.2 * MB;
  const work = (sz / Math.max(1, n.bw * MB * (1 - n.stall))) * 1000;
  return (rttOf(n) + work) / (1 - n.pFail);
}

async function request(n, mode, burst, jitter, bytes = 0) {
  const pf = burst ? 1 : n.burstOnly ? 0 : n.pFail;
  if (rnd() < pf) {
    await W.SEL.bumpFail(ENV, mode, n.key, false);
    return -1;
  }
  const rtt = rttOf(n) * (jitter ? 1 + (rnd() - 0.5) * jitter : 1);
  const szR = bytes > 0 ? bytes : mode === "tput" ? 10 * MB : 0.2 * MB;
  const work = (szR / Math.max(1, n.bw * MB * (1 - n.stall))) * 1000;
  const dur = rtt + work;
  // CONC：把节点当成一条"带宽水管"排队。服务时间 = 传输时间，排队等待 = 前面还有几条请求。
  // 只有开了 conc 的场景才记账，其余场景的基线与上一轮完全可比。
  let wait = 0;
  if (CONC) {
    const start = Math.max(NOW, busyUntil.get(n.key) || 0);
    wait = start - NOW;
    busyUntil.set(n.key, start + work);
    qn.set(n.key, (qn.get(n.key) || 0) + 1);
    // 生产里 Connection 一连上就 syncInflight，同一 tick 内的后续请求能看到排队变化；
    // 只在 tick 开始时重建会让 12/s 场景的 12 个请求全看到 q=0、全挤同一个节点。
    if (CONC) W.NODE_MEMORY.inflight.set(n.key, qn.get(n.key) || 0); // 只有并发场景才有"在途"语义
  }
  // STALLFIX：把背压时间从采样分母里扣掉（模拟"只算真正在传的时间"）
  const stallMs = process.env.STALLFIX ? n.stall * dur : 0;
  // 吞吐样本要按"纯传输窗口"算：生产的采样窗口是首字节之后每 512KB 一次，ttfb 不进分母。
  // 早先把整个 dur（含 rtt）当分母，等于系统性低估高延迟节点的带宽（D: 40MB/s 被测成 21MB/s），
  // 16MB 批量场景因此永远选不中真正的大带宽节点。
  const tx = Math.max(dur * 0.4, dur - stallMs - rtt);
  const bps = szR / (tx / 1000);
  const w = Math.min(1, szR / (512 * 1024)) * Math.min(1, dur / 1000);
  if (w > 0) W.NodeStatsTable.nsSpeed(n.key, bps, szR, ENV, Math.min(4, w));
  // 和生产一致：runMs 记"所有连接"的时长（早先只记卡过的那条，pStall 分母被缩成几百毫秒）
  W.NodeStatsTable.nsStall(n.key, n.stall > 0 ? n.stall * dur : 0, dur);
  W.NodeStatsTable.nsOk(n.key, 0, 0);
  W.NodeStatsTable.nsLatency(n.key, rtt + wait); // 真实首字节回流（排队时间也算进 ttfb）
  return wait;
}

function cron(sc) {
  if (pending.length) {
    // 轮转游标 + 可选的"垃圾候选跳过"：死候选第一次探失败后从待发现列表删掉，不再占下一轮名额
    // （对应生产的 S.probeBad 本地记忆 + SCAN_BAD_MAX）。
    const skip = !!sc.discover.junkSkip;
    let taken = 0;
    while (taken < sc.discover.scanMax && pending.length) {
      if (dcur >= pending.length) dcur = 0;
      const n = pending[dcur];
      taken++;
      probeN++;
      if (n.dead) {
        if (skip) pending.splice(dcur, 1);
        else dcur++;
        continue;
      }
      pending.splice(dcur, 1);
      pool.push(n);
      addNode(n);
    }
  }
  for (const n of pool) {
    if (rnd() < n.pFail * 0.4) W.NodeStatsTable.nsProbeFail(n.key);
    else {
      const j = 0.9 + rnd() * 0.2;
      const pj = sc.probeJitter ? 0.4 + rnd() * 1.2 : 1;
      W.NodeStatsTable.nsProbe(n.key, (n.probeTcp * pj + n.tls) * j, n.probeTcp * pj * j, n.tls * j);
    }
  }
  W.SEL.afterScan(ENV);
}

/* ---------- 跑一个场景（一个种子） ---------- */
async function run(sc, hours, seedVal) {
  seed = seedVal;
  reset();
  CONC = !!sc.conc;
  busyUntil.clear();
  qn.clear();
  W.NODE_MEMORY.inflight.clear();
  pool = sc.pool();
  universe = pool;
  pending = [];
  if (sc.discover) {
    // 冷启动覆盖：只有 online 个候选在池里，其余靠 cron 每轮"探到" scanMax 个。
    const on = Math.min(sc.discover.online, pool.length);
    pending = pool.slice(on);
    dcur = 0;
    probeN = 0;
    pool = pool.slice(0, on);
  }
  for (const n of pool) addNode(n);
  const mode = sc.mode;
  const szB = sc.sz || 0; // 目标流量（字节）：验证 scoreParts 的 S 参数化

  const scoped = () => (sc.region ? universe.filter((n) => n.cc === sc.region) : universe);
  let best = null;
  let oracle = Infinity;
  let reliable = Infinity;
  const recompute = () => {
    oracle = Infinity;
    best = null;
    for (const n of scoped()) {
      const c = trueCost(n, mode, szB);
      if (c < oracle) {
        oracle = c;
        best = n;
      }
    }
  };
  for (const n of scoped()) if (n.pFail > 0 && n.pFail <= 0.05) reliable = Math.min(reliable, trueCost(n, mode, szB));
  recompute();

  const rate = sc.rate || 1;
  const ticks = hours * 3600;
  let reqs = 0, fails = 0, direct = 0, costSum = 0, ratioSum = 0, bad = 0, top1 = 0, optHits = 0, nearHits = 0;
  let switches = 0, lastCurs = "", regionFail = 0;
  const dscope = new Map();
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
        W.NODE_MEMORY.alive.delete(sc.eventDel);
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

    // 并发场景：把"还在传的请求"折成 W.NODE_MEMORY.inflight，和生产的 Connection.syncInflight 同口径
    if (CONC) {
      for (const [k, t] of busyUntil) if (t <= NOW) { busyUntil.delete(k); qn.delete(k); }
      W.NODE_MEMORY.inflight.clear();
      for (const [k, cnt] of qn) if (cnt > 0) W.NODE_MEMORY.inflight.set(k, cnt);
    }
    const nReq = Math.floor(rate) + (rnd() < rate - Math.floor(rate) ? 1 : 0);
    for (let q = 0; q < nReq; q++) {
      let key = "";
      if (sc.region) {
        const x = await W.SEL.region(ENV, sc.region, mode);
        key = x ? x.h + ":" + x.p : "";
      } else {
        key = W.SEL.pick(ENV, mode, { host: "", sz: szB });
      }
      const cur = W.SELECTION_MEMORY.current[mode];
      if (cur && cur !== lastCurs) {
        switches++;
        lastCurs = cur;
      }
      if (process.env.TRACE && reqs < Number(process.env.TRACE)) {
        const parts = [...byKey.values()].map((x) => {
          const p = W.scoreParts(x.key, mode, Date.now(), false, szB);
          return x.id + ": v=" + p.score.toFixed(0) + " e10=" + p.e10Ms.toFixed(0) + " L=" + p.latencyMs.toFixed(0) +
            " cap=" + Math.round(p.capBps / 1024) + "KB confB=" + p.confB.toFixed(2) + " n=" + p.n.toFixed(0);
        });
        console.error("[trace t=" + t + "] picked=" + (key || "<empty>") + " | " + parts.join(" | "));
      }
      const n = byKey.get(key);
      if (!n) {
        if (process.env.DBG) {
          const kk = key || "<empty>";
          dscope.set(kk, (dscope.get(kk) || 0) + 1);
        }
        if (sc.region) regionFail++;
        else direct++;
        continue;
      }
      reqs++;
      const waited = await request(n, mode, n.burst, sc.jitter, szB);
      if (waited < 0) fails++;
      const c = trueCost(n, mode, szB) + (waited > 0 ? waited : 0);
      const ratio = Number.isFinite(oracle) && oracle > 0 && Number.isFinite(c) ? c / oracle : 1;
      costSum += Number.isFinite(c) ? c : Number.isFinite(oracle) ? oracle * 2 : 1e6;
      if (Number.isFinite(oracle) && Math.abs(c - oracle) <= oracle * 1e-9) optHits++;
      if (ratio <= 1.02) nearHits++;
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

  if (process.env.DUMP) {
    const rows = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log("[dump]", sc.name, rows.map(([k, v]) => `${k}:${v}(cost=${Math.round(W.costOf(k, mode))},cap=${Math.round((W.NodeStatsTable.nsGet(k).capBps||0)/1024)}KB,n=${Math.round(W.NodeStatsTable.nsGet(k).okW||0)})`).join(" "));
  }
  ratios.sort((a, b) => a - b);
  if (process.env.DBG && dscope.size) {
    console.error("[dscope]", [...dscope].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(" "), "alive=" + W.NODE_MEMORY.alive.size);
  }
  return {
    name: sc.name,
    mode,
    reqs,
    failPct: (fails / Math.max(1, reqs)) * 100,
    directPct: (direct / Math.max(1, reqs + direct)) * 100,
    regionFailPct: (regionFail / Math.max(1, reqs + regionFail + direct)) * 100,
    meanRatio: ratioSum / Math.max(1, reqs),
    optPct: (optHits / Math.max(1, reqs)) * 100,
    nearPct: (nearHits / Math.max(1, reqs)) * 100,
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
    covered: W.NODE_MEMORY.alive.size,
    probes: probeN,
    total: universe.length,
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

if (process.env.LIST) { scenarios.forEach((x, i) => console.log(i + "\t" + x.name)); process.exit(0); }
const list = process.env.ONLY_AT
  ? scenarios.filter((_, i) => String(i) === process.env.ONLY_AT)
  : process.env.ONLY
    ? scenarios.filter((x) => x.name.includes(process.env.ONLY))
    : scenarios;
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
    optPct: mean(rs.map((r) => r.optPct)),
    nearPct: mean(rs.map((r) => r.nearPct)),
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
    covered: rs[0].covered,
    probes: mean(rs.map((r) => r.probes || 0)),
    total: rs[0].total,
  };
  rows.push(row);
  const optTxt = row.optPct.toFixed(0) + "%/" + row.nearPct.toFixed(0) + "%";
  console.log(
    p(row.name, 14) + p(row.mode, 5) + p(Math.round(row.reqs), 8) + p(row.failPct.toFixed(1), 7) +
      p((row.regionFailPct > row.directPct ? row.regionFailPct : row.directPct).toFixed(0) + "%", 7) +
      p(`${row.meanRatio.toFixed(2)}x (${row.lo.toFixed(2)}-${row.hi.toFixed(2)})`, 18) +
      p(row.p95.toFixed(1) + "x", 7) + p(row.badPct.toFixed(0) + "%", 7) +
      p(row.tailTopPct.toFixed(0) + "%", 7) + p(optTxt, 6) + row.swPerH.toFixed(1),
  );
}

console.log("\n事件/细节：");
for (const r of rows) {
  const extra = [];
  if (r.leaveEvent) extra.push(`事件后 ${r.leaveEvent} 离开，旧节点仍占 ${r.onEventPct.toFixed(0)}%`);
  if (r.reuse) extra.push(`${r.reuse} 后重新用上`);
  if (r.regionFailPct > 0) extra.push(`1011 失败 ${r.regionFailPct.toFixed(0)}%`);
  if (r.name.includes("撒谎")) extra.push(`撒谎节点吃 ${r.fakeShare.toFixed(0)}%`);
  if (r.total) extra.push(`覆盖 ${r.covered}/${r.total}，探活 ${r.probes}`);
  extra.push(`上帝 ${Number.isFinite(r.oracle) ? Math.round(r.oracle) : "∞"}ms / 本算法 ${Math.round(r.meanCost)}ms`);
  console.log(`- ${r.name}: ${extra.join("；")}`);
}
