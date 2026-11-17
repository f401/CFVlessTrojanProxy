// 「站点 × 中继」成功率表本体（v8 §5 的 `ps`）：唯一会从真实流量里学到的软证据。
//
// 为什么需要它：出口族（`eg`）只能说明「这条中继的出口是 v4 还是 v6」，而实测里同一个
// 出口族内部差别同样巨大 —— `193.181.211.185` 的出口始终是 `2a0f:f01:208:3ba::`，
// 同一分钟里 x.com 有时 200 有时 403（2/5）。所以「这一对（站点, 中继）能不能过」
// 只能靠真实请求的成败一点点累积，不能从族先验推出来。
//
// 三条纪律（违反任意一条都会重演线上事故）：
// 1) 只折价、不过滤：本模块的输出只能乘进代价，永远不能把候选从集合里删掉。
//    7.57 的通配硬封锁把可用池从 8 条打剩 2 条，成功率 97% → 2/20。
// 2) 折价相对**自己的先验**：没有样本时因子恒为 1，冷启动行为与接入前逐位相同；
//    否则新版本上线当天就会把所有「还没量过」的中继整体降权。
// 3) 有界 + 会衰减：表上限 512 行，45 分钟没再被观测就当作没有样本。
import { cnt } from "../core/counter";
import { PsOutbox } from "./ps-outbox";
import { psPrior } from "./ps-prior";
import {
  FACTOR_HI,
  FACTOR_LO,
  N_CAP,
  PS_K,
  PS_MAX,
  PS_TTL,
  toQ,
  type PsKey,
  type PsRow,
  type PsWire,
} from "./ps-types";

/**
 * 功能：「站点 × 中继」成功率表。只在本 isolate 内存里累积，随上报管道同步给 Meter。
 *
 * 与 `relperf` 的区别：那里记的是**性能**（首字节 / 吞吐），这里记的是**能不能过**。
 * 两者都按 `站点|中继` 存，但寿命与用法不同：性能 10 分钟、成功率 45 分钟；
 * 性能进代价的加数，成功率进代价的**乘数**。
 */
export class PsFacts {
  private rows = new Map<PsKey, PsRow>();
  /** 待上报队列：pending/sent 的纪律（只有 ack 才清）住在它自己的类里 */
  private outbox = new PsOutbox();

  /**
   * 功能：记录一次真实观测（EWMA：乘 0.98 衰减，新样本权重 1）。
   * @param {string} host 目标站点
   * @param {string} ip 中继 IP
   * @param {boolean} ok 是否拿到完整响应（`down > 64`）
   * @param {number} now 观测时间
   * @returns {void}
   */
  note(host: string, ip: string, ok: boolean, now = Date.now()): void {
    if (!host || !ip) return;
    // 键与两张表共用一种拼法：`eg`/`blk` 用同一个键，才能按「站点 × 中继」互相印证
    const k = host + "|" + ip;
    const cur = this.rows.get(k);
    // 衰减：老样本乘 0.98、封顶 32 —— 一个上午前的 10 次成功不该压住刚才的连续失败
    const n0 = cur ? Math.min(N_CAP, cur.n * 0.98) : 0;
    const q0 = cur ? cur.q : toQ(psPrior(ip, now));
    const n = Math.min(N_CAP, n0 + 1);
    const q = (q0 * n0 + 255 * (ok ? 1 : 0)) / Math.max(1e-9, n0 + 1);
    // 历史最好：只升不降，和 `q` 的衰减分开记（康复通道要用它，见 `PsRow.top`）
    const top = Math.max(cur?.top ?? 0, ok ? 255 : 0);
    const row: PsRow = { q: Math.round(q), n, at: now, top };
    this.rows.set(k, row);
    // 观测同时进待上报队列：DO 侧的事实要能跨 isolate 传播（重发即重试）
    this.outbox.push(k, row);
    cnt("psNote");
    if (this.rows.size > PS_MAX) this.drop(now);
  }

