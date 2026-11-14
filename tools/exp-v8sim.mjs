// v8 端到端验收仿真：node tools/exp-v8sim.mjs
// 把 §13/§21/§22/§28 的实测输入代回去，看四套策略在「每 isolate 只跑 3 条连接」下的差别。
// 关键约束（都来自实测，不是假设）：
//   · 每次部署 / 低频流量 ⇒ isolate 很短命，所以「本地统计」几乎学不到东西（§22 仿真 C≈B）
//   · 冷 isolate 只有拿到共享事实（eg/ps/blk）才可能一次就选对（§20.2 / §28）
//   · 8 条中继里 3 条 v4 出口（§13.6），x 类站点 v4≈1.0 / v6≈0.125（§13.8）

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
  isolates: 4000,
  conns: 3,
  relays: 8,
  v4Relays: 3,          // 37.5%
  pFail: 0.02,          // 中继偶发连不上
  coldHit: 0.7,         // colo 缓存命中率（§21：Cache 命中 2ms）
  coldMissFacts: 0.6,   // 未命中缓存时，DO 读能否在 200ms 内回来
  pLogin: {
    "x-like": { 4: 1.0, 6: 0.125 },
    "v4-only": { 4: 1.0, 6: 0.0 },
    normal: { 4: 0.99, 6: 0.98 },
    "api-like": { 4: 1.0, 6: 0.98 },
  },
  blockPage: 737,       // x 的封锁页（§13.7）
  bigPage: 45000,
  apiPage: 1277,        // 业务 4xx 的完整响应
};

function world(seed) {
  const r = rng(seed);
  const relays = Array.from({ length: CFG.relays }, (_, i) => ({
    ip: `10.0.0.${i + 1}`,
    fam: i < CFG.v4Relays ? 4 : 6,
    // 隐藏缺陷：出口族是 v4，但这条中继对某些站点仍被拒（§13.6 的 193.181：同出口 2/5）
    defect: r() < 0.25,
  }));
  return { r, relays };
}

function hit(relay, site, r) {
  if (r() < CFG.pFail) return { down: 0 };
  // 有缺陷的中继：v4 也按 v6 的概率通过（这是「族先验」学不到、只有 ps 能学到的东西）
  const p = site === "x-like" && relay.defect ? CFG.pLogin[site][6] : CFG.pLogin[site][relay.fam];
  if (r() < p) return { down: site === "api-like" ? CFG.apiPage : site === "x-like" ? CFG.bigPage : site === "normal" ? CFG.bigPage : CFG.bigPage };
  return { down: site === "x-like" ? CFG.blockPage : 0 };
}

function hitDirect(site, r) {
  // 直连腿：客户端 v4 时出口大概率 v4（§19.3）
  const fam = r() < 0.9 ? 4 : 6;
  const p = CFG.pLogin[site][fam];
  if (r() < p) return { down: site === "api-like" ? CFG.apiPage : CFG.bigPage };
  return { down: site === "x-like" ? CFG.blockPage : 0 };
}

/** A 盲选 / B 只看出口族 / C 出口族 + 本地 ps / v8 出口族 + 共享 ps + 共享 blk */
function pick(policy, ctx, site, r) {
  const { alive, eg, blk, ps, localPs } = ctx;
  const usable = policy === "v8" ? alive.filter((x) => !blk.has(site + "|" + x.ip)) : alive;
  const list = usable.length ? usable : alive;
  if (policy === "A") return { kind: "relay", ip: list[Math.floor(r() * list.length)].ip };

  const price = (ip) => {
    const p =
      policy === "v8"
        ? (() => { const s = ps.get(site + "|" + ip); return s && s.n >= 2 ? s.q / 255 : eg.get(ip) === 4 ? 0.95 : 0.5; })()
        : policy === "C"
          ? (() => { const s = localPs.get(site + "|" + ip); return s && s.n >= 2 ? s.q / 255 : eg.get(ip) === 4 ? 0.95 : 0.5; })()
          : (eg.get(ip) === 4 ? 0.95 : 0.5);
    return -p;
  };
  let best = list[0];
  // price 返回 -p（越大越好），所以比较方向必须是「更小更优」
  for (const x of list.slice(1)) if (price(x.ip) < price(best.ip)) best = x;
  if (r() < 0.08) best = list[Math.floor(r() * list.length)];   // 探索
  return { kind: "relay", ip: best.ip };
}

