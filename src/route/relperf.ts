/**
 * 「站点 × 中继」的实测性能记忆（只在本 isolate 内，不跨 isolate 共享）。
 *
 * 为什么要它：同一个中继对不同站点的表现可能差一个数量级 —— 出口在哪个地区、
 * 到目标之间经过哪些中转、目标是否同机房，都会让「能通」和「快」两件事分开。
 * 只看站点无关的中继健康度（RelayHealth）会把「对 A 站很快、对 B 站很慢」的中继
 * 平均成一个中位数，选路就没法按站点选对。
 *
 * 数据从真实连接来（`Connection.flush` 里的首字节耗时与下行速率），用 EWMA 收敛；
 * 条目 10 分钟不用就失效（链路质量会变，旧样本没意义）。表有上限（MAX），
 * 满了先清过期、再按最旧淘汰，避免 isolate 长跑时无限涨。
 */
export const REL_TTL = 600_000;

/** 单条「站点 × 中继」样本 */
export interface RelSample {
  /** 样本条数（EWMA 的有效权重，最多按 8 算） */
  n: number;
  /** 首字节耗时（ms） */
  ttfb: number;
  /** 下行速率（KB/s） */
  kbs: number;
  /** 最后一次更新的时刻 */
  at: number;
}

/** 表内最多保留多少条「站点 × 中继」 */
const MAX = 512;

/**
 * 把样本折算成「1MB 需要多久」的预计耗时，用于排序。
 * @param s 样本（null 表示没量过）
 * @returns 毫秒；没量过返回 1e6（永远排最后，由上层决定要不要试）
 */
export function relCostOf(s: RelSample | null): number {
  if (!s) return 1e6;
  // kbs <= 0 表示「这次只量到首字节，没量到吞吐」（小响应 / 4 字节 403 页 / 连接被掐断）：
  // 不能按小带宽重罚——一个 45KB 的正常首页在 2.5 秒里只有 ~18KB/s，
  // 按 1024KB 折算会得 5.7 万毫秒，比「4 字节 403 页」还贵，排序就会把能用的中继排到最后。
  // 这种样本只给首字节 + 一个固定惩罚，真正的失败信号由负面记忆（JUDGE.negOn）负责。
  if (s.kbs <= 0) return s.ttfb + 2000;
  // 512 KB / (KB/s) 换成 ms，再加首字节；kbs 下限 32 防止除零与「0.1 KB/s 的假样本」爆表
  return s.ttfb + 512_000 / Math.max(32, s.kbs);
}

/**
 * 按模式折算代价：吞吐模式看「拉 1MB 要多久」，延迟模式只看首字节。
 * 为什么分开：同一对（站点, 中继）可能「首字节很快但带宽很小」，反过来也有；
 * 用同一个代价函数会让延迟优先模式被大文件吞吐的样本带偏，吞吐优先模式又会忽略首字节。
 * @param mode 传输模式（`tput` / `lat`）
 * @param s 样本（null 表示没量过）
 * @returns 毫秒；没量过返回 1e6
 */
export function relCostFor(mode: string, s: RelSample | null): number {
  if (!s) return 1e6;
  if (mode === "lat") return s.ttfb;
  if (s.kbs <= 0) return s.ttfb + 2000;
  return s.ttfb + 512_000 / Math.max(32, s.kbs);
}

/**
 * 站点 × 中继的实测性能表。
 */
export class RelPerfTable {
  private m = new Map<string, RelSample>();
  /** 站点无关的聚合样本（同一条中继在所有站点上的表现），用来在新站点上先给个底 */
  private by = new Map<string, RelSample>();

  /**
   * 记一条样本。
   * @param host 站点（`Connection.host`）
   * @param ip 中继出口地址
   * @param ttfb 首字节耗时（ms）
   * @param kbs 下行速率（KB/s）
   * @param now 当前时刻（测试可注入）
   * @returns 无
   */
  note(host: string, ip: string, ttfb: number, kbs: number, now = Date.now()): void {
    if (!host || !ip) return;
    if (!(ttfb >= 0) || !(kbs >= 0)) return;
    if (this.m.size > MAX) this.drop(now);
    const k = host + "|" + ip;
    const old = this.m.get(k);
    if (!old || now - old.at > REL_TTL) {
      this.m.set(k, { n: 1, ttfb, kbs, at: now });
    } else {
      // EWMA：首字节 0.5 权重（抖动大），速率 0.35（变化慢但也要跟得上）
      this.m.set(k, {
        n: Math.min(8, old.n + 1),
        ttfb: old.ttfb * 0.5 + ttfb * 0.5,
        kbs: old.kbs * 0.65 + kbs * 0.35,
        at: now,
      });
    }
    // 站点无关的聚合：新站点第一次命中时才有底可用（见 costFor 的说明）
    const a = this.by.get(ip);
    if (!a || now - a.at > REL_TTL) this.by.set(ip, { n: 1, ttfb, kbs, at: now });
    else this.by.set(ip, { n: Math.min(8, a.n + 1), ttfb: a.ttfb * 0.5 + ttfb * 0.5, kbs: a.kbs * 0.65 + kbs * 0.35, at: now });
  }

