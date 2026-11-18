// alive 存活表 + 探活冷却表 + 探活结果分类：池子侧「谁能用」的三件事都收在这里，
// 免得 cronScan 与 warm 各自去摸 `S.alive` / `COOLDOWN.rows` 的字段。

import { SC } from "../core/const";
import { S } from "../core/state";
import { splitRelay } from "../core/relay-addr";
import { CANDS } from "../nodes/score";
import { geoLabel } from "./probe";
import { BUCKET_DEF, SEED_STORE } from "./seed";
import { MODES } from "./const";

/** 冷启动灌进 alive 的节点数：名单里只取前这么多，剩下的靠本机房探活补 */
export const SEED_COLD_N = 48;

/** 长期运行的 alive 上限：池子换代不会永久累积（800 节点 ≈ 1 MB 统计 + candsFor 0.9ms） */
export const ALIVE_MAX = 800;

/**
 * 功能：探活结果分类计数（`ok` / `err` / `notTls` / `noCf`）。
 * @param r 探活结果；`null` 有两种可能（连不上、握手途中异常），它们都只说明「这条可能不行」
 * @returns 无（写进 `S.probeWhy`）
 */
export function noteProbe(r: { bad?: string } | null): void {
  // 连不上与握手异常都归到 err：这两类靠重试才能区分，先不细分
  const k = !r ? "err" : r.bad === "not-tls" ? "notTls" : r.bad === "no-cf-cert" ? "noCf" : "ok";
  S.probeWhy[k] = (S.probeWhy[k] || 0) + 1;
}

/**
 * 「暂时不占探活名额」表。公开池里失败的绝大多数是临时抖动（限流、被墙、机房负载），
 * 所以计数必须带时间戳：以前只记次数、永不衰减，一个节点冷启动时被拒 3 次就永远排在候选之外。
 */
export class ProbeCooldown {
  /** 候选键 → 连续失败次数 + 最后一次失败时间（带时间戳，超时自动作废） */
  readonly rows = new Map<string, { n: number; at: number }>();

  /**
   * 功能：这个候选是否还在冷却期。
   * @param key 候选键（`host:port`）
   * @param now 当前时间（毫秒）
   * @returns 连续失败次数达标且未过 TTL 时为 true
   */
  skip(key: string, now: number = Date.now()): boolean {
    const entry = this.rows.get(key);
    if (!entry || entry.n < SC.SCAN_BAD_MAX) return false;
    // 过期的行按「没冷却」处理：清理留给 sweep()，读路径不顺手删（同一行会被高频读）
    return now - entry.at <= SC.PROBE_BAD_TTL;
  }

  /**
   * 功能：记一次探活结果（成功清掉自己的行，失败累加）。
   * @param key 候选键（`host:port`）
   * @param ok 探活是否通过
   * @param now 当前时间（毫秒）
   * @returns 无
   */
  bump(key: string, ok: boolean, now: number = Date.now()): void {
    if (ok) {
      this.rows.delete(key);
      return;
    }
    const cur = this.rows.get(key);
    // 跨过 TTL 就重新从 1 开始数，否则「上个月失败三次」会一直压着它
    const n = cur && now - cur.at <= SC.PROBE_BAD_TTL ? cur.n + 1 : 1;
    this.rows.set(key, { n: Math.min(9, n), at: now });
  }

  /**
   * 功能：清理冷却表 —— 先删过期的（对 `skip` 已无意义），再按上限淘汰最久没更新的。
   *
   * 为什么要主动扫：键是候选地址，公开池每天换一批，而写入路径只有「失败时新增」与
   * 「成功时删自己那一条」——长命 isolate 见过几万个失败候选后表就一直涨，
   * 且没有任何读路径会因此报错（`skip` 只是每行比较一次）。
   * @param now 当前时间（毫秒）
   * @returns 这一次删掉的行数
   */
  sweep(now: number = Date.now()): number {
    let gone = 0;
    // ① 过期即无用：判据与 skip() 用同一个 TTL，避免两处口径漂移
    for (const [key, entry] of this.rows) {
      if (now - entry.at > SC.PROBE_BAD_TTL) {
        this.rows.delete(key);
        gone += 1;
      }
    }
    // ② 还在 TTL 内但表已经太大：按最久没更新淘汰（值就是时间戳，不必额外维护淘汰序）
    if (this.rows.size > SC.PROBE_BAD_MAX) {
      const oldest = [...this.rows.entries()].sort((a, b) => a[1].at - b[1].at);
      let over = this.rows.size - SC.PROBE_BAD_MAX;
      for (const [key] of oldest) {
        if (over <= 0) break;
        this.rows.delete(key);
        over -= 1;
        gone += 1;
      }
    }
    return gone;
  }
}

/** 探活冷却实例：只有本模块 / scan / warm 通过它读写 */
export const COOLDOWN = new ProbeCooldown();

/**
 * 功能：记一次探活失败/成功（委托 `COOLDOWN.bump`，cronScan 与测试共用，保证「过期重置」只写一遍）。
 * @param key 候选键（`host:port`）
 * @param ok 探活是否通过
 * @param now 当前时间（毫秒）
 * @returns 无
 */
export function bumpProbeBad(key: string, ok: boolean, now: number = Date.now()): void {
  COOLDOWN.bump(key, ok, now);
}

/**
 * 存活表 `S.alive` 的owner：冷启动起点、按惩罚裁剪、按延迟裁剪、国家码补全。
 * 这些规则以前散在 `cronScan` 的四个编号段落里，读的人只能靠行号回忆顺序。
 */
export class AliveBoard {
  /**
   * 功能：本机房的存活节点列表（数量与顺序就是 `S.alive` 的插入序）。
   * @returns 存活条目数组
   */
  list(): NodeEntry[] {
    return [...S.alive.values()];
  }