function run(policy, seed) {
  const { r, relays } = world(seed);
  const shared = { eg: new Map(relays.map((x) => [x.ip, x.fam])), ps: new Map(), blk: new Map() };
  const sites = Object.keys(CFG.pLogin);
  const stat = {};
  for (const s of sites) stat[s] = { n: 0, try: 0, page: 0, coldPage: 0, coldN: 0 };

  for (let i = 0; i < CFG.isolates; i++) {
    const site = sites[i % sites.length];
    const alive = relays.slice(0, 6);
    const cold = i % 5 === 0;                       // 20% 冷 isolate
    const got = cold ? r() < CFG.coldHit || r() < CFG.coldMissFacts : true;
    const view = got ? shared : { eg: new Map(), ps: new Map(), blk: new Map() };
    const localPs = new Map();

    for (let k = 0; k < CFG.conns; k++) {
      const c = pick(policy, { alive, eg: view.eg, ps: view.ps, blk: view.blk, localPs }, site, r);
      const res = c.kind === "direct" ? hitDirect(site, r) : hit(relays.find((x) => x.ip === c.ip), site, r);
      const st = stat[site];
      st.n++;
      if (cold) { st.coldN++; }
      if (res.down > 0) {
        st.try++;
        if (res.down !== CFG.blockPage) {
          st.page++;
          if (cold) st.coldPage++;
        }
      }
      // 学习：本地一定记；v8 额外写共享（blk 只在封锁页时）
      if (c.kind === "relay") {
        const key = site + "|" + c.ip;
        const okk = res.down > 0 && res.down !== CFG.blockPage;
        const bump = (map) => {
          const cur = map.get(key) || { q: 127, n: 0 };
          map.set(key, { q: Math.round((cur.q * cur.n + (okk ? 255 : 0)) / (cur.n + 1)), n: Math.min(255, cur.n + 1) });
        };
        bump(localPs);
        if (policy === "v8") {
          bump(shared.ps);
          if (site === "x-like" && res.down === CFG.blockPage) shared.blk.set(key, 1);
        }
      }
    }
  }

  const out = { policy, sites: {} };
  for (const s of sites) {
    const st = stat[s];
    out.sites[s] = {
      try: st.try / st.n,
      page: st.page / st.n,
      coldPage: st.coldN ? st.coldPage / st.coldN : 0,
    };
  }
  return out;
}

const results = ["A", "B", "C", "v8"].map((p) => run(p, 20261115));
const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";
console.log("策略    x-like首连命中   x-like冷启动   v4-only   normal   api-like   （口径：拿到非封锁页）");
for (const r of results) {
  const s = r.sites;
  console.log(
    `${r.policy.padEnd(6)} ${pct(s["x-like"].page)}          ${pct(s["x-like"].coldPage)}        ` +
      `${pct(s["v4-only"].page)}   ${pct(s["normal"].page)}   ${pct(s["api-like"].page)}`
  );
}

// 断言：把「实测已经证明过的结论」写成期望，而不是写我们希望的数字
const g = (p, s) => results.find((x) => x.policy === p).sites[s].page;
const bad = [];
if (!(g("A", "x-like") > 0.3 && g("A", "x-like") < 0.6)) bad.push(`A 盲选应落在 30–60%，实际 ${pct(g("A", "x-like"))}`);
// §21：只用族先验、且确定性地钉一条，遇到「族对但站点拒」的中继会比盲选更差
if (!(g("B", "x-like") < g("A", "x-like"))) bad.push("B（只看出口族且确定性选择）应不比盲选更好，否则说明缺陷中继没建模进去");
// §22：本地统计在 3 条连接的 isolate 里学不到东西 ⇒ 应接近盲选
if (!(Math.abs(g("C", "x-like") - g("A", "x-like")) < 0.15)) bad.push("C（本地 ps）应与盲选接近");
if (!(g("v8", "x-like") > 0.9)) bad.push(`v8 应 > 90%，实际 ${pct(g("v8", "x-like"))}`);
if (!(g("v8", "x-like") > g("C", "x-like") + 0.4)) bad.push("v8 应比 C 高 40 个点以上（共享 ps 的价值）");
if (!(g("v8", "normal") > g("A", "normal") - 0.03)) bad.push("v8 不能伤到普通站点");
if (!(g("v8", "api-like") > 0.97)) bad.push("v8 不能把业务 4xx 当成失败");
if (!(g("v8", "v4-only") > 0.9)) bad.push("v8 对无 AAAA 的站点也不该退化");
if (bad.length) { console.log("\nFAIL:"); for (const b of bad) console.log("  -", b); process.exit(1); }
console.log("\n断言通过");
