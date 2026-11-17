import { FACT_TTL } from "../core/facts";
import { EG } from "./egfacts";
import { cnt } from "../core/counter";
import { FactTable } from "./fact-table";

// 唯一写入口：`src/route/judge.ts` 的判定出口（`PS.note`）；读口是选路层的 `PS.factor` / `PS.bestOf`。
//
// 生命周期（有界化、分批上行、ack/nack 的纪律）继承自 `FactTable`：这张表原来自己有一份
// `PsOutbox`（`pending`/`sent` + `delta`/`ack`/`nack`），与 `eg`/`blk`/`dead`/`dns` 逐字重复 ——
// 抄四遍就会修两遍（7.143 清空 pending 丢证据、7.177 按插入序切片发最旧的）。

/** 事实键：`站点|中继 IP`（`eg` 用 IP、`blk` 用同一个键，方便互相印证） */
export type PsKey = string;

/** 一行成功率统计：`q` 是 0..255 的成功率分位，`n` 是有效样本数 */
export interface PsRow {
  /** 0..255 的成功率（255 = 全成功） */
  q: number;
  /** 有效样本数（上限 32，衰减由乘 0.98 完成） */
  n: number;
  /** 最后一次观测时间 */
  at: number;
  /**
   * 历史最好的一次（0..255）：用来看「这条通道曾经成过」。
   * 与 `q` 分工：`q` 是现在的均值（会衰减），康复通道关心的是「曾经行过」——
   * 用 `q` 做闸门会让「成过一次、后来连着失败」的通道永远进不了康复名单（那是它唯一能回样本的机会）。
   */
  top?: number;
}

/** 一行待上报/已上报的传输形态 */
export interface PsWire {
  /** 事实键 `站点|中继 IP` */
  k: string;
  /** 0..255 成功率 */
  q: number;
  /** 有效样本数 */
  n: number;
  /** 最后观测时间 */
  at: number;
  /**
   * 历史最好（0..255）。旧行没有这个字段（7.163 前不上线）：
   * 缺省时按 `q` 起算，宁可低估也不能假装「曾经行过」。
   */
  top?: number;
}

/** 样本过期时间：45 分钟没再被观测就当没有样本（v8 §3 表） */
export const PS_TTL = FACT_TTL.ps;
/** 表上限：满了按 `at` 淘汰最旧的 */
export const PS_MAX = 512;
/** 平滑强度：先验相当于 4 个样本（Beta(4·p, 4·(1-p)) 的等效） */
export const PS_K = 4;
/** 折价因子的上下界：1/2 ～ 2，防止单次观测把代价翻十倍 */
export const FACTOR_LO = 0.5;
export const FACTOR_HI = 2;
/** 样本数上限：越老的历史越不该压住当前（配合 0.98 衰减） */
export const N_CAP = 32;
/** 一次 `delta()` 最多给出多少行：与子请求预算（50/轮）留余量 */
export const PS_BATCH = 60;

/**
 * 功能：把一条观测合成的成功率（0..1）转成 0..255 的分位。
 * @param {number} p 成功率（会被裁剪到 0..1）
 * @returns {number} 0..255
 */
export function toQ(p: number): number {
  const x = Math.max(0, Math.min(1, p));
  return Math.round(x * 255);
}

// 先验：唯一允许「没量过也先给个数」的地方（由出口族事实回答，v8 §5）。
//
// 先验与表本体分开写的原因：表本体只做贝叶斯收缩；两者混在一起时，
// 「为什么新中继没有被降权」这个问题在代码里找不到唯一答案。

/**
 * 功能：本站点该通道的先验成功率 —— 由出口族事实回答（v4 0.9 / v6 0.45 / 未知 0.83）。
 *
 * 未知取 0.83 而不是 0.5：没量过不等于坏，否则新中继一进池就被整体降权，
 * 而「新中继」恰恰是补货链（v8 §40）唯一的增量来源。
 * @param {string} ip 中继 IP
 * @param {number} now 当前时间
 * @returns {number} 0..1 的先验
 */
export function psPrior(ip: string, now = Date.now()): number {
  const fam = EG.famOf(ip, now);
  if (fam === 4) return 0.9;
  if (fam === 6) return 0.45;
  return 0.83;
}

/**
 * 功能：「站点 × 中继」成功率表。只在本 isolate 内存里累积，随上报管道同步给 Meter。
 *
 * 与 `relperf` 的区别：那里记的是**性能**（首字节 / 吞吐），这里记的是**能不能过**。
 * 两者都按 `站点|中继` 存，但寿命与用法不同：性能 10 分钟、成功率 45 分钟；
 * 性能进代价的加数，成功率进代价的**乘数**。
 *
 * 三条纪律（违反任意一条都会重演线上事故）：
 * 1) 只折价、不过滤：本模块的输出只能乘进代价，永远不能把候选从集合里删掉。
 *    7.57 的通配硬封锁把可用池从 8 条打剩 2 条，成功率 97% → 2/20。
 * 2) 折价相对**自己的先验**：没有样本时因子恒为 1，冷启动行为与接入前逐位相同。
 * 3) 有界 + 会衰减：表上限 512 行，45 分钟没再被观测就当作没有样本。
 */
export class PsFacts extends FactTable<PsRow, PsWire> {
  /** 寿命：45 分钟没再被观测就当没有样本 */
  protected get ttlMs(): number {
    return PS_TTL;
  }

  /** 上限：满了按 `at` 淘汰最旧的 */
  protected get maxRows(): number {
    return PS_MAX;
  }

