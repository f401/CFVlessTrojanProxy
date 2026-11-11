import { errMsg } from "../core/util";

import { SEED_WRITE_GAP } from "../core/const";
import { HIST_BASE, HIST_N, SC } from "../core/const";
import { logErr } from "../nodes/metrics";
import { POOL_MAX, POOL_TTL_MS, geoLabel, probeProxy, refillPool } from "./probe";
import {
  candsFor,
  capOf,
  costOf,
  scoreParts,
  nsLatency,
  nsProbe,
  nsProbeFail,
  p90Of,
  pFailOf,
  pStallOf,
  pctOf,
  pcts,
} from "../nodes/score";
import { BUCKET_DEF, SEEDS } from "./seed";
import { SEL } from "../nodes/selector";
import { S } from "../core/state";
import { kvGet, kvSet, scheduleFlush } from "../store/index";

/* 代理节点：状态 / 信誉分桶 / 选择 / cron */
/* ---- 轮换模块：内存为权威，KV 只存「候选池 + 分机房节点信誉」 ---- */

export const SEED_KEY = "px:seed";
export const SEED_TTL = 30 * 60000; // 信誉表回读周期
export const SEED_MAX = 40; // 每个机房最多记 40 个节点
export const SEED_COLD_N = 8; // 冷启动灌进 alive 的节点数
export const PX_TTL = 86400 * 30;
export const SEED_VER = 6;
// 信誉表落盘的最小间隔：每个 isolate 各写各的会让写次数随实例数线性增长
// （8 个 isolate × 48 次/天 = 384）。S.seed.ts 是从 KV 读回来的全局时间戳，
// 用它当闸门能把全局写频压到 ~30 次/天。

export { SC, HIST_BASE, HIST_N } from "../core/const";

export const MODES: Mode[] = ["lat", "tput"];
const ALIVE_MAX = 400; // 长期运行 alive 上限：池子换代不会永久累积

// 灾备种子：seed 被清空时用它兜底，避免"池子有 2000 条但一个能用的都没有"。
// 这些是历史上实测可用的中转，会被正常探活/熔断覆盖，不是永久白名单。
export const BOOT = [
  "45.147.250.39:443",
  "45.136.117.194:443",
  "185.253.117.147:443",
  "91.215.154.80:443",
  "91.215.153.143:443",
  "45.151.183.22:443",
  "193.181.211.185:443",
  "89.22.227.132:443",
];

/* 日计数器：用来回答"一天多少连接、多少走节点、切换几次"这些以前只能估的量 */

/** 跨天重置日计数：任何出口（cntView/cntDelta）都要先过这一层 */
function rollCntDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (S.cntDay === d) return;
  S.cntDay = d;
  for (const key of S.cntKeys) {
    S.cnt[key] = 0;
    S.cntSent[key] = 0;
  }
}

/**
 * 计数（跨天自动清零）
 * @param {string} k 计数名
 * @param {number} [n] 增量
 * @returns {void}
 */
export function cnt(k: string, n: number = 1) {
  if (!S.cntKeys.includes(k)) {
    try {
      console.error("[cnt] unknown key", k);
    } catch (e) {}
    return;
  }
  rollCntDay();
  S.cnt[k] = (S.cnt[k] || 0) + (n === undefined ? 1 : n);
}

/**
 * 每个节点的紧凑快照（用于跨 isolate 展示：本 isolate 看不到别人测的吞吐）
 * @returns {object} { "h:p": {med,p90,cap,n,ts,tf,at} }
 */
export function spdSnapshot() {
  const out: Record<string, NodeSnap> = {};
  // 按累计下行挑前 16 个：以前取 Map 的前 16 个（首次触碰顺序），
  // 真正在跑的大流量节点经常排在后面，面板就一直看不到它的 KB/s。
  const rows = [...S.nstat.entries()]
    .filter(([k, s]) => S.alive.has(k) && ((s.tS || 0) + (s.tF || 0) > 0 || (s.bytesDown || 0) > 0))
    .sort((a, b) => (b[1].bytesDown || 0) - (a[1].bytesDown || 0))
    .slice(0, 16);
  for (const [k, s] of rows) {
    const n = (s.tS || 0) + (s.tF || 0);
    const q = pcts(s);
    out[k] = {
      med: Math.round(q.p50 || 0),
      p90: Math.round(q.p90 || 0),
      cap: Math.round(q.cap || 0),
      n: Math.round(n),
      ts: Math.round(s.tS || 0),
      tf: Math.round(s.tF || 0),
      at: s.at || 0,
    };
  }
  return out;
}

