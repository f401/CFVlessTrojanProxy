import { SELECTION_MEMORY } from "./selection-memory";
import { POOL_MEMORY } from "./pool-memory";
import { NODE_MEMORY } from "../core/node-memory";
import { ISOLATE } from "../core/state";
import { errMsg } from "../core/util";

import { SEED_WRITE_GAP } from "../core/const";
import { PX_TTL, SEED_KEY, SEED_MAX, SEED_READ_MS, SEED_VER } from "./const";
import { cntDelta, cntUnsend } from "../core/counter";
import { costOf } from "../nodes/score";
import { splitRelay } from "../core/relay-addr";
import { kvGetStrict, kvSet } from "../store/index";
import { QUALITY } from "./regions";

/* 代理节点：信誉表分桶读写 */
/* ---- seed：按机房分桶 ---- */
// 认知边界：cron 跑在哪个机房是未知的，所以它只写"候选名单"桶（BUCKET_DEF），
// 不写延迟/吞吐统计 —— 否则又是跨机房污染。服务 isolate 只写自己那桶。
export const BUCKET_DEF = "*";

/** 当前写入的桶名 */
export class SeedStore {
  /** 跨 isolate 只保存节点名字与地址，不包含本地统计。 */
  document: Seed = { v: 0, ts: 0, poolGen: 0, poolN: 0, builtAt: 0, byColo: {}, cnt: null };
  /** 上次把节点表写进 KV 的时刻（节流：同一分钟只写一次） */
  nodeWrittenAt = 0;
  /** 信誉表读取时刻（0=需要重读）：7.369 起由 SeedStore 自己持有 */
  readAt = 0;
  /** 上次读 KV 是否失败（失败时绝不能拿空表覆盖别的机房） */
  readFailed = false;
  /** 代际计数器（避免重启后节点名重复） */
  gen: CounterDoc | null = null;
  /**
   * 功能：本 isolate 的分桶键（没探到机房时用默认桶，保证同机房共享、跨机房隔离）。
   * @returns 字符串
   */
  coloKey() {
    return ISOLATE.colo || BUCKET_DEF;
  }

  /** 当前机房的信誉桶 */
  bucket() {
    const m = (this.document && this.document.byColo) || {};
    return m[this.coloKey()] || { nodes: [] };
  }

  /**
   * 只存"候选名单"：h/p/cc 是事实（这地址在这个机房连得上），不是"谁更好"。
   * 不要再把 ms/tcp/tls/n/f/b/sb 写进来 —— 每个 isolate 的最优节点可能完全不同，
   * 别的 isolate 的延迟/吞吐/成功率对本地没有可迁移价值，只会把冷启动带偏。
   */
  packName(k: string) {
    const a = (NODE_MEMORY.alive.get(k) || {}) as NodeEntry;
    const [partHost, partPort] = splitRelay(k, 443);
    // IP 质量是跨机房有意义的客观属性，搭 seed 便车传播（不增加 KV 写次数）。
    // 连通性 RTT / 探测新鲜度是实测值，按硬约束留在本 isolate，不写进来。
    const q = QUALITY.get(k);
    return { k, h: a.h || partHost, p: a.p || partPort, cc: a.cc || "", q: q || undefined };
  }

