// 迁移风险：按 §17 的六步逐步打开，每一步预期指标怎么变、回滚线在哪
// node tools/exp-migration.mjs
//
// 每一步只加一件事，其余保持上一步的状态（与线上发版一致：一次只动一处）：
//   S0 现状（7.86）：没有事实层，全在本 isolate 内存里，选路靠本地统计
//   S1 只加事实层（eg / dns 进 DO），**选路不变**——纯地基，成功率的期望是「不变」
//   S2 选路开始用 eg 族偏置 + 共享 ps
//   S3 加 blk 硬过滤（单 (站点,中继) 90 分钟）
//   S4 加探测波次限流 + 冷启动 200ms 阻塞读
//   S5 客户端加 ?tu= 目标实测组（订阅侧，服务端不再变）
//
// 每步都统计「风险计数器」：空候选次数、回退 leastBad 次数、DO 读写量。

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

const CFG = {
  waves: 700,
  perWave: 3,
  coldRatio: 0.2,
  cacheHitCold: 0.7,
  baseMs: 2500,
  jitter: 600,
  blockedMs: 60,
  connectMs: 250,
  slots: 6,
  probeWave: 2,
  explore: 0.08,
  blkTtlWaves: 60, // 90 分钟 ≈ 5400 波；模型里压缩成 60 波（每波 1s）
};

const STEPS = ["S0", "S1", "S2", "S3", "S4", "S5"];
const FLAGS = {
  S0: { facts: false, useEg: false, usePs: false, blk: false, probeWave: false, coldRead: false, clientRace: false },
  S1: { facts: true, useEg: false, usePs: false, blk: false, probeWave: false, coldRead: false, clientRace: false },
  S2: { facts: true, useEg: true, usePs: true, blk: false, probeWave: false, coldRead: false, clientRace: false },
  S3: { facts: true, useEg: true, usePs: true, blk: true, probeWave: false, coldRead: false, clientRace: false },
  S4: { facts: true, useEg: true, usePs: true, blk: true, probeWave: true, coldRead: true, clientRace: false },
  S5: { facts: true, useEg: true, usePs: true, blk: true, probeWave: true, coldRead: true, clientRace: true },
};

function members() {
  const list = [];
  for (let i = 0; i < 3; i++) list.push({ id: `v4-${i}`, fam: 4, p: 1.0 });
  list.push({ id: "v4-reject", fam: 4, p: 0.125 });
  for (let i = 0; i < 4; i++) list.push({ id: `v6-${i}`, fam: 6, p: 0.125 });
  return list;
}

function run(step, seed) {
  const F = FLAGS[step];
  const r = rng(seed);
  const list = members();
  const ps = new Map();
  const blk = new Map(); // "site|id" -> 过期波次
  const eg = new Map(list.map((m) => [m.id, m.fam])); // S1 起才有（这里恒有，但只有 useEg 时才读）

  const slotFree = new Array(CFG.slots).fill(0);
  const takeSlot = (t) => {
    let i = 0;
    for (let j = 1; j < slotFree.length; j++) if (slotFree[j] < slotFree[i]) i = j;
    const st = Math.max(t, slotFree[i]);
    slotFree[i] = st + CFG.connectMs;
    return st + CFG.connectMs;
  };

  const psOf = (id) => ps.get(id) || { q: 128, n: 0 };
  const psNote = (id, ok) => {
    const s = psOf(id);
    const decay = 0.98;
    s.n = Math.min(255, s.n * decay + 1);
    s.q = Math.min(255, Math.max(0, Math.round((s.q * (s.n - 1) + (ok ? 255 : 0)) / s.n)));
    ps.set(id, s);
  };

  const lat = [];
  const okLat = [];
  let okN = 0;
  let good = 0;
  let emptyCand = 0;
  let leastBad = 0;
  let doReads = 0;
  let doWrites = 0;
  let t = 0;

  for (let w = 0; w < CFG.waves; w++) {
    t += 1000;
    const cold = r() < CFG.coldRatio;

    // 冷 isolate：S4 起会为读事实阻塞最多 200ms（且 70% 命中缓存）
    let readPenalty = 0;
    if (F.facts && cold) {
      const hit = r() < CFG.cacheHitCold;
      if (!hit) doReads++;
      if (F.coldRead && !hit) readPenalty = Math.min(200, 15 + Math.floor(r() * 185));
    }

    let probes = 0;
    for (let i = 0; i < CFG.perWave; i++) {
      let now = t + readPenalty;

      // S4 起探测按波次限流；之前每条未知都探
      const unknown = cold && !(F.facts && r() < CFG.cacheHitCold);
      const canProbe = F.probeWave ? probes < CFG.probeWave : true;
      if (unknown && canProbe) {
        probes++;
        now = takeSlot(now);
      } else {
        now = takeSlot(now);
      }

      // 硬过滤（S3 起）
      let pool = list;
      if (F.blk) {
        const alive = list.filter((m) => !((blk.get(`site|${m.id}`) || 0) > w));
        if (!alive.length) {
          emptyCand++;
          pool = list; // leastBad：宁可回到全量，也不返回空
          leastBad++;
        } else {
          pool = alive;
        }
      }

      // 排序
      let cands = pool;
      if (F.useEg || F.usePs) {
        const score = (m) => {
          const prior = eg.get(m.id) === 4 ? 0.95 : 0.5;
          if (!F.usePs) return prior;
          const q = psOf(m.id).q / 255;
          return q * 0.6 + prior * 0.4;
        };
        cands = [...pool].sort((a, b) => score(b) - score(a)).slice(0, 3);
      }

      const explore = r() < CFG.explore;
      const m = explore ? pool[Math.floor(r() * pool.length)] : cands[Math.floor(r() * cands.length)];
      const pass = r() < m.p;

      if (F.usePs) {
        psNote(m.id, pass);
        doWrites++;
      }

      // S3 起：tiny + 单批就记 blk（简化：连续 2 次失败才记，模拟"两批 ≥60s"）
      if (F.blk && !pass) {
        const k = `site|${m.id}`;
        const prev = blk.get(`${k}|n`) || 0;
        blk.set(`${k}|n`, prev + 1);
        if (prev + 1 >= 2) blk.set(k, w + CFG.blkTtlWaves);
      }
      if (F.blk && pass) blk.set(`site|${m.id}|n`, 0);

      const jit = Math.round((r() * 2 - 1) * CFG.jitter);
      const total = now - t + (pass ? CFG.baseMs + jit : CFG.blockedMs);
      lat.push(total);
      if (pass) {
        okN++;
        okLat.push(total);
        if (total <= 3000) good++;
      }
    }
  }

  lat.sort((a, b) => a - b);
  okLat.sort((a, b) => a - b);
  const q = (arr, x) => arr[Math.min(arr.length - 1, Math.floor(x * arr.length))];
  return {
    rate: okN / lat.length,
    p95: q(lat, 0.95),
    p95ok: q(okLat, 0.95),
    good3s: good / lat.length,
    emptyCand,
    leastBad,
    doReads,
    doWrites,
  };
}