/**
 * 只有计数、没有字节时，PEND 是空的 → 没人会去跟 DO 说话，计数就丢了。
 * 塞一个空批次把它顶出去。
 * @param {object} env Worker 环境
 * @param {string} id 用户 UUID
 * @returns {void}
 */
export function kickFlush(env: Env, id: string | null) {
  if (!env || !id || !env.METER) return;
  if (!S.pend.has(id)) S.pend.set(id, { up: 0, down: 0, conns: 0 });
  scheduleFlush(env, 0);
}

/** 取出"上次落盘之后"的增量，并把基线推到当前值 */
export function cntView() {
  rollCntDay();
  return { ...S.cnt, d: S.cntDay || new Date().toISOString().slice(0, 10) };
}

export function cntDelta() {
  rollCntDay();
  const out: Record<string, number> = {};
  for (const k of S.cntKeys) {
    const v = (S.cnt[k] || 0) - (S.cntSent[k] || 0);
    if (v) out[k] = v;
  }
  for (const k of S.cntKeys) S.cntSent[k] = S.cnt[k] || 0;
  return out;
}

/** 批次失败时把日计数基线退回去，下一轮重新发送（否则这批连接数就永久丢了） */
export function cntUnsend(delta: Record<string, number>) {
  for (const [k, v] of Object.entries(delta)) {
    if (S.cntSent[k] === undefined) continue;
    S.cntSent[k] = Math.max(0, (S.cntSent[k] || 0) - v);
  }
}

export const keyOf = (x: NodeEntry) => x.h + ":" + x.p;

/** 候选项池：内存 → KV(poolGen) → 空；空时由 cronScan 触发重建 */
export async function ensurePool(env: Env) {
  if (S.pool.length) return S.pool;
  await SEEDS.read(env);
  const gen = S.seed.poolGen || 0;
  if (!gen) return [];
  try {
    const v = await kvGet<PoolEntry[]>(env, "px:pool:" + gen);
    if (Array.isArray(v) && v.length) {
      S.pool = v.slice(0, POOL_MAX);
      S.poolGen = gen;
      S.rankCache.t = 0;
    }
  } catch (e) {}
  return S.pool;
}

/** 两阶段提交新候选池：先写新代际键，成功后再改 seed.poolGen */
export async function commitPool(env: Env, fresh: PoolEntry[], allowShrink = false) {
  // 路由手动 refill 可能把多个源的合并结果直接传进来；落 KV/进内存前统一截断
  fresh = fresh.slice(0, POOL_MAX);
  const oldN = S.pool.length || Number(S.seed.poolN) || 0;
  const newN = fresh.length;
  if (!newN) return { ok: false, reason: "empty" };
  if (!allowShrink && oldN && newN < oldN * 0.6) {
    return { ok: false, reason: `rejected ${newN} < 60% of ${oldN}` };
  }
  const gen = (S.poolGen || S.seed.poolGen || 0) + 1;
  try {
    await kvSet(env, "px:pool:" + gen, fresh, { expirationTtl: PX_TTL });
  } catch (e) {
    return { ok: false, reason: "kv " + String(errMsg(e)).slice(0, 60) };
  }
  S.pool = fresh;
  S.poolGen = gen;
  S.rankCache.t = 0;
  S.poolBuilt = Date.now();
  S.seed.poolGen = gen;
  await SEEDS.write(env, S.colo ? undefined : true, true);
  return { ok: true, gen, n: newN };
}

/**
 * 取轮换模块的对外快照。冷启动只继承「本机房」的信誉。
 * @param {object} env Worker 环境
 * @returns {Promise<{cur:string, alive:Array, state:object}>} 状态
 */
