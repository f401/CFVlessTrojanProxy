/**
 * 有界的「键 → 行」表：把「先删过期、超限再按时间收到低水位」这条淘汰规则收在一处。
 *
 * 为什么用继承而不是再写一组自由函数：这条规则在仓里至少出现在四处
 * （站点×中继样本、站点无关聚合、起搏记账、中继存活），过去每处各写一遍，
 * 于是出现了 7.250 那类「上限判在插入之前、表稳定停在 max+1」的偏差。
 * 继承 `Map` 之后，容量、寿命、淘汰顺序只有一个实现，读的人不必逐个核对。
 *
 * 低水位的理由：淘汰要排序，排序是 O(n log n)。如果每插一条就收到正好 `max`，
 * 每条样本都要排一次整表（`Connection.flush` 的热路径）；一次收下 `max/8` 的余量，
 * 就把开销摊薄成「每 `max/8` 次插入排一次」。
 */
import type { DurationMs, EpochMs } from "./types";

/** 构造参数：容量上限、可选寿命、以及「这一行的时间戳」怎么取 */
export interface BoundedOptions<Row> {
  /** 表内最多保留多少条 */
  max: number;
  /** 行多久算过期（毫秒）；不传表示永不过期 */
  ttlMs?: DurationMs;
  /** 取一行的时间戳（淘汰与过期都用它，必须是绝对时刻） */
  timeOf: (row: Row) => EpochMs;
}

/**
 * 有容量与寿命上限的 Map。
 */
export class BoundedMap<Key, Row> extends Map<Key, Row> {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly timeOf: (row: Row) => EpochMs;

  /**
   * @param options 容量、寿命与行时间戳的取法
   */
  constructor(options: BoundedOptions<Row>) {
    super();
    this.max = Math.max(1, Math.floor(options.max));
    this.ttlMs = Math.max(0, Math.floor(options.ttlMs || 0));
    this.timeOf = options.timeOf;
  }

  /**
   * 功能：清理这张表 —— 先删过期，仍超限就按时间从旧到新收到 7/8 低水位。
   * 调用点必须在**插入之后**调用它（7.250 的偏差就是把它写在了插入之前）。
   * @param now 当前时刻（毫秒时间戳，测试可注入）
   * @param lowWater 是否一次收下 1/8 余量（热点路径用 true；每轮只清一次的账本用 false，收得刚好等于上限）
   * @returns 本次删掉的条数
   */
  prune(now: EpochMs, lowWater = true): number {
    let dropped = 0;
    if (this.ttlMs > 0) {
      // 先按寿命清：过期的行就算没超限也不该继续影响判断
      for (const [key, row] of this) {
        if (now - this.timeOf(row) > this.ttlMs) {
          this.delete(key);
          dropped += 1;
        }
      }
    }
    if (this.size <= this.max) return dropped;
    const target = lowWater ? Math.max(1, this.max - Math.floor(this.max / 8)) : this.max;
    const ordered = [...this].sort((a, b) => this.timeOf(a[1]) - this.timeOf(b[1]));
    for (const [key] of ordered.slice(0, this.size - target)) {
      this.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  /**
   * 功能：容量上限（面板与测试用，避免调用方各自再抄一份常数）。
   * @returns 表的上限
   */
  capacity(): number {
    return this.max;
  }

  /**
   * 功能：行的寿命（毫秒，0 表示永不过期）。
   * @returns 寿命
   */
  lifeMs(): DurationMs {
    return this.ttlMs;
  }
}