const seeds = [11, 22, 33, 44, 55, 66, 77, 88];
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`${CFG.waves} 波 × ${CFG.perWave} 条 / 冷 ${CFG.coldRatio * 100}% / blk TTL ${CFG.blkTtlWaves} 波 / 8 种子中位\n`);
console.log("步骤  成功率   good3s   p95ok   空候选  leastBad  DO读  DO写");
const rows = {};
for (const step of STEPS) {
  const runs = seeds.map((s) => run(step, s));
  const row = {
    rate: med(runs.map((x) => x.rate)),
    good3s: med(runs.map((x) => x.good3s)),
    p95ok: med(runs.map((x) => x.p95ok)),
    emptyCand: med(runs.map((x) => x.emptyCand)),
    leastBad: med(runs.map((x) => x.leastBad)),
    doReads: med(runs.map((x) => x.doReads)),
    doWrites: med(runs.map((x) => x.doWrites)),
  };
  rows[step] = row;
  console.log(
    `${step}   ${(row.rate * 100).toFixed(1).padStart(5)}%  ${(row.good3s * 100).toFixed(1).padStart(6)}%  ${String(row.p95ok).padStart(5)}  ${String(row.emptyCand).padStart(6)}  ${String(row.leastBad).padStart(6)}  ${String(row.doReads).padStart(5)}  ${String(row.doWrites).padStart(5)}`,
  );
}

console.log("\n逐步增量（成功率 / good3s）：");
for (let i = 1; i < STEPS.length; i++) {
  const a = rows[STEPS[i - 1]];
  const b = rows[STEPS[i]];
  const d = (x, y) => `${((y - x) * 100 >= 0 ? "+" : "") + ((y - x) * 100).toFixed(1)}`;
  console.log(`  ${STEPS[i - 1]} → ${STEPS[i]}: ${d(a.rate, b.rate)} pt / ${d(a.good3s, b.good3s)} pt`);
}

const bad = [];
if (!(Math.abs(rows.S1.rate - rows.S0.rate) < 0.06)) bad.push("S1（只加事实层、选路不变）成功率不应变化超过 6 个点");
if (!(rows.S2.rate > rows.S1.rate + 0.3)) bad.push("S2（开始用 eg+ps）应带来大幅提升");
if (!(rows.S3.rate >= rows.S2.rate - 0.05)) bad.push("S3（加 blk 硬过滤）不应让成功率明显下降");
if (!(rows.S3.leastBad >= 0)) bad.push("leastBad 计数应存在");
if (!(rows.S4.p95ok <= rows.S3.p95ok + 60)) bad.push("S4（探测限流+冷启动阻塞读）不应明显拖慢成功请求");
if (!(rows.S5.rate >= rows.S4.rate - 0.02)) bad.push("S5（客户端竞速组）不应让服务端指标下降");
if (bad.length) {
  console.log("\nFAIL:");
  for (const b of bad) console.log("  -", b);
  process.exit(1);
}
console.log("\n断言通过");
