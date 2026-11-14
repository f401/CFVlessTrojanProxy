// 冷 isolate 的并发撞车：facts 读、connect 名额、首字节延迟
// node tools/exp-concurrency.mjs
//
// 模型（离散事件，单位 ms）：
//   - K 条用户连接在 100 ms 内陆续到达一个**冷** isolate
//   - facts 读：DO 单实例串行 15 ms/次；colo 缓存命中 2 ms
//   - connect 名额：全局 6 个并发，每次 connect 250 ms（探测/拨号）
//   - 每条连接：读 facts（或跳过）→ 选出口 → 若选中的是「未知」中继则要 connect → 首字节
// 对比四种策略：
//   A 每条连接各自读 facts（无 single-flight）
//   B single-flight（同 isolate 共享一次读）+ 200 ms 预算
//   C single-flight + 不阻塞（后台读）
//   D B + 探测并发上限 2（其余连接直接用事实里的结论，不 probe）

const CFG = {
  arrivalsMs: 100,
  doServiceMs: 15,
  cacheHitMs: 2,
  cacheHitRate: 0.7,
  connectMs: 250,
  connectSlots: 6,
  readBudgetMs: 200,
  probesPerConn: 1, // 选中「未知」中继时需要 1 次 connect
};

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** 单实例串行队列：返回「本次服务结束时刻」 */
function makeQueue(serviceMs) {
  let freeAt = 0;
  return (startAt) => {
    const st = Math.max(startAt, freeAt);
    freeAt = st + serviceMs;
    return freeAt;
  };
}

function run(K, mode, seed) {
  const r = rng(seed);
  const arrivals = Array.from({ length: K }, () => r() * CFG.arrivalsMs).sort((a, b) => a - b);
  const doQ = makeQueue(CFG.doServiceMs);

  // 共享一次读（single-flight）
  let shared = null; // { start, done }
  const cacheHit = r() < CFG.cacheHitRate;
  const readCost = cacheHit ? CFG.cacheHitMs : CFG.doServiceMs;

  // connect 名额：用「最早空出的 6 个槽」模拟
  const slots = new Array(CFG.connectSlots).fill(0);
  const takeSlot = (startAt) => {
    let i = 0;
    for (let j = 1; j < slots.length; j++) if (slots[j] < slots[i]) i = j;
    const st = Math.max(startAt, slots[i]);
    slots[i] = st + CFG.connectMs;
    return slots[i];
  };

  const lat = [];
  let probes = 0;
  for (const a of arrivals) {
    let t = a;

    if (mode === "A") {
      // 每条连接各读一次（DO 串行）
      t = cacheHit ? t + CFG.cacheHitMs : doQ(t);
    } else if (mode === "B" || mode === "D") {
      if (!shared) {
        const start = t;
        const done = cacheHit ? start + CFG.cacheHitMs : doQ(start);
        shared = { start, done };
      }
      // 只有第一波连接等这次读，且最多等 readBudgetMs
      const waitUntil = Math.min(shared.done, t + CFG.readBudgetMs);
      t = Math.max(t, waitUntil);
    } else if (mode === "C") {
      if (!shared) shared = { start: t, done: t + readCost };
      // 不等待：直接往下走
    }

    // 选中「未知」中继 → 需要一次 connect
    const needProbe = r() < 0.35; // 冷 isolate 里约 1/3 的连接落到未知出口
    if (needProbe) {
      if (mode === "D") {
        if (probes < 2) {
          probes++;
          t = takeSlot(t);
        }
        // 超预算就退化成「按事实排序里最稳的那条」，不再 probe
      } else {
        probes++;
        t = takeSlot(t);
      }
    }

    // 首字节固定开销（TLS/HTTP）不做建模，只比较相对差异
    lat.push(t - a);
  }

  lat.sort((x, y) => x - y);
  const pick = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];
  return { p50: pick(0.5), p95: pick(0.95), max: lat[lat.length - 1], probes };
}

const seeds = Array.from({ length: 12 }, (_, i) => (i + 1) * 104729);
const modes = ["A", "B", "C", "D"];
const Ks = [1, 5, 20, 40];

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log(`配置：${CFG.connectSlots} 个 connect 名额 / 每次 ${CFG.connectMs}ms / DO 串行 ${CFG.doServiceMs}ms / 缓存命中 ${CFG.cacheHitRate * 100}% / 读预算 ${CFG.readBudgetMs}ms\n`);
console.log("并发  A(各自读) p50/p95    B(single-flight)      C(不阻塞)             D(B+探测≤2)");
const table = {};
for (const K of Ks) {
  const row = [];
  for (const mode of modes) {
    const rs = seeds.map((s) => run(K, mode, s));
    const p50 = med(rs.map((x) => x.p50));
    const p95 = med(rs.map((x) => x.p95));
    table[`${K}:${mode}`] = { p50, p95 };
    row.push(`${p50.toFixed(0).padStart(4)}/${p95.toFixed(0).padStart(4)}`);
  }
  console.log(`${String(K).padStart(3)}   ${row.join("          ")}`);
}

const bad = [];
for (const K of [20, 40]) {
  if (!(table[`${K}:B`].p50 < table[`${K}:A`].p50)) bad.push(`K=${K}: single-flight 应当优于各自读`);
  if (!(table[`${K}:D`].p95 <= table[`${K}:B`].p95 + 5)) bad.push(`K=${K}: 探测限流不应让 p95 变差`);
}
if (!(table[`40:A`].p95 > 300)) bad.push("40 并发下「各自读」的 p95 应当明显超过 300ms（否则模型没有撞车）");
if (!(table[`40:B`].p50 <= CFG.readBudgetMs + 5)) bad.push("single-flight 下 p50 应当被读预算兜住");
if (bad.length) {
  console.log("\nFAIL:");
  for (const b of bad) console.log("  -", b);
  process.exit(1);
}
console.log("\n断言通过");