  /**
   * 读信誉表（30 分钟缓存）。v2 单表结构会迁移成 byColo 分桶。
   * @param {object} env Worker 环境
   * @returns {Promise<object>} SEED
   */
  async read(env: Env) {
    if (this.readAt && Date.now() - this.readAt < SEED_READ_MS) return this.document;
    let v = null;
    try {
      v = await kvGetStrict<Seed>(env, SEED_KEY);
      this.readFailed = false;
    } catch (e) {
      // 读失败 ≠ 空表：记下来，write 绝不能拿空表覆盖别的机房
      this.readFailed = true;
    }
    if (v && Array.isArray(v.nodes) && !v.byColo) {
      // 旧结构：整张表属于"当前机房"，迁移时不做跨机房假设
      v = {
        v: SEED_VER,
        ts: v.ts || 0,
        poolGen: v.poolGen || 0,
        poolN: v.poolN || 0,
        builtAt: v.builtAt || 0,
        byColo: { [ISOLATE.colo || "??"]: { nodes: v.nodes, ts: v.ts || 0 } },
      };
    }
    if (v && v.byColo) {
      this.document = {
        v: SEED_VER,
        ts: v.ts || 0,
        poolGen: v.poolGen || 0,
        poolN: v.poolN || 0,
        builtAt: v.builtAt || 0,
        byColo: v.byColo || {},
        cnt: v.cnt || null,
      };
      this.gen = (v.cnt || null) as CounterDoc | null;
      // 只有锚点的代际不比本地旧时才认它的建池时间：本地刚建完第 7 代、锚点还停在第 6 代时，
      // 把 111 写回去等于把「这块池子是什么时候建的」也一起回退了（write 的池子锚点会拿它落盘）。
      if ((Number(v.poolGen) || 0) >= (POOL_MEMORY.generation || 0)) POOL_MEMORY.builtAt = Number(v.builtAt) || 0;
      // 老版本把延迟/吞吐/成功率/站点偏好写了进来：一律不读（每个 isolate 各自估自己的），
      // 下一轮 write 会用新结构整体覆盖，30 天 TTL 兜底。
      // 唯一的例外是 IP 质量 q：它是客观属性（这地址是住宅/机房、风险位），跨机房有意义，
      // 由 seed 携带传播。这里把它采纳进本 isolate 的质量表；连通性 RTT 仍不传播。
      for (const bucket of Object.values(v.byColo)) {
        for (const n of bucket.nodes || []) {
          if (n && n.k && n.q) QUALITY.note(n.k, n.q);
        }
      }
    }
    // 读到空表时只缓存 1 分钟：否则一个刚部署的 isolate 会"空着"整整半小时，
    // 期间该机房所有连接都只能直连。
    const hasAny = !!(this.document && this.document.byColo && (this.bucket().nodes || []).length);
    // 读失败 / 读到空表都只当缓存 1 分钟（提前 29 分钟过期）
    this.readAt = this.readFailed || !hasAny ? Date.now() - SEED_READ_MS + 60000 : Date.now();
    return this.document;
  }

