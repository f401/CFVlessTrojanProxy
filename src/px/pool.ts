import { errMsg } from "../core/util";

import { SEED_WRITE_GAP } from "../core/const";
import { SC } from "../core/const";
import { HOOK } from "../core/hook";
import { logErr } from "../nodes/metrics";
import { POOL_MAX, POOL_TTL_MS, chunks, geoLabel, probeProxy, probeSni, refillPool } from "./probe";
import { candsFor, capOf, invalidateRank, scoreParts, nsLatency, nsProbe, nsProbeFail, p90Of, pFailOf, pStallOf, pctOf, isBlack, isFrozen } from "../nodes/score";
import { BUCKET_DEF, SEEDS } from "./seed";
import { PX_TTL, MODES, keyOf } from "./const";
import { S } from "../core/state";
import { kvGet, kvSet } from "../store/index";

/* 代理节点：状态 / 信誉分桶 / 选择 / cron */

/**
 * 探活结果分类。null 有两种可能：连不上（DNS/拒绝/超时）或握手途中异常，
 * 这两类"可能是地区/线路问题"；not-tls / no-cf-cert 是节点事实（它就不是 CF 反代）。
 * @param {object|null} r probeProxy 的返回
 */
export function noteProbe(r: { bad?: string } | null) {
  const k = !r ? "err" : r.bad === "not-tls" ? "notTls" : r.bad === "no-cf-cert" ? "noCf" : "ok";
  S.probeWhy[k] = (S.probeWhy[k] || 0) + 1;
}
/* ---- 轮换模块：内存为权威，KV 只存「候选池 + 分机房节点信誉」 ---- */

export const SEED_COLD_N = 48; // 冷启动灌进 alive 的节点数

const ALIVE_MAX = 800; // 长期运行 alive 上限：池子换代不会永久累积（800 节点 ≈ 1 MB 统计 + candsFor 0.9ms）

