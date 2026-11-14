/**
 * exp-403safe.mjs —— v8「业务 403 绝不被误伤」的验收原型（纯内存，不碰 src/）。
 *
 * 把 v8 文档 §3.2 的 commitFact、§5 的排序链（含 8% 探索与每 20 条康复通道）、
 * §15 的「blk 只降权不排除 + p 下限 0.25 + dead 是唯一硬排除」写成最小可执行模型，
 * 灌入对抗性流量，跑 A1–A7。
 *
 * 跑法：node tools/exp-403safe.mjs
 */

const TTL_DEAD = 30 * 60_000;
const TTL_BLK = 90 * 60_000;
const TINY_ABS = 2048;
const TINY_REL = 0.2;
const BIG_PEER = 20_000;
const P_FLOOR = 0.25;
const BLK_MULT = 6;
const CONFIRM_GAP = 60_000;
const EXPLORE = 0.08;

let seed = 7;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

class V8 {
  constructor(relays, opts = {}) {
    this.relays = relays;
    this.hardBlk = Boolean(opts.hardBlk); // true = 旧设计（blk 硬排除），只用于对照实验
    this.p = new Map(relays.map((r) => [r.id, 0.95]));
    this.ok = new Map(relays.map((r) => [r.id, 0]));
    this.bad = new Map(relays.map((r) => [r.id, 0]));
    this.deadAt = new Map();
    this.blkAt = new Map();
    this.batches = new Map();
    this.bigTypical = new Map();
    this.blkRows = new Map(); // host -> Set(ip)：活着的 blk 行
    this.bizSweeps = 0; // 全池被写 -> 判为站点级、清空的行数
    this.muteUntil = new Map(); // host -> 抑制 blk 写入的截止时间
    this.picks = [];
    this.leastBad = 0;
    this.deadFromBiz = 0;
    this.minPUsed = 1;
    this.minCandidates = 99;
  }

  /** §3.2 写入闸门：只看结构量，命中即返回。 */
  commit(o) {
    if (o.connErr) {
      this.deadAt.set(o.ip, o.t + TTL_DEAD);
      if (o.status) this.deadFromBiz++; // 带状态码却写 dead = 违约
      return;
    }
    if (o.status === 429) return;
    if (o.status >= 400 && !o.hasBigPeer) return; // 站点级：弃权

    const bt = this.bigTypical.get(o.host);
    const isBig = o.down >= BIG_PEER; // D15：没有基线时只有 >=20KB 才算「大」
    if (isBig) this.bigTypical.set(o.host, Math.max(bt || 0, o.down));

    const tiny = bt === undefined ? false : o.down > 0 && o.down <= TINY_ABS && o.down < TINY_REL * bt;

    if (tiny && o.hasBigPeer) {
      const [lastAt, n] = this.batches.get(o.ip) || [0, 0];
      const fresh = o.t - lastAt >= CONFIRM_GAP;
      const cnt = fresh ? n + 1 : n;
      this.batches.set(o.ip, [fresh ? o.t : lastAt, cnt]);
      if (cnt >= 3 && (this.muteUntil.get(o.host) || 0) <= o.t) {
        this.blkAt.set(o.ip, o.t + TTL_BLK);
        const set = this.blkRows.get(o.host) || new Set();
        set.add(o.ip);
        this.blkRows.set(o.host, set);
      }
      this.bad.set(o.ip, this.bad.get(o.ip) + 1);
    } else if (o.down > 0) {
      this.ok.set(o.ip, this.ok.get(o.ip) + 1);
    }

    const ok = this.ok.get(o.ip);
    const bad = this.bad.get(o.ip);
    const n = Math.min(32, 8 + ok + bad);
    const q = (ok + 4 * 0.95) / (ok + bad + 4);
    this.p.set(o.ip, Math.max(P_FLOOR, Math.min(1, (q * n + 0.95 * 4) / (n + 4))));
  }

  /** 全池几乎都被写 blk = 更像端点级业务 403，判为站点级并清空（可自愈、有界）。 */
  maybeSweep(host, cands, t) {
    const set = this.blkRows.get(host);
    if (!set || !set.size) return;
    const need = Math.max(3, Math.ceil(0.75 * cands));
    if (set.size < need) return;
    for (const ip of set) this.blkAt.delete(ip);
    set.clear();
    this.bizSweeps++;
    this.muteUntil.set(host, t + 30 * 60_000);
  }