  /**
   * 功能：读这条通道历史上拿到整页的比例（0..1），没有样本返回 -1。
   * 为什么需要单独一个：`factor()` 会把「没样本」伪装成「中等」，而康复通道要区分
   * 「从没试过」与「试过且成过、后来被降权了」—— 后者才值得放一条康复请求。
   * @param host 目标站点
   * @param ip 中继出口 IP
   * @param now 当前时间（毫秒）
   * @returns 历史成功率，或 -1 表示无样本
   */
  okOf(host: string, ip: string, now = Date.now()): number {
    const r = this.get(host, ip, now);
    return r ? r.q / 255 : -1;
  }

  /**
   * 功能：这条通道**曾经**拿到过的最好结果（0..1），没有样本返回 -1。
   *
   * 与 `okOf` 的区别：`okOf` 是「现在还行不行」（均值会随失败衰减），这里是「行过没有」（只升不降）。
   * 康复通道（`policy.ts` 每 20 条放一条）必须用后者 —— 它的用途正是给「被降权、但如果一直
   * 拿不到样本就永远回不来」的通道一次机会；用会衰减的均值当闸门，等于把这件事交给运气。
   * @param host 目标站点
   * @param ip 中继出口 IP
   * @param now 当前时间（毫秒）
   * @returns 历史最好值，或 -1 表示无样本
   */
  bestOf(host: string, ip: string, now = Date.now()): number {
    const r = this.get(host, ip, now);
    if (!r) return -1;
    return (r.top ?? r.q) / 255;
  }

  /**
   * 功能：读取原始成功率（0..1），并按样本数向先验收缩；没有样本或已过期返回 NaN。
   * @param {string} host 目标站点
   * @param {string} ip 中继 IP
   * @param {number} now 当前时间
   * @returns {number} 0..1 或 NaN
   */
  pOf(host: string, ip: string, now = Date.now()): number {
    const r = this.rows.get(host + "|" + ip);
    if (!r || now - r.at > PS_TTL) return NaN;
    // 样本越少越靠近先验：`n` 个样本 + K 个先验样本的加权平均
    const prior = psPrior(ip, now);
    return (r.q / 255) * r.n / (r.n + PS_K) + prior * PS_K / (r.n + PS_K);
  }

  /**
   * 功能：取一行样本，过期返回 null（过期即删，避免回收逻辑散在各处）。
   * @param host 目标站点
   * @param ip 中继 IP
   * @param now 当前时间
   * @returns 样本行或 null
   */
  private get(host: string, ip: string, now: number): PsRow | null {
    const r = this.rows.get(host + "|" + ip);
    if (!r) return null;
    if (now - r.at > PS_TTL) {
      this.rows.delete(host + "|" + ip);
      return null;
    }
    return r;
  }

  /**
   * 功能：折价因子 —— 代价要乘的那个数。没有样本时恒为 1（接入前后逐位相同）。
   * @param {string} host 目标站点
   * @param {string} ip 中继 IP
   * @param {number} now 当前时间
   * @returns {number} 0.5..2（>1 表示比先验更差，要更贵）
   */
  factor(host: string, ip: string, now = Date.now()): number {
    const p = this.pOf(host, ip, now);
    if (!Number.isFinite(p)) return 1;
    const prior = psPrior(ip, now);
    // 因子 > 1 表示「比先验更差，要更贵」：所以是 prior / p，不是 p / prior
    // （第一版写反了，单测立刻抓到：两次失败反而变便宜）
    const f = prior / Math.max(0.05, p);
    return Math.max(FACTOR_LO, Math.min(FACTOR_HI, f));
  }

  /** 功能：导出待上报增量（委托给队列，未 ack 的行会被重复给出）。@returns {PsWire[]} 最多 60 行 */
  delta(): PsWire[] {
    return this.outbox.delta();
  }