  /**
   * 功能：冷启动灌入起点：本机房名单 → 名单桶 → 任意机房名单 → 候选池头部 32 条。
   *
   * 每一档都只写「名字 + 先验延迟」：延迟/带宽/成功率全部留在本 isolate，
   * 由本机房的探活与失败学习决定留谁（跨 isolate 共用统计会让选路持续选错）。
   * @returns 无
   */
  seedCold(): void {
    let src: SeedNode[] = SEED_STORE.bucket().nodes || [];
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
      // 没有任何名单可用时，用候选池头部当起步：池子是 CF 优选 IP，对非 CF 目标才有中转价值
      for (const c of S.pool.slice(0, 32)) {
        const k = c.h + ":" + c.p;
        if (!S.alive.has(k)) S.alive.set(k, { h: c.h, p: c.p, cc: "", ms: SC.P_TCP });
      }
    }
    for (const n of src.slice(0, SEED_COLD_N)) {
      if (!n || !n.k) continue;
      const [host0, port0] = splitRelay(n.k, 443);
      // 名单只有「连得上」，没有延迟：统一按先验起步，由本 isolate 自己的样本收敛
      S.alive.set(n.k, { h: n.h || host0, p: n.p || port0, cc: n.cc || "", ms: SC.P_TCP });
    }
  }

  /**
   * 功能：把「被重罚」的节点移出存活表 —— 只裁连续失败到冷却 1 小时以上的。
   *
   * 以前只要 `isBlack` 就删，一次 1 分钟的小冷却也会把好节点踢出池子，
   * 要等下一轮扫描（最长 8 小时）才回来。两个游标永远保留。
   * @param now 当前时间（毫秒）
   * @returns 是否真的删了（删了要清站点排行缓存）
   */
  pruneOverPunished(now: number = Date.now()): boolean {
    let pruned = false;
    for (const key of [...S.alive.keys()]) {
      const s = S.nstat.get(key);
      const ban = s ? (s.blackUntil || 0) - now : 0;
      if (ban > 30 * 60000 && key !== S.curs.tput && key !== S.curs.lat) {
        S.alive.delete(key);
        pruned = true;
      }
    }
    return pruned;
  }

  /**
   * 功能：存活表超过上限时按「先删不在当前池里的、同档先删最慢的」裁到上限。
   *
   * 不能用探活 ms 裁：探活测的是 TLS 握手，和首字节差一大截（仿真里按探活裁 800 个反而更差）。
   * @param pool 当前候选池（用来判断「还在池里」）
   * @param max 存活上限（默认 `ALIVE_MAX`）
   * @returns 是否真的裁了（裁了要清站点排行缓存）
   */
  trimToMax(pool: PoolEntry[], max: number = ALIVE_MAX): boolean {
    if (S.alive.size <= max) return false;
    const inPool = new Set(pool.map((x) => x.h + ":" + x.p));
    const keep = new Set([S.curs.tput, S.curs.lat]);
    const latOf = (key: string, entry: { ms?: number }) => {
      const s = S.nstat.get(key);
      // 优先用实测首字节（pSum），没有才退回探活 ms，最后才是 9999 兜底
      return (s && s.pSum ? s.pSum : 0) || entry.ms || 9999;
    };
    const rows = [...S.alive.entries()].filter(([key]) => !keep.has(key));
    rows.sort((a, b) => {
      const ap = inPool.has(a[0]) ? 0 : 1;
      const bp = inPool.has(b[0]) ? 0 : 1;
      if (ap !== bp) return bp - ap; // 先删不在当前池里的
      return latOf(b[0], b[1]) - latOf(a[0], a[1]); // 同一档先删最慢的
    });
    for (const [key] of rows) {
      if (S.alive.size <= max) break;
      S.alive.delete(key);
    }
    return true;
  }

  /**
   * 功能：给还没有国家码的节点补国家码（一次批量查询，查不到就留空等下一轮）。
   * @returns 无
   */
  async fillCountries(): Promise<void> {
    const need = this.missingCountryHosts();
    if (!need.length) return;
    const geo = await geoLabel(need);
    // 只填还空着的那几条：这一批查询期间可能已经有节点被别的路径填过
    for (const x of S.alive.values()) if (!x.cc && geo[x.h]) x.cc = geo[x.h];
  }

  /**
   * 功能：列出还没有国家码的节点地址（国家码补全的输入）。
   * @returns 需要补国家码的地址数组
   */
  missingCountryHosts(): string[] {
    return [...S.alive.values()].filter((x) => !x.cc).map((x) => x.h);
  }
}


/**
 * 功能：取轮换模块的对外快照。冷启动只继承「本机房」的信誉（名单只有名字）。
 * @param env Worker 环境
 * @returns 当前游标、存活条目与面板状态
 */
export async function pxGet(env: Env) {
  await SEED_STORE.read(env);
  if (!S.alive.size) new AliveBoard().seedCold();
  for (const m of MODES) {
    if (!S.curs[m]) {
      const c = CANDS.list(m);
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
      // 这里不再预先遍历整张 nstat 生成面板明细：nstat 会随扫描变长（实测 2000+），
      // 而每次订阅/面板请求都会走 pxGet —— 2000 条 × 2 次 costOf 纯属白烧 CPU。
      // 需要明细的地方用 nsOf(keys) 按需生成（只算真正要展示的那几个节点）。
    },
  };
}

/**
 * 功能：对外：本机房的存活节点列表（冷启动会先载入名单与游标）。
 * @param env Worker 环境
 * @returns 存活条目数组
 */
export async function aliveList(env: Env): Promise<NodeEntry[]> {
  await pxGet(env);
  return new AliveBoard().list();
}