  /**
   * 功能：算出这次落盘要写进共享锚点的池子代际、规模与建池时间。
   * 旧口径是「本地优先」（`POOL_MEMORY.generation || this.document.poolGen`），但本地 `POOL_MEMORY.rows` 完全可能停在旧代：
   * `ensurePool` 是内存优先的，一个从不重建池子的 isolate 每 55 分钟照样落盘一次，
   * 于是它把别的 isolate 刚写上去的新代际与更大的 `poolN` 一起改小 —— 后起的 isolate
   * 按锚点读回旧代池子，`commitPool` 再按 `max+1` 算代，正好撞回已经存在的更新代，
   * 把别人刚建好的池子覆盖掉（KV 没有 CAS，这个回退把「并发撞车」变成了「必然撞车」）。
   * 所以代际单调：本地比锚点新才用本地；同代取较大的规模；本地更旧就原样沿用锚点。
   * @returns {{gen: number, n: number, builtAt: number}} 代际、规模、建池时间
   */
  private poolAnchor() {
    const gLocal = POOL_MEMORY.generation || 0;
    const gSeed = Number(this.document.poolGen) || 0;
    const nSeed = Number(this.document.poolN) || 0;
    const atSeed = Number(this.document.builtAt) || 0;
    if (gLocal > gSeed) return { gen: gLocal, n: POOL_MEMORY.rows.length || nSeed, builtAt: POOL_MEMORY.builtAt || atSeed };
    if (gLocal === gSeed) return { gen: gSeed, n: Math.max(POOL_MEMORY.rows.length, nSeed, 0), builtAt: Math.max(POOL_MEMORY.builtAt || 0, atSeed) };
    return { gen: gSeed, n: nSeed, builtAt: atSeed };
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
    if (this.readFailed) return { ok: false, err: "seed read failed" };
    // 全局写节流：任何 isolate 落盘前先看 seed 上的时间戳。
    // 8 个 isolate 各自 30 分钟一写 = 384/天，加上现有的就顶到额度了。
    if (!force && Date.now() - (this.document.ts || 0) < 20 * 60000) return { ok: true, skipped: true };
    // KV 写失败时要能恢复内存状态：否则 seedAt/ts 被推进，调用方以为已落盘
    const prevSeed = this.document,
      prevG = this.gen,
      prevDirty = NODE_MEMORY.statisticsDirty,
      prevAt = this.readAt;
    let sentDelta: Record<string, number> | null = null;
    const bucket = this.bucket();
    const base = new Map();
    for (const n of bucket.nodes || []) if (n && n.k) base.set(n.k, { ...n });
    // 顺序很重要：alive 在前。listOnly（cron 不知道自己在哪个机房）按插入顺序截断，
    // 如果先遍历旧 base，新探到的节点会一直排在第 41 位之后，全局名单永远不更新。
    const keys = new Set([...NODE_MEMORY.alive.keys(), ...base.keys(), ...NODE_MEMORY.stats.keys()]);
    const rows: SeedNode[] = [];
    for (const k of keys) {
      if (!k || k.lastIndexOf(":") <= 0) continue;
      rows.push(this.packName(k));   // 只存名字：两模式、两机房、任何 isolate 都一样
    }
    const scored = rows.map((n) => ({ n, v: listOnly ? 0 : costOf(n.k, "lat") }));
    scored.sort((a, b) => a.v - b.v);
    const nodes = scored.slice(0, SEED_MAX).map((x) => x.n);
    if (!nodes.length) {
      // 没有节点可写：只把池子代际等全局字段刷上去，别动任何机房的桶
      const pa0 = this.poolAnchor();
      this.document = {
        ...this.document,
        v: SEED_VER,
        ts: Date.now(),
        poolGen: pa0.gen,
        poolN: pa0.n,
        builtAt: pa0.builtAt,
        cnt: this.document.cnt || null,
      };
      try {
        await kvSet(env, SEED_KEY, this.document, { expirationTtl: PX_TTL });
        NODE_MEMORY.statisticsDirty = false;
        return { ok: true, empty: true };
      } catch (e) {
        this.document = prevSeed;
        this.gen = prevG;
        NODE_MEMORY.statisticsDirty = prevDirty;
        this.readAt = prevAt;
        return { ok: false, err: String(errMsg(e)).slice(0, 80) };
      }
    }
    // 全局日计数合并进 seed（跨 isolate 聚合，最多 20 分钟延迟）
    const d0 = new Date().toISOString().slice(0, 10);
    const gc: CounterDoc = this.document.cnt && this.document.cnt.d === d0 ? ({ ...this.document.cnt } as CounterDoc) : { d: d0 };
    const dlt = cntDelta();
    sentDelta = dlt;
    for (const [k, n] of Object.entries(dlt)) gc[k] = (Number(gc[k]) || 0) + n;

    const byColo = { ...(this.document.byColo || {}) };
    // 站点偏好（hostNode）不再落盘：哪家 CDN 在这个机房里对哪个节点友好，
    // 是这一台 isolate 的量，写进共享表只会互相污染。
    byColo[this.coloKey()] = {
      ts: Date.now(),
      lastSwitch: Math.max(SELECTION_MEMORY.switchedAt.lat || 0, SELECTION_MEMORY.switchedAt.tput || 0),
      nodes,
    };
    // 全局候选名单：任何一次落盘都用当前名单刷新。只带 k/h/p/cc，
    // 让还没跑过 cron 的机房也能拿到节点，而不是干等 30 分钟。
    if (nodes.length) {
      byColo[BUCKET_DEF] = {
        ts: Date.now(),
        nodes: nodes.map((n) => ({ k: n.k, h: n.h, p: n.p, cc: n.cc || "" })),
      };
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
    const pa = this.poolAnchor();
    this.document = {
      v: SEED_VER,
      ts: Date.now(),
      poolGen: pa.gen,
      poolN: pa.n,
      builtAt: pa.builtAt,
      byColo,
      cnt: gc,
    };
    this.gen = gc as CounterDoc;
    NODE_MEMORY.statisticsDirty = false;
    this.readAt = Date.now();
    try {
      await kvSet(env, SEED_KEY, this.document, { expirationTtl: PX_TTL });
      return { ok: true };
    } catch (e) {
      this.document = prevSeed;
      this.gen = prevG;
      NODE_MEMORY.statisticsDirty = prevDirty;
      this.readAt = prevAt;
      if (sentDelta) cntUnsend(sentDelta);
      return { ok: false, err: String(errMsg(e)).slice(0, 80) };
    }
  }
}

/** seed 表本地状态的进程内唯一实例 */
export const SEED_STORE = new SeedStore();

/** 变化驱动的落盘节流：90 分钟地板，避免每条连接都打 KV */
export function markSeedDirty(env: Env) {
  if (!env || !env.STATS) return;
  const last = Math.max(SEED_STORE.nodeWrittenAt, SEED_STORE.document.ts || 0);
  if (Date.now() - last < SEED_WRITE_GAP) return;
  SEED_STORE.nodeWrittenAt = Date.now();
  SEED_STORE.write(env).catch(() => {});
}