// 冷启动不再写死历史中转：那些地址一旦失效，alive 会长期只有几个死节点，
// 反而把「中转」变成一次必赔的拨号。起步候选直接从候选池头部取（见 pxGet），
// 由本机房自己的探活决定谁留谁走。


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
      invalidateRank();
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
  invalidateRank();
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
    if (!src.length) {
      // 本机房还没数据：借名单桶（cron 写的全局候选），只取名字
      src = ((S.seed.byColo || {})[BUCKET_DEF] || {}).nodes || [];
    }
    if (!src.length) {
      // 连名单桶都没有：借用任意一个有数据的机房，同样只取名字
      const hit = (Object.values(S.seed.byColo || {}) as SeedBucket[]).find((b) => (b.nodes || []).length);
      if (hit) src = hit.nodes || [];
    }
    if (!src.length && S.pool.length) {
      // 没有任何名单可用时，用候选池头部当起步：只写名字、延迟先验，
      // 由本机房的探活与失败学习决定留谁（池子是 CF 优选 IP，对非 CF 目标才有中转价值）。
      for (const c of S.pool.slice(0, 32)) {
        const k = c.h + ":" + c.p;
        if (!S.alive.has(k)) S.alive.set(k, { h: c.h, p: c.p, cc: "", ms: SC.P_TCP, src: "pool" });
      }
    }
    for (const n of src.slice(0, SEED_COLD_N)) {
      if (!n || !n.k) continue;
      const i = n.k.lastIndexOf(":");
      // 名单只有"连得上"，没有延迟：统一按先验起步，由本 isolate 自己的样本收敛
      S.alive.set(n.k, {
        h: n.h || n.k.slice(0, i),
        p: n.p || Number(n.k.slice(i + 1)) || 443,
        cc: n.cc || "",
        ms: SC.P_TCP,
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
 * @param {number} [limit] 最多算多少条（默认 64；整页节点列表要传实际条数）
 * @returns {object} "host:port" → 统计明细
 */
export function nsOf(keys: string[], limit = 64) {
  const m: Record<string, Record<string, number | string>> = {};
  let i = 0;
  for (const k of keys) {
    if (++i > limit) break;
    const s = S.nstat.get(k);
    if (!s) continue;
    // 有效样本数用衰减后的权重和，不是原始计数——面板上要跟「还有多少信息量」对齐
    const n = (s.okW || 0) + (s.failW || 0);
    // 两种模式各算一次分：面板把「同一节点在延迟/吞吐下分别值多少分」并排摆出来
    const lat = scoreParts(k, "lat"),
      tp = scoreParts(k, "tput");
    m[k] = {
      ok: s.ok || 0,
      fail: s.fail || 0,
      at: s.at || 0,
      // bps 取 p90（乐观上界，抽样剪枝靠它），bpsMed 取中位（人看着更像实际）
      bps: Math.round(p90Of(s) || 0),
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
  return SEEDS.write(env, S.colo ? undefined : true, !!force);
}

/** 对外：本机房的存活节点列表 */
export async function aliveList(env: Env) {
  await pxGet(env);
  return [...S.alive.values()];
}

/**
 * 这个候选是否暂时不占探活名额。
 * 「连续失败」必须带时间戳：公开池里失败的绝大多数是临时抖动（限流、被墙、机房负载），
 * 以前只记次数、永不衰减，一个节点冷启动时被拒 3 次就永远排在候选之外。
 */
export function probeBadSkip(k: string, now = Date.now()): boolean {
  const e = S.probeBad.get(k);
  if (!e || e.n < SC.SCAN_BAD_MAX) return false;
  return now - e.at <= SC.PROBE_BAD_TTL;
}
/** 记一次探活失败（由 cronScan 与测试共用，保证「过期重置」只写一遍） */
export function bumpProbeBad(k: string, ok: boolean, now = Date.now()): void {
  if (ok) {
    S.probeBad.delete(k);
    return;
  }
  const cur = S.probeBad.get(k);
  const n = cur && now - cur.at <= SC.PROBE_BAD_TTL ? cur.n + 1 : 1;
  S.probeBad.set(k, { n: Math.min(9, n), at: now });
}
/**
 * 功能：跑一轮池子维护：准入复测（adm 是本次准入预算）→ 探活 → 出口/中继打标 → 游标重算。
 * @param env 环境变量
 * @param adm 本轮准入名额，0 表示按池子大小自动取
 * @returns 无
 */
export async function cronScan(env: Env, adm = 0) {
  await pxGet(env);
  let pool = await ensurePool(env);
  if (!pool.length || Date.now() - S.poolBuilt > POOL_TTL_MS) {
    const { pool: fresh } = await refillPool(env);
    if (fresh.length) {
      const c = await commitPool(env, fresh);
      if (c.ok) pool = fresh;
      else logErr(`pool commit rejected: ${c.reason}`, "");
    }
    if (!pool.length) return;
  }

  // ①a 复测上一轮"比同 /24 邻居慢一大截"的节点：一次抖动会被 EWMA 吃掉 30%，
  //     紧接着再测一次就能拉回来。每个节点最多复测一次，每轮最多 4 个。
  const again = S.reProbe.splice(0, 4);
  if (again.length) {
    S.reProbeN += again.length;
    const rr = await Promise.all(
      again.map(async (k) => {
        const i = k.lastIndexOf(":");
        return { k, r: await probeProxy(k.slice(0, i), Number(k.slice(i + 1)) || 443) };
      }),
    );
    for (const { k, r } of rr) {
      noteProbe(r);
      if (r && !r.bad) {
        nsProbe(k, r.ms, r.tcp || r.ms, r.tls || 0);
        const a = S.alive.get(k);
        if (a && r.ms < (a.ms || 1e9)) a.ms = r.ms;
      }
    }
  }

  // ① 探新候选
  // 每轮扫多少：默认按"4 轮覆盖全池"，管理员的 ?scan= 只能往上抬，天花板 SCAN_MAX。
  // 120/轮时 1600 池要 6.7 小时才轮完，冷启动期（isolate 寿命短）等于永远只认识前 120 个。
  const want = adm > 0 ? adm : Math.max(S.scanN || 12, Math.ceil(pool.length / 4));
  // 子请求是硬上限：免费计划 50/次调用，每次探活 = 1 个 connect()。默认压在 48，
  // 付费计划或提高配额后用 env.scanSub 抬（仍不超过 SCAN_MAX）。
  const sub = Number(env.scanSub) > 0 ? Math.max(12, Number(env.scanSub)) : SC.SCAN_SUB;
  const scanN = Math.max(12, Math.min(Math.min(SC.SCAN_MAX, sub), want));
  // 只在"还没有结论"的候选里轮转：已经进池的（有流量样本，另有 ② 复测）和连续探活失败的
  // 不再占名额。公开池里九成以上是死的，纯轮转时它们每轮都被重复探一遍，好候选永远排不上。
  const open = pool.filter((c) => {
    const k = c.h + ":" + c.p;
    return !S.alive.has(k) && !probeBadSkip(k);
  });
  // 全都有结论时退回"没进池的候选"做低频复检（能在池里的靠 ② 复测 + 真实流量，不用再探活）
  const live = pool.filter((c) => !S.alive.has(c.h + ":" + c.p));
  const src = open.length ? open : live.length ? live : pool;
  const idx = S.poolIdx % Math.max(src.length, 1);
  const batch = src.slice(idx, idx + scanN);
  const hits = [];
  S.probeColo = S.colo || "cron";
  for (const seg of chunks(batch, SC.PROBE_CONC)) {
    const part = await Promise.all(seg.map((c) => probeProxy(c.h, c.p)));
    for (let j = 0; j < seg.length; j++) {
      const x = part[j];
      noteProbe(x);
      const k = seg[j].h + ":" + seg[j].p;
      bumpProbeBad(k, !!(x && !x.bad));
    }
    hits.push(...part.filter((x) => x && !x.bad));
  }
  S.poolIdx = (idx + scanN) % Math.max(src.length, 1);
  S.probes += batch.length;
  S.hits += hits.length;
  // ①c 同批对照：同一个 /24 里其它节点都很快、只有它慢 3 倍以上 → 下一轮复测。
  //     不用绝对阈值（不同 /24 的基线差很多），也不动选路，只是多测一次。
  {
    const by24 = new Map<string, number[]>();
    for (const x of hits) {
      if (!x) continue;
      const p = String(x.h).split(".");
      if (p.length !== 4 || !(x.ms > 0)) continue;
      const k24 = p.slice(0, 3).join(".");
      const arr = by24.get(k24) || [];
      arr.push(x.ms);
      by24.set(k24, arr);
    }
    for (const x of hits) {
      if (!x) continue;
      const p = String(x.h).split(".");
      if (p.length !== 4 || !(x.ms > 0) || S.reProbe.length >= 8) continue;
      const arr = by24.get(p.slice(0, 3).join(".")) || [];
      if (arr.length < 3) continue;
      const med = arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
      const k = keyOf(x);
      if (x.ms > Math.max(3 * med, 250) && !S.reProbe.includes(k)) S.reProbe.push(k);
    }
  }

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
    noteProbe(r);
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
  for (const seg of chunks(rest, SC.PROBE_CONC)) {
    const rres2 = await Promise.all(
      seg.map(async (k) => {
        const i = k.lastIndexOf(":");
        return { k, r: await probeProxy(k.slice(0, i), Number(k.slice(i + 1)) || 443) };
      }),
    );
    for (const { k, r } of rres2) {
      noteProbe(r);
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
    invalidateRank();
  }

  // ③b alive 长期只增不减：池子换代后旧节点会一直留着，最终拖慢每次评分。
  //     优先保留当前池和两个游标，其余按「实测延迟」从差到好裁掉。
  //     不能用探活 ms 裁：探活测的是 TLS 握手，和首字节差一大截（仿真里按探活裁 800 个反而更差）。
  if (S.alive.size > ALIVE_MAX) {
    const inPool = new Set(pool.map((x) => x.h + ":" + x.p));
    const keep = new Set([S.curs.tput, S.curs.lat]);
    const latOf = (k: string, a: { ms?: number }) => {
      const s = S.nstat.get(k);
      return (s && s.pSum ? s.pSum : 0) || a.ms || 9999;
    };
    const rows = [...S.alive.entries()].filter(([k]) => !keep.has(k));
    rows.sort((a, b) => {
      const ap = inPool.has(a[0]) ? 0 : 1;
      const bp = inPool.has(b[0]) ? 0 : 1;
      if (ap !== bp) return bp - ap; // 先删不在当前池里的
      return latOf(b[0], b[1]) - latOf(a[0], a[1]); // 同一档先删最慢的
    });
    for (const [k] of rows) {
      if (S.alive.size <= ALIVE_MAX) break;
      S.alive.delete(k);
    }
    S.hostRankCache.clear();
    invalidateRank();
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
    if (S.nstat.size > ALIVE_MAX) {
      const old = [...S.nstat.entries()].filter(([k]) => !live.has(k)).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
      for (const [k] of old) {
        if (S.nstat.size <= ALIVE_MAX * 0.75) break;
        S.nstat.delete(k);
      }
    }
  }

  // ④c 中转实测：拿「实际失败过的站点」当目标，由池子自己判断哪个节点能替它出网。
  //     Worker 看不到 HTTP 状态码，但能看「这个节点有没有把该 SNI 的握手转出去」。
  const tNow = Date.now();
  const tgt: string[] = [];
  for (const [h, t] of S.needPx) if (t > tNow && tgt.length < 2) tgt.push(h);
  if (tgt.length) {
    const pool4 = (await aliveList(env))
      .filter((x) => !isBlack(keyOf(x)) && !isFrozen(keyOf(x)))
      .slice(0, 4);
    for (const h of tgt) {
      const res = (await Promise.all(
        pool4.map((x) => probeSni(x.h, x.p, h, 2200).catch(() => ({ err: "tcp" }) as { hs?: number })),
      )) as { hs?: number }[];
      res.forEach((x, i) => {
        if (HOOK.relayProbe) HOOK.relayProbe(h, pool4[i].h, !!x.hs, x.hs || 0);
      });
    }
  }

  // ⑤ 游标重算已移到 Selector.afterScan：pool 不再反向 import selector

  // ⑥ 每轮最多写一次 KV，且两次落盘间隔 ≥55 分钟（S.seed.ts 来自 KV，跨 isolate 有效）。
  //    cron 是 30 分钟一轮，早先每轮都强制写 = 48 次/天，光这一项就吃掉 5% 的日额度。
  if (Date.now() - (S.seed.ts || 0) >= 55 * 60000) {
    await SEEDS.write(env, S.colo ? undefined : true, true);
  }
}

/**
 * Pool 门面（P4）：把「抓取 → 准入探活 → 写 alive → 淘汰」这条流程以对象形式暴露。
 * 方法委托同名函数（实现留在原地，避免整文件搬家带来的回归风险），与 src/store/store.ts 的
 * Store 门面同一形态；之后要真正内联，可逐方法替换实现，调用方无需改动。
 */
export class Pool {
  /** 功能：noteProbe 是薄包装，直接委托 noteProbe。@param r { bad?: string } | null。@returns 无（noteProbe 无返回值） */
  noteProbe(r: { bad?: string } | null) {
    return noteProbe(r);
  }
  /** 功能：ensurePool 是薄包装，直接委托 ensurePool。@param env Env。@returns 无（ensurePool 无返回值） */
  async ensurePool(env: Env) {
    return ensurePool(env);
  }
  /** 功能：commitPool 是薄包装，直接委托 commitPool。@param env Env。@param fresh PoolEntry[]。@param allowShrink。@returns 无（commitPool 无返回值） */
  async commitPool(env: Env, fresh: PoolEntry[], allowShrink = false) {
    return commitPool(env, fresh, allowShrink);
  }
  /** 功能：pxGet 是薄包装，直接委托 pxGet。@param env Env。@returns 无（pxGet 无返回值） */
  async pxGet(env: Env) {
    return pxGet(env);
  }
  /** 功能：nsOf 是薄包装，直接委托 nsOf。@param keys string[]。@param limit。@returns 无（nsOf 无返回值） */
  nsOf(keys: string[], limit = 64) {
    return nsOf(keys, limit);
  }
  /** 功能：pxSet 是薄包装，直接委托 pxSet。@param env Env。@param patch { cur?: string | null; alive?: NodeEntry[] }。@returns 无（pxSet 无返回值） */
  async pxSet(env: Env, patch: { cur?: string | null; alive?: NodeEntry[] }) {
    return pxSet(env, patch);
  }
  /** 功能：flushPx 是薄包装，直接委托 flushPx。@param env Env。@param force? boolean。@returns 无（flushPx 无返回值） */
  async flushPx(env: Env, force?: boolean) {
    return flushPx(env, force);
  }
  /** 功能：aliveList 是薄包装，直接委托 aliveList。@param env Env。@returns 无（aliveList 无返回值） */
  async aliveList(env: Env) {
    return aliveList(env);
  }
  /** 功能：cronScan 是薄包装，直接委托 cronScan。@param env Env。@param adm。@returns 无（cronScan 无返回值） */
  async cronScan(env: Env, adm = 0) {
    return cronScan(env, adm);
  }
}

/** 进程内唯一实例 */
export const POOL = new Pool();