  rank(t) {
    const alive = this.relays.filter(
      (r) => (this.deadAt.get(r.id) || 0) <= t && !(this.hardBlk && (this.blkAt.get(r.id) || 0) > t),
    );
    this.minCandidates = Math.min(this.minCandidates, Math.max(1, alive.length));
    return alive
      .map((r) => {
        const p = Math.max(P_FLOOR, this.p.get(r.id));
        this.minPUsed = Math.min(this.minPUsed, p);
        const blk = (this.blkAt.get(r.id) || 0) > t ? BLK_MULT : 1;
        return { r, score: (r.cost * blk) / p };
      })
      .sort((a, b) => a.score - b.score || (a.r.id < b.r.id ? -1 : 1));
  }

  choose(t) {
    const list = this.rank(t);
    if (!list.length) {
      // leastBad：全 dead 也要发出去（真实实现里直连永远可选）
      this.leastBad++;
      const r = [...this.relays].sort(
        (x, y) => (this.deadAt.get(x.id) || 0) - (this.deadAt.get(y.id) || 0),
      )[0];
      this.picks.push(r.id);
      return r;
    }
    let chosen;
    if (rnd() < EXPLORE) chosen = list[Math.floor(rnd() * list.length)].r; // 8% 探索
    else if (this.picks.length % 20 === 19) chosen = list[list.length - 1].r; // 康复通道
    else chosen = list[0].r;
    this.picks.push(chosen.id);
    return chosen;
  }
}

function maxRun(arr) {
  let best = 1;
  let cur = 1;
  for (let i = 1; i < arr.length; i++) {
    cur = arr[i] === arr[i - 1] ? cur + 1 : 1;
    if (cur > best) best = cur;
  }
  return best;
}

/** blocked(relayIndex) 返回该条连接的观测。 */
function run(name, host, n, blocked, hard = false) {
  const relays = Array.from({ length: 8 }, (_, i) => ({ id: `10.0.0.${i + 1}`, cost: 100 + i }));
  const v8 = new V8(relays, { hardBlk: hard });
  let t = 1_700_000_000_000;
  let responses = 0;
  let firstPage = 0;

  for (let i = 0; i < n; i++) {
    t += 5_000;
    const r = v8.choose(t);
    const idx = relays.indexOf(r);
    const o = blocked(idx, i);
    if (o) {
      v8.commit({ ...o, ip: r.id, host, t });
      v8.maybeSweep(host, relays.length, t);
      if (o.down > 0) responses++;
      if (o.down >= 4096) firstPage++;
    }
  }
  return {
    name,
    n,
    responses,
    firstPageRate: firstPage / n,
    deadAll: v8.deadAt.size,
    deadFromBiz: v8.deadFromBiz,
    minP: v8.minPUsed,
    minCandidates: v8.minCandidates,
    blk: v8.blkAt.size,
    blkRowsLeft: [...v8.blkRows.values()].reduce((a, s) => a + s.size, 0),
    bizSweeps: v8.bizSweeps,
    leastBad: v8.leastBad,
    maxConsecutive: maxRun(v8.picks),
  };
}

const cases = [];

// S0 预热：站点此前正常（建立 bigTypical），之后全部小 403（端点级业务 403）
cases.push(
  run("S1 纯业务 403（300B + 每 5 条一次 45KB）", "api.example.com", 400, (_idx, i) =>
    i % 5 === 0
      ? { down: 45_000, status: 200, hasBigPeer: true }
      : { down: 300, status: 403, hasBigPeer: true },
  ),
);

// S2 业务 4xx 带完整页面（GitHub 415/1277B 那类）
cases.push(
  run("S2 业务 4xx 带完整页面（1277B）", "api.example.com", 400, () => ({
    down: 1277,
    status: 415,
    hasBigPeer: true,
  })),
);

// S3 全池真封锁（737B 封锁页）—— 无法救，但不许崩、要写 blk
cases.push(
  run("S3 全池 737B 封锁页", "x.example", 400, (_idx, i) =>
    i === 0 ? { down: 45_000, status: 200, hasBigPeer: true } : { down: 737, status: 403, hasBigPeer: true },
  ),
);

// S4 部分封锁：3 条中继被封，5 条正常 —— 核心场景
cases.push(
  run("S4 3/8 中继被 737B 封锁", "x.example", 400, (idx, i) =>
    i === 0
      ? { down: 45_000, status: 200, hasBigPeer: true }
      : idx < 3
        ? { down: 737, status: 403, hasBigPeer: true }
        : { down: 45_000, status: 200, hasBigPeer: true },
  ),
);

// S4h 同一场景、旧设计（blk 硬排除）—— 只用来量「软化让出多少成功率」
cases.push(
  run(
    "S4h 同场景（blk 硬排除，仅对照）",
    "x.example",
    400,
    (idx, i) =>
      i === 0
        ? { down: 45_000, status: 200, hasBigPeer: true }
        : idx < 3
          ? { down: 737, status: 403, hasBigPeer: true }
          : { down: 45_000, status: 200, hasBigPeer: true },
    true,
  ),
);