  /**
   * 取某站点在某中继上的样本。
   * @param host 站点
   * @param ip 中继出口
   * @param now 当前时刻
   * @returns 样本；没有或已过期返回 null
   */
  get(host: string, ip: string, now = Date.now()): RelSample | null {
    const s = this.m.get(host + "|" + ip);
    if (!s) return null;
    if (now - s.at > REL_TTL) {
      this.m.delete(host + "|" + ip);
      return null;
    }
    return s;
  }

  /**
   * 站点无关的该中继聚合样本（任何站点上量到的都算）。
   * @param ip 中继出口
   * @param now 当前时刻
   * @returns 样本；没有或已过期返回 null
   */
  agg(ip: string, now = Date.now()): RelSample | null {
    const s = this.by.get(ip);
    if (!s) return null;
    if (now - s.at > REL_TTL) {
      this.by.delete(ip);
      return null;
    }
    return s;
  }

  /**
   * 排序代价：没有样本一律 1e6。只认本站点样本（测试与调试用，口径干净）。
   * @param host 站点
   * @param ip 中继出口
   * @param now 当前时刻
   * @returns 预计 1MB 耗时（ms）
   */
  cost(host: string, ip: string, now = Date.now()): number {
    return relCostOf(this.get(host, ip, now));
  }

  /**
   * 按传输模式取排序代价。
   * @param mode 传输模式（`tput` / `lat`）
   * @param host 站点
   * @param ip 中继出口
   * @param now 当前时刻
   * @returns 毫秒；没量过返回 1e6
   */
  costFor(mode: string, host: string, ip: string, now = Date.now()): number {
    const s = this.get(host, ip, now);
    if (s) return relCostFor(mode, s);
    // 本站点还没量过这条中继：用它在别的站点上的表现兜底（+200ms 表示「不是本站点的亲测」）。
    // 为什么要兜底：新站点第一次命中时，若所有中继都是 1e6，排序退化成「按池子顺序」，
    // 等于把已经量到的快中继扔掉重学一遍；而中继出口的容量大体与目标站点无关。
    const a = this.agg(ip, now);
    if (a) return relCostFor(mode, a) + 200;
    return 1e6;
  }

  /**
   * 调试快照：按代价升序列出该站点已经量过的中继。
   * @param host 站点
   * @param now 当前时刻
   * @returns 行数组（ip / 样本数 / 首字节 / 速率 / 年龄 / 代价）
   */
  snap(host: string, now = Date.now()): Array<{ ip: string; n: number; ttfb: number; kbs: number; age: number; cost: number }> {
    const out: Array<{ ip: string; n: number; ttfb: number; kbs: number; age: number; cost: number }> = [];
    for (const [k, s] of this.m) {
      if (!k.startsWith(host + "|")) continue;
      if (now - s.at > REL_TTL) continue;
      out.push({ ip: k.slice(host.length + 1), n: s.n, ttfb: Math.round(s.ttfb), kbs: Math.round(s.kbs), age: now - s.at, cost: Math.round(relCostOf(s)) });
    }
    out.sort((a, b) => a.cost - b.cost);
    return out;
  }

  /**
   * 清空（测试用）。
   * @returns 无
   */
  clear(): void {
    this.m.clear();
    this.by.clear();
  }

  /**
   * 淘汰：先删过期，仍超限就按 at 从旧到新删掉超出的部分。
   * @param now 当前时刻
   * @returns 无
   */
  private drop(now: number): void {
    for (const [k, s] of this.m) if (now - s.at > REL_TTL) this.m.delete(k);
    if (this.m.size <= MAX) return;
    const rows = [...this.m].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of rows.slice(0, this.m.size - MAX)) this.m.delete(k);
  }
}

/** 全局唯一实例（服务 route 层） */
export const RELPERF = new RelPerfTable();

/**
 * 薄包装：记样本（`src/proxy/connection.ts` 通过 HOOK.relPerf 调到）。
 * @param host 站点
 * @param ip 中继出口
 * @param ttfb 首字节耗时（ms）
 * @param kbs 下行速率（KB/s）
 * @returns 无
 */
export function relNote(host: string, ip: string, ttfb: number, kbs: number): void {
  RELPERF.note(host, ip, ttfb, kbs);
}

/**
 * 薄包装：取排序代价。
 * @param host 站点
 * @param ip 中继出口
 * @returns 预计 1MB 耗时（ms），没样本 1e6
 */
export function relCost(host: string, ip: string): number {
  return RELPERF.cost(host, ip);
}

/**
 * 薄包装：调试快照。
 * @param host 站点
 * @returns 该站点已量过的中继（按代价升序）
 */
export function relSnap(host: string) {
  return RELPERF.snap(host);
}

/**
 * 薄包装：按传输模式取排序代价。
 * @param mode 传输模式（`tput` / `lat`）
 * @param host 站点
 * @param ip 中继出口
 * @returns 毫秒；没量过 1e6
 */
export function relCostMode(mode: string, host: string, ip: string): number {
  return RELPERF.costFor(mode, host, ip);
}

/**
 * 薄包装：站点无关的聚合样本（跨站点学到的中继容量）。
 * @param ip 中继出口
 * @returns 样本；没量过返回 null
 */
export function relAgg(ip: string) {
  return RELPERF.agg(ip);
}
