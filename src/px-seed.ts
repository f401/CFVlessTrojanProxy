import { SC } from "./const";
import { PX_TTL, SEED_KEY, SEED_MAX, SEED_TTL, SEED_VER, cnt, cntDelta } from "./px";
import { costOf, nsGet, p90Local , ZERO_STAT } from "./px-score";
import { S } from "./state";
import { kvGet, kvSet } from "./store";

/* 代理节点：信誉表分桶读写 */
/* ---- seed：按机房分桶 ---- */
// 认知边界：cron 跑在哪个机房是未知的，所以它只写"候选名单"桶（BUCKET_DEF），
// 不写延迟/吞吐统计 —— 否则又是跨机房污染。服务 isolate 只写自己那桶。
export const BUCKET_DEF = "*";

/** 当前写入的桶名 */
export class SeedStore {
coloKey() { return S.colo || BUCKET_DEF; }

/** 当前机房的信誉桶 */
bucket() {
  const m = (S.seed && S.seed.byColo) || {};
  return m[this.coloKey()] || { nodes: [] };
}

/** 把一条统计压成可存的形状 */
packNode(k: any) {
  const s = (S.nstat.get(k) || ZERO_STAT);
  const a = (S.alive.get(k) || {}) as NodeEntry;
  const i = k.lastIndexOf(":");
  const n = (s.okW || 0) + (s.failW || 0);
  return {
    k,
    h: a.h || k.slice(0, i),
    p: a.p || (Number(k.slice(i + 1)) || 443),
    cc: a.cc || "",
    ms: Math.round(a.ms || s.msLocal || SC.P_TCP),
    tcp: Math.round(s.tcp || 0),
    tls: Math.round(s.tls || 0),
    n: Math.round(n),
    f: Math.round((s.failW || 0) * 10) / 10,
    b: Math.round(p90Local(s) || 0),
    at: s.at || 0,
  };
}

/** 只存"名字"（cron 用：不知道自己在哪个机房，就不该写延迟） */
packName(k: any) {
  const a = (S.alive.get(k) || {}) as NodeEntry;
  const i = k.lastIndexOf(":");
  return { k, h: a.h || k.slice(0, i), p: a.p || (Number(k.slice(i + 1)) || 443), cc: a.cc || "", ms: Math.round(a.ms || 0) || undefined };
}

/** 把存下来的形状合并回本地统计（只增不减） */
unpackNode(o: any) {
  if (!o || !o.k) return;
  const s = nsGet(o.k);
  if (!s.tcp && o.tcp) s.tcp = o.tcp;
  if (!s.tls && o.tls) s.tls = o.tls;
  if (!s.msLocal && o.ms) s.msLocal = o.ms;
  const nn = o.n != null ? o.n : ((o.ok || 0) + (o.fail || 0));
  if (!(s.okW + s.failW) && nn) {
    const ff = o.f != null ? o.f : (o.fail || 0);
    s.okW = Math.max(0, nn - ff);
    s.failW = ff;
  }
  if (o.b > 0 && !(s.seedBps > 0) && !(s.bytesDown > 0)) {
    s.seedBps = Math.min(o.b, 8 * 1048576);        // 只作为"参考值"，不进直方图
    s.bytesDown = SC.MIN_BYTES;                    // 让它有资格进 tput 排名
  }
  if (o.at && !s.at) s.at = o.at;
}

/**
 * 读信誉表（30 分钟缓存）。v2 单表结构会迁移成 byColo 分桶。
 * @param {object} env Worker 环境
 * @returns {Promise<object>} SEED
 */
async read(env: Env) {
  if (S.seedAt && Date.now() - S.seedAt < SEED_TTL) return S.seed;
  let v = null;
  try { v = await kvGet<Seed>(env, SEED_KEY); } catch (e: any) {}
  if (v && Array.isArray(v.nodes) && !v.byColo) {
    // 旧结构：整张表属于"当前机房"，迁移时不做跨机房假设
    v = { v: SEED_VER, ts: v.ts || 0, poolGen: v.poolGen || 0, poolN: v.poolN || 0, builtAt: v.builtAt || 0, byColo: { [S.colo || "??"]: { nodes: v.nodes, ts: v.ts || 0 } } };
  }
  if (v && v.byColo && (v.v || 2) < SEED_VER) {
    // v<4：早期的 b 是用 1 秒窗口算的，会把突发缓冲当成带宽（实测虚高到 32 MB/s），全部作废
    for (const b of Object.values(v.byColo) as SeedBucket[]) {
      for (const n of b.nodes || []) { delete n.b; delete n.tcp; delete n.tls; }
    }
  }
  if (v && v.byColo) {
    S.seed = {
      v: SEED_VER,
      ts: v.ts || 0,
      poolGen: v.poolGen || 0,
      poolN: v.poolN || 0,
      builtAt: v.builtAt || 0,
      byColo: v.byColo || {},
      cnt: v.cnt || null,
    };
    S.gcnt = v.cnt || null;
    S.poolBuilt = Number(v.builtAt) || 0;
    for (const n of this.bucket().nodes || []) this.unpackNode(n);
    // 站点偏好：同机房的 isolate 共享一份，冷启动不用重新学
    for (const e of (this.bucket() as SeedBucket).hp || []) {
      if (!e || !e.h || !e.k) continue;
      let hm = S.hostNode.get(e.h);
      if (!hm) {
        if (S.hostNode.size >= 120) continue;
        hm = new Map<string, HNStat>();
        S.hostNode.set(e.h, hm);
      }
      const cur = hm.get(e.k);
      if (!cur || (e.n || 0) > cur.n) {
        hm.set(e.k, {
          n: e.n || 0,
          ok: Math.max(0, (e.n || 0) - (e.bad || 0)),
          bad: e.bad || 0,
          bytes: 0,
          ttfb: e.ttfb || 0,
          at: e.at || 0,
        });
      }
    }
  }
  // 读到空表时只缓存 1 分钟：否则一个刚部署的 isolate 会"空着"整整半小时，
  // 期间该机房所有连接都只能直连。
  const hasAny = !!(S.seed && S.seed.byColo && (this.bucket().nodes || []).length);
  S.seedAt = hasAny ? Date.now() : Date.now() - SEED_TTL + 60000;
  return S.seed;
}

/**
 * 把本地统计合并进「本机房」的桶并落盘。只写自己的桶，不碰别的机房。
 * @param {object} env Worker 环境
 * @returns {Promise<{ok:boolean,err?:string}>} 结果
 */
async write(env: Env, listOnly = false, force = false) {
  if (!env || !env.STATS) return { ok: true, skipped: true };
  // 必须先读到已有 seed 再写：否则一个"还没读过"的 isolate 会拿空对象覆盖，
  // 把 poolGen 和所有机房的桶一起抹掉（踩过一次，池子直接变 0）。
  await this.read(env);
  // 全局写节流：任何 isolate 落盘前先看 seed 上的时间戳。
  // 8 个 isolate 各自 30 分钟一写 = 384/天，加上现有的就顶到额度了。
  if (!force && Date.now() - (S.seed.ts || 0) < 20 * 60000) return { ok: true, skipped: true };
  const bucket = this.bucket();
  const base = new Map();
  for (const n of bucket.nodes || []) if (n && n.k) base.set(n.k, { ...n });
  const keys = new Set([...base.keys(), ...S.alive.keys(), ...S.nstat.keys()]);
  for (const k of keys) {
    if (!k || k.lastIndexOf(":") <= 0) continue;
    if (listOnly) { base.set(k, this.packName(k)); continue; }
    const old = base.get(k) || {};
    const packed = this.packNode(k);
    packed.b = Math.min(packed.b || old.b || 0, 8 * 1048576);   // 本地没样本时保留历史，但设上限
    if (!packed.n && old.n) { packed.n = old.n; packed.f = old.f || 0; }
    base.set(k, packed);
  }
  const scored = [...base.values()].map((n) => ({ n, v: listOnly ? 0 : costOf(n.k, "lat") }));
  scored.sort((a, b) => a.v - b.v);
  const nodes = scored.slice(0, SEED_MAX).map((x) => x.n);
  if (!nodes.length) {
    // 没有节点可写：只把池子代际等全局字段刷上去，别动任何机房的桶
    S.seed = {
      ...S.seed,
      v: SEED_VER,
      ts: Date.now(),
      poolGen: S.poolGen || S.seed.poolGen || 0,
      poolN: S.pool.length || S.seed.poolN || 0,
      builtAt: S.poolBuilt || S.seed.builtAt || 0,
      cnt: S.seed.cnt || null,
    };
    try {
      await kvSet(env, SEED_KEY, S.seed, { expirationTtl: PX_TTL });
      return { ok: true, empty: true };
    } catch (e: any) {
      return { ok: false, err: String((e && e.message) || e).slice(0, 80) };
    }
  }
  // 全局日计数合并进 seed（跨 isolate 聚合，最多 20 分钟延迟）
  const d0 = new Date().toISOString().slice(0, 10);
  const gc: Record<string, any> = S.seed.cnt && S.seed.cnt.d === d0 ? { ...S.seed.cnt } : { d: d0 };
  const dlt = cntDelta();
  for (const [k, n] of Object.entries(dlt)) gc[k] = (gc[k] || 0) + n;

  const byColo = { ...(S.seed.byColo || {}) };
  // 站点偏好：只写"样本够"（族内 ≥3 次）的，按样本数取前 40 —— 约 2KB，
  // 跟 seed 同一次写，不增加任何 KV 写入次数。
  const hpAll = [];
  for (const [h, hm] of S.hostNode) {
    let tot = 0;
    for (const s of hm.values()) tot += s.n;
    if (tot < 3) continue;
    for (const [k, s] of hm) {
      if (!s.n) continue;
      hpAll.push({ h, k, ttfb: s.ttfb || 0, n: s.n, bad: s.bad || 0, at: s.at || 0 });
    }
  }
  hpAll.sort((a, b) => b.n - a.n);
  // 和桶里已有的合并：每个 isolate 只有自己看到的那部分，直接覆盖会把
  // 别的 isolate 学到的条目冲掉。按 (族,节点) 去重，样本多的留下。
  const mergedHp = new Map<string, any>();
  for (const e of ((this.bucket() as SeedBucket).hp || [])) {
    if (e && e.h && e.k) mergedHp.set(e.h + "|" + e.k, { ...e });
  }
  for (const e of hpAll) {
    const key = e.h + "|" + e.k;
    const old = mergedHp.get(key);
    if (!old || e.n > old.n) mergedHp.set(key, e);
  }
  const hpTop = [...mergedHp.values()].sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 40);
  byColo[this.coloKey()] = { ts: Date.now(), lastSwitch: Math.max(S.lastSwitch.lat || 0, S.lastSwitch.tput || 0), nodes, hp: hpTop };
  // 第一次落盘时顺手建一份"全局候选名单"（只有名字，没有统计），
  // 让还没跑过 cron 的机房也能拿到节点，而不是干等 30 分钟。
  // 名单桶：任何一次落盘都用"当轮实测 ms"刷新一次。它只是给还没测过的机房的参考值，
  // 不带 tcp/tls/n 这类统计，所以不会造成跨机房污染。
  if (nodes.length) {
    byColo[BUCKET_DEF] = { ts: Date.now(), nodes: nodes.map((n) => ({ k: n.k, h: n.h, p: n.p, cc: n.cc || "", ms: n.ms })) };
  }
  if (Object.keys(byColo).length > 7) {
    const keep = (Object.entries(byColo) as [string, SeedBucket][])
      .filter(([k2]) => k2 !== BUCKET_DEF)
      .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
      .slice(0, 6)
      .map(([k2]) => k2);
    for (const k2 of Object.keys(byColo)) {
      if (k2 !== BUCKET_DEF && !keep.includes(k2)) delete byColo[k2];
    }
  }
  S.seed = {
    v: SEED_VER,
    ts: Date.now(),
    poolGen: S.poolGen || S.seed.poolGen || 0,
    poolN: S.pool.length || S.seed.poolN || 0,
    builtAt: S.poolBuilt || S.seed.builtAt || 0,
    byColo,
    cnt: gc,
  };
  S.gcnt = gc;
  S.seedDirty = false;
  S.seedAt = Date.now();
  try {
    await kvSet(env, SEED_KEY, S.seed, { expirationTtl: PX_TTL });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, err: String((e && e.message) || e).slice(0, 80) };
  }
}


}

export const SEEDS = new SeedStore();
