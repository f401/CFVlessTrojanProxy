// 探活测量的抗噪实验：探活被瞬时拥塞抬高一截时，"再测一次"能把估计拉回来多少。
//   node test/mk_test.mjs && node tools/sim-probe.mjs
// 40 个节点 / 5 个 /24 / 每 30 分钟探一次 / 15% 概率遇到 4 倍抖动
import * as W from "../test/_bundle.mjs";

const SC = W.SC;

let NOW = Date.UTC(2026, 3, 1);
Date.now = () => NOW;
let rs = 5;
const rnd = () => {
  rs |= 0;
  rs = (rs + 0x6d2b79f5) | 0;
  let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = rnd;

const GROUPS = 5;
const PER = 8;
const nodes = [];
for (let g = 0; g < GROUPS; g++) {
  for (let i = 0; i < PER; i++) {
    const tcp = 40 + Math.round(rnd() * 160);
    nodes.push({ k: `10.0.${g}.${i + 1}:443`, h: `10.0.${g}.${i + 1}`, group: `10.0.${g}`, tcp, tls: 40 });
  }
}
const byKey = new Map(nodes.map((n) => [n.k, n]));
const trueMs = (n) => n.tcp + n.tls * 1.2;

const SPIKE_P = Number(process.env.SPIKE || 0.15);
const SPIKE_X = Number(process.env.SPIKE_X || 4);

function reset() {
  NOW = Date.UTC(2026, 3, 1);
  rs = 5;
  W.NODE_MEMORY.stats.clear();
  W.POOL_MEMORY.probeWhy = {};

  for (const n of nodes) {
    const s = W.NodeStatsTable.nsGet(n.k);
    s.at = NOW;
  }
}

function probe(n, strategy, round, queue) {
  const spike = rnd() < SPIKE_P ? SPIKE_X : 1;
  const ms = Math.round(trueMs(n) * spike * (0.9 + 0.2 * rnd()));
  W.NodeStatsTable.nsProbe(n.k, ms, ms * 0.75, ms * 0.25);
  if (strategy === "A") return;
  // B/C：比同 /24 中位数慢 3 倍以上（且 >250ms）→ 下一轮再测一次
  const peers = nodes.filter((x) => x.group === n.group).map((x) => W.NodeStatsTable.nsGet(x).tcp * 1.33).sort((a, b) => a - b);
  const med = peers[Math.floor(peers.length / 2)] || 0;
  if (ms > Math.max(3 * med, 250)) queue.push({ k: n.k, first: ms, round });
}

function applyRecheck(strategy, queue) {
  // 只处理"上一轮排进来"的
  const due = queue.filter((q) => q.round < roundNow);
  for (const q of due) {
    const n = byKey.get(q.k);
    if (!n) continue;
    const ms2 = Math.round(trueMs(n) * (rnd() < SPIKE_P ? SPIKE_X : 1) * (0.9 + 0.2 * rnd()));
    const v = strategy === "C" ? Math.min(q.first, ms2) : ms2;
    // C 想的是"取两次里更好的那个"，B 只是再测一次让 EWMA 自己往回收
    if (strategy === "C") W.NodeStatsTable.nsProbe(n.k, v, v * 0.75, v * 0.25);
    else W.NodeStatsTable.nsProbe(n.k, ms2, ms2 * 0.75, ms2 * 0.25);
  }
  for (const q of due) queue.splice(queue.indexOf(q), 1);
}

const fmt = (s, n) => String(s).padEnd(n);
const pad = (s, n) => String(s).padStart(n);

console.log(
  `探活抗噪：${nodes.length} 节点 / ${GROUPS} 个 /24 / 每 30 分钟一次 / ${(SPIKE_P * 100).toFixed(0)}% 概率 ${SPIKE_X}× 抖动\n`,
);
console.log(fmt("策略", 26) + pad("估计/真值", 10) + pad("高估>1.5x", 11) + pad("低估>1.5x", 11) + pad("平均误差", 10));

let roundNow = 0;
for (const strategy of ["A", "B", "C"]) {
  reset();
  const queue = [];
  // 48 轮 = 24 小时
  for (let r = 0; r < 48; r++) {
    roundNow = r;
    NOW += 1800 * 1000;
    if (strategy !== "A") applyRecheck(strategy, queue);
    for (const n of nodes) probe(n, strategy, r, queue);
  }
  const rows = nodes.map((n) => {
    const s = W.NodeStatsTable.nsGet(n.k);
    const est = s.tcp + s.tls * 1.2;
    return est / trueMs(n);
  });
  const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
  const over = rows.filter((x) => x > 1.5).length;
  const under = rows.filter((x) => x < 1 / 1.5).length;
  const err = rows.reduce((a, b) => a + Math.abs(b - 1), 0) / rows.length;
  const name = strategy === "A" ? "A 现状（只测一次）" : strategy === "B" ? "B 异常再测一次" : "C 再测一次取较小";
  console.log(fmt(name, 26) + pad(mean.toFixed(2), 10) + pad(over, 11) + pad(under, 11) + pad((err * 100).toFixed(1) + "%", 10));
}
