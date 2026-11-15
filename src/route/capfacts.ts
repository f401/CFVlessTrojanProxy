/**
 * 吞吐容量事实（v8 §5.1 的 R1 噪声门 + R2 记比值）。
 *
 * 为什么需要它：中继的下载速度差异有时是 6 倍（1642 vs 275 KB/s，白天可学），
 * 有时完全没有差异（同一中继跨轮 0.82–1.74 倍、Spearman −0.49，凌晨全一样慢）。
 * 如果不设噪声门，"把吞吐路由到最优节点" 就会把随机噪声当能力，越学越差。
 *
 * 三条纪律（与文档 §5.1 一致）：
 * - R1：同一中继两次取样相差 ≤1.5 倍，且与池内中位数相差 ≥2 倍，才记一条容量比。
 * - R2：只记相对比值（`cap = 速率 / 池内中位数`，夹在 0.5–2.0），不记绝对 KB/s ——
 *   绝对速度取决于客户端到边缘那一段，换 isolate、换时段就变，记它没有迁移价值。
 * - R3：没有可学差异时不假装优化（返回 1，排序退回 ttfb）。
 */
import { cnt } from "../core/counter";

/** 容量比的有效期：10 分钟。太长会把过期的拥塞状态当成能力。 */
export const CAP_TTL = 600_000;
/** 最多记录多少条中继。 */
export const CAP_MAX = 256;
/** R1 的一致性容差：两次取样比值必须落在 [1/1.5, 1.5] 内。 */
export const CAP_SAME = 1.5;
/** R1 的显著度门槛：与池内中位数相差至少 2 倍才值得记。 */
export const CAP_SIG = 2;
/** R2 的夹取范围。 */
export const CAP_LO = 0.5;
export const CAP_HI = 2;

/**
 * 功能：把任意数值夹到 `[lo, hi]`。
 * @param v 输入值
 * @param lo 下界
 * @param hi 上界
 * @returns {number} 夹取后的值
 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 功能：取一组数的中位数（偶数个取中间两个的均值）；空数组返回 0。
 * 为什么要中位数而不是均值：一次极慢的样本（例如被限流的 3 KB/s）会把均值拖垮，
 * 而它并不代表池子的典型速度。
 * @param xs 样本数组（内部会复制后排序，不改调用方的数组）
 * @returns {number} 中位数
 */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * 功能：吞吐容量表 —— 按中继记录"相对池内中位数的容量比"，带噪声门与有效期。
 * 只在本 isolate 内生效（容量与客户端到边缘的路径强相关，跨 isolate 共享没有意义）。
 */
export class CapFacts {
  /** 中继 → 最近两次取样、最后一次取样时刻与已确认的容量比。 */
  private rows = new Map<string, { s: number[]; cap: number; at: number; seen: number }>();
  /** 最近取样池，用于算中位数（上限 64 条，先进先出）。 */
  private pool: number[] = [];

  /**
   * 功能：登记一次吞吐取样，必要时把结果固化成容量比。
   * @param ip 中继 IP
   * @param kbs 本次下载速率（KB/s）
   * @param now 当前时间
   * @returns {boolean} 本次是否真的记下了一条容量比
   */
  note(ip: string, kbs: number, now = Date.now()): boolean {
    if (!ip || !(kbs > 0)) return false;
    // 取样池只留最近 64 条：中位数要反映"当下的池子"，不是历史全量
    this.pool.push(kbs);
    if (this.pool.length > 64) this.pool.shift();
    const row = this.rows.get(ip) || { s: [], cap: 1, at: 0, seen: 0 };
    row.s.push(kbs);
    if (row.s.length > 2) row.s.shift();
    row.seen = now;
    this.rows.set(ip, row);
    // 上限必须在这里执行，而不是只在「确认成功」那条路径上：R1 要求两次取样一致
    // 且与池内中位数差 2 倍，绝大多数中继只会留下 `at = 0` 的行，于是 trim 几乎
    // 不会被调用 —— 表能一路涨到「本 isolate 见过的中继数」（实测 300 条一条不裁）
    if (this.rows.size > CAP_MAX) this.trim(now);
    // R1 第一关：样本本身要先自证一致，否则放弃这一次（噪声不进模型）
    if (row.s.length < 2) return false;
    const a = row.s[0];
    const b = row.s[1];
    const same = Math.max(a, b) / Math.max(1, Math.min(a, b));
    if (same > CAP_SAME) {
      row.s.length = 0;
      cnt("capNoise");
      return false;
    }
    const med = median(this.pool);
    if (!med) return false;
    const ratio = (a + b) / 2 / med;
    // R1 第二关：与池内中位数的差距要够显著，否则"第 3 名比第 5 名快 1.1 倍"没有意义
    if (ratio < CAP_SIG && ratio > 1 / CAP_SIG) {
      row.s.length = 0;
      cnt("capNoise");
      return false;
    }
    row.cap = clamp(ratio, CAP_LO, CAP_HI);
    row.at = now;
    this.rows.set(ip, row);
    this.trim(now);
    cnt("capSet");
    return true;
  }

