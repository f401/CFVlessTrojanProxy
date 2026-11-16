import { commitPool, ensurePool } from "./poolgen";

import { SEED_WRITE_GAP } from "../core/const";
import { SC } from "../core/const";
import { HOOK } from "../core/hook";
import { logErr } from "../nodes/metrics";
import { POOL_TTL_MS, chunks, geoLabel, probeProxy, probeSni, refillPool } from "./probe";
import { candsFor, capOf, invalidateRank, scoreParts, nsProbe, nsProbeFail, p90Of, pFailOf, pStallOf, pctOf, isBlack, isFrozen } from "../nodes/score";
import { BUCKET_DEF, SEEDS } from "./seed";
import { MODES, keyOf } from "./const";
import { S } from "../core/state";

/* 代理节点：状态 / 信誉分桶 / 选择 / cron */

// 池子的代际读写搬去 ./poolgen（提交规则较长，混在本文件会顶到 560 行上限）
export { commitPool, ensurePool };

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
        if (!S.alive.has(k)) S.alive.set(k, { h: c.h, p: c.p, cc: "", ms: SC.P_TCP });
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

/**
 * 改内存里的当前节点（不落盘）。
 *
 * 曾经还带一个 `alive` 参数、可以把整个 `S.alive` 换掉 —— 全仓唯一调用者是
 * `/<uuid>/debug?cur=`，只传 `cur`，那条分支从来没被走过（7.173 删掉）。
 * 换池子要走 `commitPool`：它管代际号、锚点与缩水守卫，直接替换内存会跟 KV 脱节。
 */
export async function pxSet(env: Env, patch: { cur?: string | null }) {
  if (!patch) return pxGet(env);
  if (typeof patch.cur === "string") {
    S.curs.tput = patch.cur;
    S.curs.lat = patch.cur;
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
 * 功能：清理「暂时跳过」表 —— 先删过了 TTL 的记录（它们对 `probeBadSkip` 已经没有意义），
 * 再按上限淘汰最久没更新的那些。
 *
 * 为什么要主动扫：这张表的键是候选地址（`host:port`），公开池每天换一批，
 * 而写入路径只有「失败时新增」与「成功时删自己那一条」——一个长命 isolate 见过几万个失败候选后
 * 表就一直涨，且没有任何读路径会因此报错（`probeBadSkip` 只是每行比较一次）。
 * @param {number} now 当前时间（毫秒时间戳，默认取 `Date.now()`）
 * @returns {number} 这一次删掉的行数
 */
export function sweepProbeBad(now = Date.now()): number {
  let gone = 0;
  // ① 过期即无用：判据与 probeBadSkip 用的是同一个 TTL，避免两处口径漂移
  for (const [k, v] of S.probeBad) {
    if (now - v.at > SC.PROBE_BAD_TTL) {
      S.probeBad.delete(k);
      gone += 1;
    }
  }
  // ② 还在 TTL 内但表已经太大：按最久没更新淘汰（值就是时间戳，不必额外维护淘汰序）
  if (S.probeBad.size > SC.PROBE_BAD_MAX) {
    const rows = [...S.probeBad.entries()].sort((a, b) => a[1].at - b[1].at);
    let over = S.probeBad.size - SC.PROBE_BAD_MAX;
    for (const [k] of rows) {
      if (over <= 0) break;
      S.probeBad.delete(k);
      over -= 1;
      gone += 1;
    }
  }
  return gone;
}
/**
 * 功能：跑一轮池子维护：准入复测（adm 是本次准入预算）→ 探活 → 出口/中继打标 → 游标重算。
 * @param env 环境变量
 * @param adm 本轮准入名额，0 表示按池子大小自动取
 * @returns 无
 */
export async function cronScan(env: Env, adm = 0) {
  // 每轮先收拾「暂时跳过」表：过期记录对 probeBadSkip 已无意义，表本身也没有自愈路径
  sweepProbeBad();
  await pxGet(env);
  let pool = await ensurePool(env);
  if (!pool.length || Date.now() - S.poolBuilt > POOL_TTL_MS) {
    const { pool: fresh } = await refillPool(env, S.pool.length);
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
    });
    // 探活 RTT 是「ClientHello → ServerHello」，与真实请求的首字节（含 TLS 握手）不是同一个量：
    // 写进 nsLatency 会让 pSum 停在 40ms 量级，第一条真实请求就 cus += 330 > CUSUM_H 把它冻 60 秒
    // （7.183 在 warm.ts 修过同一处）。探活只贡献样本数 pN 与 tcp/tls 的 EWMA。
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
 * 每个方法都委托**模块级同名函数**（实现留在原地，避免整文件搬家带来的回归风险），
 * 因此返回值就是被委托函数的返回值 —— 不要在这里另做裁剪或转换，否则会出现两份口径。
 * 与 src/store/store.ts 的 Store 门面同一形态；要真正内联时逐个方法替换实现即可。
 */
export class Pool {
  /** 功能：委托模块级 `noteProbe`，把一条探活结果写进节点统计。@param r 探活结果（`bad` 为非空表示失败原因）。@returns 无 */
  noteProbe(r: { bad?: string } | null) {
    return noteProbe(r);
  }
  /** 功能：委托模块级 `ensurePool`，按代际键从 KV 载入候选池（冷 isolate 的入口）。@param env Worker 环境。@returns 载入后的池子（可能为空数组） */
  async ensurePool(env: Env) {
    return ensurePool(env);
  }
  /** 功能：委托模块级 `commitPool`，把新候选合并进池子并按代际键写回。@param env Worker 环境。@param fresh 新候选。@param allowShrink 允许池子变小（不能超过 POOL_MIN）。@returns 写入结果 */
  async commitPool(env: Env, fresh: PoolEntry[], allowShrink = false) {
    return commitPool(env, fresh, allowShrink);
  }
  /** 功能：委托模块级 `pxGet`，取当前可用中继列表。@param env Worker 环境。@returns 可用条目（按代价升序） */
  async pxGet(env: Env) {
    return pxGet(env);
  }
  /** 功能：委托模块级 `nsOf`，把候选键翻译成节点统计视图。@param keys 候选键。@param limit 最多取几条。@returns 键 → 统计的映射 */
  nsOf(keys: string[], limit = 64) {
    return nsOf(keys, limit);
  }
  /**
   * 功能：委托模块级 `pxSet`，改内存里的当前节点。
   * @param env Worker 环境
   * @param patch 只认 `cur`（`alive` 那条分支在 7.173 删掉了：零调用方）
   * @returns 转发 `pxSet` 的返回值
   */
  async pxSet(env: Env, patch: { cur?: string | null }) {
    return pxSet(env, patch);
  }
  /** 功能：委托模块级 `flushPx`，把池子/可用集的变更落盘（有节流）。@param env Worker 环境。@param force 跳过节流立即写。@returns 无 */
  async flushPx(env: Env, force?: boolean) {
    return flushPx(env, force);
  }
  /** 功能：委托模块级 `aliveList`，取探活通过的条目（冷启动会先载入池子）。@param env Worker 环境。@returns 存活条目 */
  async aliveList(env: Env) {
    return aliveList(env);
  }
  /** 功能：委托模块级 `cronScan`，跑一轮「抓取 → 准入复测 → 打标 → 游标重算」。@param env Worker 环境。@param adm 本轮准入预算（0 表示按池子大小自适应）。@returns 本轮实际探活的条数 */
  async cronScan(env: Env, adm = 0) {
    return cronScan(env, adm);
  }
}

/** 进程内唯一实例 */
export const POOL = new Pool();