export async function pxGet(env: Env) {
  await SEEDS.read(env);
  if (!S.alive.size) {
    let src = SEEDS.bucket().nodes || [];
    const refMs: Record<string, number> = {};
    for (const n of ((S.seed.byColo || {})[BUCKET_DEF] || {}).nodes || []) {
      if (n && n.k && n.ms) refMs[n.k] = n.ms;
    }
    let foreign = false;
    if (!src.length) {
      const nb = (S.seed.byColo || {})[BUCKET_DEF] || {};
      src = nb.nodes || [];
      foreign = true;
    }
    if (!src.length) {
      // 连名单桶都没有：借用任意一个有数据的机房，只取名字，不取延迟（避免跨机房污染）
      const hit = (Object.values(S.seed.byColo || {}) as SeedBucket[]).find((b) => (b.nodes || []).length);
      if (hit) {
        src = hit.nodes || [];
        foreign = true;
      }
    }
    if (!src.length) {
      for (const kk of BOOT) {
        const i = kk.lastIndexOf(":");
        S.alive.set(kk, { h: kk.slice(0, i), p: Number(kk.slice(i + 1)) || 443, cc: "", ms: SC.P_TCP, src: "boot" });
      }
    }
    for (const n of src.slice(0, SEED_COLD_N)) {
      if (!n || !n.k) continue;
      const i = n.k.lastIndexOf(":");
      // 跨机房桶只借名字：n.ms 是别的机房的延迟，直接用会污染本地评分
      const ms = foreign ? refMs[n.k] || SC.P_TCP : n.ms && n.ms !== SC.P_TCP ? n.ms : refMs[n.k] || n.ms || SC.P_TCP;
      S.alive.set(n.k, {
        h: n.h || n.k.slice(0, i),
        p: n.p || Number(n.k.slice(i + 1)) || 443,
        cc: n.cc || "",
        ms,
        src: "seed",
      });
    }
  }
  for (const m of MODES) {
    if (!S.curs[m]) {
      const c = candsFor(m);
      if (c.length) S.curs[m] = c[0].k;
    }
  }
  return {
    cur: S.curs.tput || S.curs.lat || "",
    curs: { ...S.curs },
    alive: [...S.alive.values()],
    state: {
      gen: S.poolGen || S.seed.poolGen || 0,
      poolKey: S.poolGen || S.seed.poolGen ? "px:pool:" + (S.poolGen || S.seed.poolGen) : "",
      poolN: S.pool.length || S.seed.poolN || 0,
      builtAt: S.poolBuilt,
      idx: S.poolIdx,
      probes: S.probes,
      hits: S.hits,
      colo: S.colo || "??",
      funnel: { ...S.funnel },
      curs: { ...S.curs },
      // 注意：这里不再预先遍历整张 nstat 生成面板明细。
      // nstat 会随着候选池扫描不断变长（实测能到 2000+），而每次订阅/面板
      // 请求都会走 pxGet —— 2000 条 × 2 次 costOf 纯属白烧 CPU。
      // 需要明细的地方用 nsOf(keys) 按需生成（只算真正要展示的那几个节点）。
    },
  };
}

/**
 * 按需生成节点面板明细（只算传入的节点，避免为整张 nstat 白算分）。
 * @param {Iterable<string>} keys "host:port" 列表
 * @returns {object} "host:port" → 统计明细
 */
export function nsOf(keys: string[]) {
  const m: Record<string, Record<string, number | string>> = {};
  let i = 0;
  for (const k of keys) {
    if (++i > 64) break; // 面板最多展示几十行，别被异常输入拖死
    const s = S.nstat.get(k);
    if (!s) continue;
    const n = (s.okW || 0) + (s.failW || 0);
    const lat = scoreParts(k, "lat"),
      tp = scoreParts(k, "tput");
    m[k] = {
      ok: s.ok || 0,
      fail: s.fail || 0,
      at: s.at || 0,
      bps: Math.round(p90Of(s) || s.seedBps || 0),
      bpsMed: Math.round(pctOf(s, 0.5) || 0),
      bpsCap: Math.round(capOf(s) || 0),
      n: Math.round(n),
      bytes: Math.round(s.bytesDown || 0),
      pFail: Math.round(pFailOf(s) * 1000) / 1000,
      pStall: Math.round(pStallOf(s) * 1000) / 1000,
      lat: Math.round(lat.score),
      tput: Math.round(tp.score),
      e10: Math.round(tp.e10Ms),
      confB: Math.round(tp.confB * 1000) / 1000,
      nEff: Math.round(tp.nEff * 10) / 10,
      latN: Math.round(lat.latN * 10) / 10,
      gate: tp.gate,
    };
  }
  return m;
}