// S5 连接层失败混合（唯一合法的 dead 来源）
cases.push(
  run("S5 连接失败 + 业务 403 混合", "api.example.com", 400, (_idx, i) =>
    i % 37 === 0 ? { connErr: true } : { down: 300, status: 403, hasBigPeer: true },
  ),
);

console.log(
  "场景".padEnd(32),
  "响应",
  "firstPage",
  "dead",
  "业务写dead",
  "minP",
  "minCand",
  "blk",
  "leastBad",
  "连选",
);
for (const c of cases) {
  console.log(
    c.name.padEnd(30),
    String(c.responses).padStart(4),
    (c.firstPageRate * 100).toFixed(1).padStart(8) + "%",
    String(c.deadAll).padStart(5),
    String(c.deadFromBiz).padStart(9),
    c.minP.toFixed(3).padStart(6),
    String(c.minCandidates).padStart(7),
    String(c.blk).padStart(4),
    String(c.bizSweeps).padStart(4),
    String(c.leastBad).padStart(8),
    String(c.maxConsecutive).padStart(4),
  );
}

const fails = [];
const check = (label, cond) => cond || fails.push(label);
const [s1, s2, s3, s4, , s5] = cases; // cases[4] 是对照组 S4h
const s4h = cases[4];

// A1 永不返回空候选
for (const c of cases) check(`A1 候选数 >=1（${c.name}: ${c.minCandidates}）`, c.minCandidates >= 1);
// A2 业务响应永不写 dead
for (const c of cases) check(`A2 业务不写 dead（${c.name}: ${c.deadFromBiz}）`, c.deadFromBiz === 0);
// A3 业务 4xx 从不移除候选 —— blk 写了也不移除，所以候选数恒为 8（S1/S2）
check(`A3 业务 403 场景候选恒 8（${s1.minCandidates}）`, s1.minCandidates === 8);
check(`A3 业务 4xx 场景候选恒 8（${s2.minCandidates}）`, s2.minCandidates === 8);
// A4 p 下限
for (const c of cases) check(`A4 p >= 0.25（${c.name}: ${c.minP.toFixed(3)}）`, c.minP >= P_FLOOR - 1e-9);
// A5 纯业务 403 站：全部拿到响应（透传），且没有锁死在一条中继上
check("A5 纯业务 403 透传 100%", s1.responses === s1.n);
check(`A5 纯业务 403 不锁死（连选 ${s1.maxConsecutive}）`, s1.maxConsecutive <= 8);
// A6 部分封锁场景：仍能拿到真页面 >= 90%
check(`A6 3/8 封锁时 firstPage >= 90%（${(s4.firstPageRate * 100).toFixed(1)}%）`, s4.firstPageRate >= 0.9);
// A7 局部封锁场景 blk 真的写出来了（否则 A3 是空转）
check(`A7 局部封锁写了 blk 且没被误清（S4 ${s4.blkRowsLeft} 行）`, s4.blkRowsLeft > 0 && s4.bizSweeps === 0);
// A9 全池被写 = 站点级：自愈清空 + 该 host 静默，不再写 blk
check(`A9 全池被写触发自愈（S1 sweeps=${s1.bizSweeps} 残留=${s1.blkRowsLeft} / S3 sweeps=${s3.bizSweeps}）`,
  s1.bizSweeps >= 1 && s1.blkRowsLeft === 0 && s3.bizSweeps >= 1);
// A11 软化的代价有上限：仍 >=90%，且比硬排除多让出不超过 6 个点

check(`A11 软化后 firstPage >= 90%（${(s4.firstPageRate * 100).toFixed(1)}%）`, s4.firstPageRate >= 0.9);
check(
  `A11 软化的代价 <= 6 点（软 ${(s4.firstPageRate * 100).toFixed(1)}% vs 硬 ${(s4h.firstPageRate * 100).toFixed(1)}%）`,
  s4h.firstPageRate >= s4.firstPageRate && s4h.firstPageRate - s4.firstPageRate <= 0.06,
);

// A10 自愈不能误伤「真的只有少数几条被封」的场景
check(`A10 3/8 封锁不触发自愈（S4 sweeps=${s4.bizSweeps}）`, s4.bizSweeps === 0);
// A8 leastBad 只由 dead 触发
check(`A8 leastBad 只由 dead 触发且真的被用到（S1 ${s1.leastBad} / S5 ${s5.leastBad}）`, s1.leastBad === 0 && s5.leastBad > 0);

console.log("\n断言：", fails.length ? "FAIL" : "全部通过");
for (const f of fails) console.log("  ✗", f);
process.exit(fails.length ? 1 : 0);
