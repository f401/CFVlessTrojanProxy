// v8 端到端验收仿真：node tools/exp-v8sim.mjs [--sweep]
// 把 §13/§21/§22/§28 的实测输入代回去，看四套策略在「每 isolate 只跑 3 条连接」下的差别。
// 也可被 tools/exp-coldstart.mjs 以 import 方式复用（simulate()）。

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

export const BASE = {
  isolates: 4000,
  seed: 20261115,
  conns: 3,
  relays: 8,
  v4Relays: 3, // 37.5%
  pFail: 0.02,
  defect: 0.25, // 「族对但站点拒」
  coldHit: 0.7, // colo 缓存命中率
  coldMissFacts: 0.6, // 未命中时 DO 读能否在预算内回来
  blockMs: 200, // §20.2 冷启动可阻塞上限
  blockPage: 737,
  bigPage: 45000,
  apiPage: 1277,
  pLogin: {
    "x-like": { 4: 1.0, 6: 0.125 },
    "v4-only": { 4: 1.0, 6: 0.0 },
    normal: { 4: 0.99, 6: 0.98 },
    "api-like": { 4: 1.0, 6: 0.98 },
  },
};

function world(cfg) {
  const r = rng(cfg.seed);
  const relays = Array.from({ length: cfg.relays }, (_, i) => ({
    ip: `10.0.0.${i + 1}`,
    fam: i < cfg.v4Relays ? 4 : 6,
    defect: r() < cfg.defect,
  }));
  return { r, relays };
}

function hit(cfg, relay, site, r) {
  if (r() < cfg.pFail) return { down: 0 };
  const p = site === "x-like" && relay.defect ? cfg.pLogin[site][6] : cfg.pLogin[site][relay.fam];
  if (r() < p) return { down: site === "api-like" ? cfg.apiPage : cfg.bigPage };
  return { down: site === "x-like" ? cfg.blockPage : 0 };
}

function pick(cfg, policy, ctx, site, r) {
  const { alive, eg, blk, ps, localPs } = ctx;
  const usable = policy === "v8" ? alive.filter((x) => !blk.has(site + "|" + x.ip)) : alive;
  const list = usable.length ? usable : alive;
  if (policy === "A") return { ip: list[Math.floor(r() * list.length)].ip };

  const price = (ip) => {
    const prior = eg.get(ip) === 4 ? 0.95 : 0.5;
    if (policy === "B") return -prior;
    const s = (policy === "v8" ? ps : localPs).get(site + "|" + ip);
    return -(s && s.n >= 2 ? s.q / 255 : prior);
  };
  let best = list[0];
  for (const x of list.slice(1)) if (price(x.ip) < price(best.ip)) best = x;
  if (r() < 0.08) best = list[Math.floor(r() * list.length)];
  return { ip: best.ip };
}

/** 跑一个策略；over 覆盖 BASE 里的任意字段（返回比率，0–1） */
export function simulate(policy, over = {}) {
  const cfg = { ...BASE, ...over };
  const { r, relays } = world(cfg);
  const shared = { eg: new Map(relays.map((x) => [x.ip, x.fam])), ps: new Map(), blk: new Map() };
  const sites = Object.keys(cfg.pLogin);
  const stat = Object.fromEntries(sites.map((s) => [s, { n: 0, try: 0, page: 0, coldN: 0, coldPage: 0, isoPage: 0, iso: 0 }]));

  for (let i = 0; i < cfg.isolates; i++) {
    const site = sites[i % sites.length];
    const alive = relays.slice(0, 6);
    const cold = i % 5 === 0;
    // 冷启动：缓存命中 → 直接有事实；未命中 → 只有 blockMs 足够（≥200ms）且掷中 coldMissFacts 才有
    const miss = cfg.coldMissFacts * Math.min(1, cfg.blockMs / 200);
    const got = cold ? r() < cfg.coldHit || r() < miss : true;
    const view = got ? shared : { eg: new Map(), ps: new Map(), blk: new Map() };
    const localPs = new Map();
    const st = stat[site];
    let isoOk = true;

    for (let k = 0; k < cfg.conns; k++) {
      const c = pick(cfg, policy, { alive, eg: view.eg, ps: view.ps, blk: view.blk, localPs }, site, r);
      const res = hit(cfg, relays.find((x) => x.ip === c.ip), site, r);
      st.n++;
      if (cold) st.coldN++;
      const ok = res.down > 0 && res.down !== cfg.blockPage;
      if (res.down > 0) st.try++;
      if (ok) {
        st.page++;
        if (cold) st.coldPage++;
      } else isoOk = false;

      const key = site + "|" + c.ip;
      const bump = (map) => {
        const cur = map.get(key) || { q: 127, n: 0 };
        map.set(key, { q: Math.round((cur.q * cur.n + (ok ? 255 : 0)) / (cur.n + 1)), n: Math.min(255, cur.n + 1) });
      };
      bump(localPs);
      if (policy === "v8") {
        bump(shared.ps);
        if (site === "x-like" && res.down === cfg.blockPage) shared.blk.set(key, 1);
      }
    }
    st.iso++;
    if (isoOk) st.isoPage++;
  }

  const out = { policy, sites: {}, xIso: stat["x-like"].isoPage / stat["x-like"].iso };
  for (const s of sites) {
    const st = stat[s];
    out.sites[s] = { try: st.try / st.n, page: st.page / st.n, coldPage: st.coldN ? st.coldPage / st.coldN : 0 };
  }
  return out;
}

export function runAll(over = {}) {
  return ["A", "B", "C", "v8"].map((p) => simulate(p, over));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/exp-v8sim.mjs");
if (isMain) {
  const results = runAll();
  const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";
  console.log("策略    x-like首连   x-like整条   x-like冷启动   v4-only   normal   api-like");
  for (const r of results) {
    const s = r.sites;
    console.log(
      `${r.policy.padEnd(6)} ${pct(s["x-like"].page)}      ${pct(r.xIso)}      ${pct(s["x-like"].coldPage)}        ` +
        `${pct(s["v4-only"].page)}   ${pct(s["normal"].page)}   ${pct(s["api-like"].page)}`
    );
  }

  const g = (p, s) => results.find((x) => x.policy === p).sites[s].page;
  const bad = [];
  if (!(g("A", "x-like") > 0.3 && g("A", "x-like") < 0.6)) bad.push(`A 应落在 30–60%，实际 ${pct(g("A", "x-like"))}`);
  if (!(g("B", "x-like") < g("A", "x-like"))) bad.push("B（只看族且确定性）应不比盲选好");
  if (!(Math.abs(g("C", "x-like") - g("A", "x-like")) < 0.15)) bad.push("C（本地 ps）应与盲选接近");
  if (!(g("v8", "x-like") > 0.9)) bad.push(`v8 应 > 90%，实际 ${pct(g("v8", "x-like"))}`);
  if (!(g("v8", "x-like") > g("C", "x-like") + 0.4)) bad.push("v8 应比 C 高 40 点以上");
  if (!(g("v8", "normal") > g("A", "normal") - 0.03)) bad.push("v8 不能伤到普通站点");
  if (!(g("v8", "api-like") > 0.97)) bad.push("v8 不能把业务 4xx 当成失败");
  if (bad.length) { console.log("\nFAIL:"); for (const b of bad) console.log("  -", b); process.exit(1); }
  console.log("\n断言通过");
}