/** 兼容旧调用：只改内存，不落盘 */
export async function pxSet(env: Env, patch: { cur?: string | null; alive?: NodeEntry[] }) {
  if (!patch) return pxGet(env);
  if (typeof patch.cur === "string") {
    S.curs.tput = patch.cur;
    S.curs.lat = patch.cur;
  }
  if (Array.isArray(patch.alive)) {
    S.alive = new Map(patch.alive.map((x) => [keyOf(x), x]));
  }
  return pxGet(env);
}

/** 落盘：只写信誉表（池子走 commitPool），cron 每轮一次 */
export async function flushPx(env: Env, force?: boolean) {
  if (!env || !env.STATS) return { ok: true, skipped: true };
  if (!force && !S.seedDirty) return { ok: true, skipped: true };
  if (!force) {
    const last = Math.max(S.seed.ts || 0);
    if (Date.now() - last < SEED_WRITE_GAP) return { ok: true, skipped: true };
  }
  S.nsWriteAt = Date.now();
  return SEEDS.write(env, S.colo ? undefined : true);
}

/** 对外：本机房的存活节点列表 */
export async function aliveList(env: Env) {
  await pxGet(env);
  return [...S.alive.values()];
}

export async function cronScan(env: Env) {
  await pxGet(env);
  let pool = await ensurePool(env);
  if (!pool.length || Date.now() - S.poolBuilt > POOL_TTL_MS) {
    const fresh = await refillPool(env);
    if (fresh.length) {
      const c = await commitPool(env, fresh);
      if (c.ok) pool = fresh;
      else logErr(`pool commit rejected: ${c.reason}`, "");
    }
    if (!pool.length) return;
  }

  // ① 探新候选
  const scanN = Math.max(12, Math.min(60, S.scanN || 12));
  const idx = S.poolIdx % Math.max(pool.length, 1);
  const batch = pool.slice(idx, idx + scanN);
  const hits = [];
  for (let i = 0; i < batch.length; i += 10) {
    const part = await Promise.all(batch.slice(i, i + 10).map((c) => probeProxy(c.h, c.p)));
    hits.push(...part.filter((x) => x && !x.bad));
  }
  S.poolIdx = (idx + scanN) % Math.max(pool.length, 1);
  S.probes += batch.length;
  S.hits += hits.length;

  for (const x of hits) {
    if (!x) continue;
    const k = keyOf(x);
    S.alive.set(k, {
      h: x.h,
      p: x.p,
      cc: (x as { cc?: string }).cc || ((S.alive.get(k) || {}) as NodeEntry).cc || "",
      ms: x.ms,
      src: "probe",
    });
    nsLatency(k, x.ms);
    nsProbe(k, x.ms, x.tcp || x.ms, x.tls || 0);
  }

  // ② 重测当前 + 分数前 3 名（失败即进冷却）
  //    以前这里取的是 alive 的前三个 key（插入顺序），跟"前 3 名"没关系，
  //    真正该复测的头部节点反而一直轮不到。
  const cur = S.curs.tput || S.curs.lat || "";
  const top3 = candsFor("tput")
    .map((x) => x.k)
    .filter((k) => k !== cur)
    .slice(0, 3);
  const recheck = [cur, ...top3].filter(Boolean).slice(0, 4);
  const rres = await Promise.all(
    recheck.map(async (k) => {
      const i = k.lastIndexOf(":");
      return { k, r: await probeProxy(k.slice(0, i), Number(k.slice(i + 1)) || 443) };
    }),
  );
  for (const { k, r } of rres) {
    if (r && !r.bad) {
      nsLatency(k, r.ms);
      nsProbe(k, r.ms, r.tcp || r.ms, r.tls || 0);
      const a = S.alive.get(k);
      if (a) a.ms = r.ms;
    } else {
      nsProbeFail(k);
    }
  }

  // ②b 其余 alive：只刷新延迟，不参与拉黑（抖动不该把 alive 打死）
  //    从 poolIdx 开始轮转，别每次都测同样 12 个（插入顺序靠前的会一直被溺爱）
  const allRest = [...S.alive.keys()].filter((k) => !recheck.includes(k));
  const start = allRest.length ? S.poolIdx % allRest.length : 0;
  const rest = [...allRest.slice(start), ...allRest.slice(0, start)].slice(0, 12);
  if (rest.length) {
    const rres2 = await Promise.all(
      rest.map(async (k) => {
        const i = k.lastIndexOf(":");
        return { k, r: await probeProxy(k.slice(0, i), Number(k.slice(i + 1)) || 443) };
      }),
    );
    for (const { k, r } of rres2) {
      if (r && !r.bad) {
        nsLatency(k, r.ms);
        nsProbe(k, r.ms, r.tcp || r.ms, r.tls || 0);
        const a = S.alive.get(k);
        if (a) a.ms = r.ms;
      } else {
        nsProbeFail(k);
      }
    }
  }

  // ③ 只裁「重罚」节点：连续失败 4 次会冷却 1 小时，这种才移出 alive；
  //    以前只要 isBlack 就删，一次 1 分钟的小冷却也会把好节点踢出池子，
  //    要等下一轮扫描（最长 8 小时）才回来。
  let pruned = false;
  for (const k of [...S.alive.keys()]) {
    const s = S.nstat.get(k);
    const ban = s ? (s.blackUntil || 0) - Date.now() : 0;
    if (ban > 30 * 60000 && k !== S.curs.tput && k !== S.curs.lat) {
      S.alive.delete(k);
      pruned = true;
    }
  }
  if (pruned) {
    // 站点排行里可能还留着刚被删的节点
    S.hostRankCache.clear();
    S.rankCache.t = 0;
  }

  // ③b alive 长期只增不减：池子换代后旧节点会一直留着，最终拖慢每次评分。
  //     优先保留当前池和两个游标，其余按延迟从差到好裁掉。
  if (S.alive.size > ALIVE_MAX) {
    const inPool = new Set(pool.map((x) => x.h + ":" + x.p));
    const keep = new Set([S.curs.tput, S.curs.lat]);
    const rows = [...S.alive.entries()].filter(([k]) => !keep.has(k));
    rows.sort((a, b) => {
      const ap = inPool.has(a[0]) ? 0 : 1;
      const bp = inPool.has(b[0]) ? 0 : 1;
      if (ap !== bp) return bp - ap; // 先删不在当前池里的
      return (b[1].ms || 9999) - (a[1].ms || 9999); // 同一档先删最慢的
    });
    for (const [k] of rows) {
      if (S.alive.size <= ALIVE_MAX) break;
      S.alive.delete(k);
    }
    S.hostRankCache.clear();
    S.rankCache.t = 0;
  }

  // ④ 国家码补全
  const need = [...S.alive.values()].filter((x) => !x.cc).map((x) => x.h);
  if (need.length) {
    const geo = await geoLabel(need);
    for (const x of S.alive.values()) if (!x.cc && geo[x.h]) x.cc = geo[x.h];
  }

  // ④b 清理统计表：候选池一轮轮扫下去，nstat 只增不减（实测能到 2000+ 条），
  //     每条带一个 12 格直方图。清掉"不在 alive、没有吞吐样本、6 小时没动静"的，
  //     再对总量做个硬上限，防止长期运行后内存一路涨。
  {
    const live = new Set(S.alive.keys());
    const cut = Date.now() - 6 * 3600e3;
    for (const [k, s] of S.nstat) {
      if (live.has(k) || (s.bytesDown || 0) > 0) continue;
      if ((s.at || 0) > cut) continue;
      S.nstat.delete(k);
    }
    if (S.nstat.size > 400) {
      const old = [...S.nstat.entries()].filter(([k]) => !live.has(k)).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
      for (const [k] of old) {
        if (S.nstat.size <= 300) break;
        S.nstat.delete(k);
      }
    }
  }

  // ⑤ 重算两个游标
  for (const m of MODES) SEL.maybeSwitch(env, m);
  SEL.sched(env);

  // ⑥ 每轮最多写一次 KV，且两次落盘间隔 ≥55 分钟（S.seed.ts 来自 KV，跨 isolate 有效）。
  //    cron 是 30 分钟一轮，早先每轮都强制写 = 48 次/天，光这一项就吃掉 5% 的日额度。
  if (Date.now() - (S.seed.ts || 0) >= 55 * 60000) {
    await SEEDS.write(env, S.colo ? undefined : true, true);
  }
}