  /**
   * 功能：读一条中继的容量比（过期或没学过都返回 1 = 中性）。
   * @param ip 中继 IP
   * @param now 当前时间
   * @returns {number} 容量比，范围 0.5–2.0
   */
  capOf(ip: string, now = Date.now()): number {
    const row = this.rows.get(ip);
    if (!row) return 1;
    // 未确认的行也要能过期：`at` 恒为 0，只按它判寿命的话「试过但没过门」的中继会在 isolate 里永生
    const last = Math.max(row.at, row.seen);
    if (!last || now - last > CAP_TTL) {
      this.rows.delete(ip);
      return 1;
    }
    if (!row.at) return 1;
    return row.cap;
  }

  /**
   * 功能：把容量比换算成代价倍数 —— 只在吞吐模式生效。
   * 为什么延迟模式不乘：延迟模式的代价函数是首字节时间，带宽对它有 0 解释力；
   * 乘上去只会让"快但首字节远"的中继被误判成好。
   * @param ip 中继 IP
   * @param mode 当前模式（`lat` 只看首字节）
   * @param now 当前时间
   * @returns {number} 代价倍数（≤1 表示更快、更便宜）
   */
  factor(ip: string, mode: string, now = Date.now()): number {
    if (mode === "lat") return 1;
    const cap = this.capOf(ip, now);
    // 容量比 2 → 代价 ×0.5；容量比 0.5 → 代价 ×2
    return 1 / cap;
  }

  /**
   * 功能：给 `/health` 用的快照（按容量比降序）。
   * @param now 当前时间
   * @returns {Array<{ ip: string; cap: number }>} 容量比列表
   */
  snap(now = Date.now()): Array<{ ip: string; cap: number }> {
    const out: Array<{ ip: string; cap: number }> = [];
    for (const [ip, row] of this.rows) {
      if (!row.at || now - row.at > CAP_TTL) continue;
      out.push({ ip, cap: Number(row.cap.toFixed(2)) });
    }
    return out.sort((x, y) => y.cap - x.cap);
  }

  /**
   * 功能：清空（测试用）。
   */
  clear(): void {
    this.rows.clear();
    this.pool.length = 0;
  }

  /**
   * 功能：有界淘汰 —— 先删过期，再按记录时间删最旧。
   * @param now 当前时间
   */
  private trim(now: number): void {
    for (const [ip, row] of this.rows) {
      // 未确认的行按「最后一次取样」算寿命；确认过的行用 `at`（确认时间）
      const last = Math.max(row.at, row.seen);
      if (!last || now - last > CAP_TTL) this.rows.delete(ip);
    }
    if (this.rows.size <= CAP_MAX) return;
    const all = [...this.rows.entries()].sort((x, y) => Math.max(x[1].at, x[1].seen) - Math.max(y[1].at, y[1].seen));
    for (let i = 0; i < all.length - CAP_MAX; i += 1) this.rows.delete(all[i][0]);
  }
}

/** 全局容量表。 */
export const CAP = new CapFacts();

/**
 * 功能：薄包装 —— 登记一次吞吐取样。
 * @param ip 中继 IP
 * @param kbs 速率（KB/s）
 * @returns {boolean} 是否记下容量比
 */
export function capNote(ip: string, kbs: number): boolean {
  return CAP.note(ip, kbs);
}

/**
 * 功能：薄包装 —— 读代价倍数（吞吐模式）。
 * @param ip 中继 IP
 * @param mode 模式
 * @returns {number} 代价倍数
 */
export function capFactor(ip: string, mode: string): number {
  return CAP.factor(ip, mode);
}