  /** 每批上限 60 行：一轮的子请求预算只有 50 个，多了也发不出去 */
  protected get batchMax(): number {
    return PS_BATCH;
  }

  /**
   * 功能：把一行编成线格式（键已经是 `站点|中继`）。
   * @param {string} key 事实键
   * @param {PsRow} row 行
   * @returns {PsWire} 线格式
   */
  protected toWire(key: string, row: PsRow): PsWire {
    // 线格式必须带 top：不带的话「曾经成过」在每个新 isolate 里都会退化成「现在还行」（7.163）
    return { k: key, q: row.q, n: row.n, at: row.at, top: row.top ?? row.q };
  }

  /**
   * 功能：把线格式解码成一行（坏行返回 null）。
   * @param {PsWire} wire 线格式
   * @returns {{ key: string; row: PsRow } | null} 键与行；键必须是 `站点|中继` 且三个数值都有限
   */
  protected parseWire(wire: PsWire): { key: string; row: PsRow } | null {
    if (!wire || typeof wire.k !== "string" || !wire.k.includes("|")) return null;
    const q = Number(wire.q);
    const n = Number(wire.n);
    const at = Number(wire.at);
    if (!Number.isFinite(q) || !Number.isFinite(n) || !Number.isFinite(at)) return null;
    const qq = Math.max(0, Math.min(255, Math.round(q)));
    const wTop = Number(wire.top);
    // 旧行（或跨版本的 DO 数据）没有 top：按当前均值起算，宁可低估也不能假装「曾经行过」
    const top = Math.max(qq, Number.isFinite(wTop) ? Math.max(0, Math.min(255, Math.round(wTop))) : 0);
    return { key: wire.k, row: { q: qq, n: Math.max(0, Math.min(N_CAP, n)), at, top } };
  }

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
    // 写入同时登记待上报（基类的 put 会做这件事，并按上限有界化）
    this.put(k, { q: Math.round(q), n, at: now, top }, now);
    cnt("psNote");
  }

  /**
   * 功能：读这条通道历史上拿到整页的比例（0..1），没有样本返回 -1。
   * 为什么需要单独一个：`factor()` 会把「没样本」伪装成「中等」，而康复通道要区分
   * 「从没试过」与「试过且成过、后来被降权了」—— 后者才值得放一条康复请求。
   * @param {string} host 目标站点
   * @param {string} ip 中继出口 IP
   * @param {number} now 当前时间（毫秒）
   * @returns {number} 历史成功率，或 -1 表示无样本
   */
  okOf(host: string, ip: string, now = Date.now()): number {
    const r = this.get(host + "|" + ip, now);
    return r ? r.q / 255 : -1;
  }

  /**
   * 功能：这条通道**曾经**拿到过的最好结果（0..1），没有样本返回 -1。
   *
   * 与 `okOf` 的区别：`okOf` 是「现在还行不行」（均值会随失败衰减），这里是「行过没有」（只升不降）。
   * 康复通道（`policy.ts` 每 20 条放一条）必须用后者 —— 它的用途正是给「被降权、但如果一直
   * 拿不到样本就永远回不来」的通道一次机会；用会衰减的均值当闸门，等于把这件事交给运气。
   * @param {string} host 目标站点
   * @param {string} ip 中继出口 IP
   * @param {number} now 当前时间（毫秒）
   * @returns {number} 历史最好值，或 -1 表示无样本
   */
  bestOf(host: string, ip: string, now = Date.now()): number {
    const r = this.get(host + "|" + ip, now);
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
    const r = this.get(host + "|" + ip, now);
    if (!r) return NaN;
    // 样本越少越靠近先验：`n` 个样本 + K 个先验样本的加权平均
    const prior = psPrior(ip, now);
    return (r.q / 255) * r.n / (r.n + PS_K) + prior * PS_K / (r.n + PS_K);
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

  /**
   * 功能：合并远端事实（冷启动一次灌入）。只认更新的观测，绝不用旧值覆盖新值。
   *
   * 不做过期判断（只做容量淘汰）：回放或测试里带旧 `at` 的行不该被当成「过期」丢掉，
   * 否则「合并」这件事在单测里不可测（踩过：`trim(now)` 让合并后的族恒为空）。
   * @param {PsWire[]} rows 远端行
   * @returns {number} 真正合并的条数
   */
  load(rows: PsWire[]): number {
    let n = 0;
    for (const wire of rows) {
      const one = this.parseWire(wire);
      if (!one) continue;
      const cur = this.rows.get(one.key);
      if (cur && cur.at >= one.row.at) continue;
      // 历史最好只升不降：取「远端报的 / 当前均值 / 本地已知」三者最大（v7.163）
      const top = Math.max(cur?.top ?? 0, one.row.q, one.row.top ?? 0);
      this.rows.set(one.key, { q: one.row.q, n: one.row.n, at: one.row.at, top });
      n += 1;
    }
    this.trim(0);
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

  /**
   * 功能：有界化 —— 未超上限时直接返回，避免每条观测都全表扫一遍。
   * @param {number} now 当前时间（0 表示只做容量淘汰，不做过期扫描）
   * @returns {void}
   */
  protected trim(now: number): void {
    // 热路径护栏：`note` 每条都走这里，未超上限时不必扫 512 行（过期行由 `get`/`entries` 就地删）
    if (this.rows.size <= PS_MAX) return;
    super.trim(now);
  }
}

/** 进程内唯一的成功率事实表 */
export const PS = new PsFacts();