  /** 功能：上报成功 —— 待发转已发（委托给队列）。@returns {void} */
  ack(): void {
    this.outbox.ack();
  }

  /** 功能：上报失败 —— 丢弃待发，下轮重算（委托给队列）。@returns {void} */
  nack(): void {
    this.outbox.nack();
  }

  /**
   * 功能：合并远端事实（冷启动一次灌入）。只认更新的观测，绝不用旧值覆盖新值。
   *
   * 不做时间过期判断（只做容量淘汰）：回放或测试里带旧 `at` 的行不该被当成「过期」丢掉，
   * 否则「合并」这件事在单测里不可测（踩过：`trim(now)` 让合并后的族恒为空）。
   * @param {PsWire[]} rows 远端行
   * @returns {number} 真正合并的条数
   */
  load(rows: PsWire[]): number {
    let n = 0;
    for (const r of rows) {
      // 三道门：形状（必须是 `站点|中继`）、数值、以及「不比本地旧」
      if (!r || typeof r.k !== "string" || !r.k.includes("|")) continue;
      const q = Number(r.q);
      const cntN = Number(r.n);
      const at = Number(r.at);
      if (!Number.isFinite(q) || !Number.isFinite(cntN) || !Number.isFinite(at)) continue;
      const cur = this.rows.get(r.k);
      if (cur && cur.at >= at) continue;
      // 线格式现在带 top（v7.163）：历史最好只升不降，取「远端报的 / 当前均值 / 本地已知」三者最大。
      // 旧行（或跨版本的 DO 数据）没有 top：按当前均值起算，宁可低估也不能假装「曾经行过」。
      const qq = Math.max(0, Math.min(255, Math.round(q)));
      const wTop = Number(r.top);
      const top = Math.max(cur?.top ?? 0, qq, Number.isFinite(wTop) ? Math.max(0, Math.min(255, Math.round(wTop))) : 0);
      this.rows.set(r.k, { q: qq, n: Math.max(0, Math.min(N_CAP, cntN)), at, top });
      n += 1;
    }
    if (this.rows.size > PS_MAX) this.drop(0);
    return n;
  }

  /**
   * 功能：给 `/health` 与单测看的快照（按样本数降序，最多 12 行）。
   * @param {string} host 只看某个站点时传它的名字，空串表示全部
   * @returns {Array<{ k: string; q: number; n: number; at: number; top: number }>} 快照
   */
  snap(host = ""): Array<{ k: string; q: number; n: number; at: number; top: number }> {
    const out: Array<{ k: string; q: number; n: number; at: number; top: number }> = [];
    // 只给 12 行：`/health` 是给人看的仪表，不是全量导出（要看全量用 `/debug?pss=1`）
    for (const [k, r] of this.rows) {
      if (host && !k.startsWith(host + "|")) continue;
      out.push({ k, q: r.q, n: r.n, at: r.at, top: r.top ?? r.q });
    }
    out.sort((a, b) => b.n - a.n || b.at - a.at);
    return out.slice(0, 12);
  }

  /** 功能：清空（单测用）。@returns {void} */
  clear(): void {
    this.rows.clear();
    this.outbox.clear();
  }

  /**
   * 功能：容量淘汰 —— 先扔过期行，再按 `at` 升序扔最旧的，直到回到上限。
   * @param {number} now 当前时间（0 表示只做容量淘汰，不过期）
   * @returns {void}
   */
  private drop(now: number): void {
    // `now = 0` 是「只做容量淘汰」：`load()` 走这条路，因为回放里的旧 `at` 不算过期
    if (now > 0) {
      for (const [k, r] of this.rows) if (now - r.at > PS_TTL) this.rows.delete(k);
    }
    if (this.rows.size <= PS_MAX) return;
    const keys = [...this.rows.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of keys) {
      if (this.rows.size <= PS_MAX) break;
      this.rows.delete(k);
    }
  }
}
