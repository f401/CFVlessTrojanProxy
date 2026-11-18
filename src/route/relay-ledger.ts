// 中继健康表的两张账本（OOP）：`sent` 是上次上行时的计数快照，`pending` 是已交出、还没等到 ack 的行。
//
// 为什么单独成类：这两张表**必须与主表同生同灭**。7.161（第 68 条）与 7.215 那批缺陷都是
// 「一张表删了、关联表没删」，于是键在 `sent`/`pending` 里永久驻留，而 `size()` 只看主表 ⇒ 泄漏完全不可见。
// 把「记账」和「证据」放两个类里，删除路径就只有 `forget()` 一个入口。

/** 一行计数（送上行的形状，短键是线协议） */
interface RelayCounts {
  o: number;
  b: number;
  d: number;
}

/**
 * 待确认行的形状。
 *
 * 与 `relay-health.ts` 的 `LedgerRow` 字段逐一相同（都是线协议键）：这里独立声明而不反向 import，
 * 是为了不造出 `relay-health → relay-ledger → relay-health` 的循环依赖（`check-arch` 会红）。
 */
interface LedgerRow {
  i: string;
  o: number;
  b: number;
  d: number;
  t?: number;
}

/**
 * 中继健康表的两张账本：已同步快照与待确认行。
 *
 * 只被 `RelayHealth` 使用，不对外暴露；`counts()` 让「表外键有没有泄漏」可被观察。
 */
export class RelayLedger {
  private sent = new Map<string, RelayCounts>();
  private pending = new Map<string, LedgerRow>();

  /**
   * 功能：这条中继的计数相对上次同步有没有变化。
   * @param ip 中继 IP
   * @param cur 主表里的当前计数
   * @returns 变过为 true；没变说明 DO 那边已经见过了，不必重发
   */
  changed(ip: string, cur: RelayCounts): boolean {
    const p = this.sent.get(ip);
    return !p || p.o !== cur.o || p.b !== cur.b || p.d !== cur.d;
  }

  /**
   * 功能：这条中继是否已有未确认的行排在队里。
   * @param ip 中继 IP
   * @returns 已排队为 true（同一轮不重复排，重发靠 pending 原样带出）
   */
  queued(ip: string): boolean {
    return this.pending.has(ip);
  }

  /**
   * 功能：排入一行待确认的增量。
   * @param row 要上行的那一行（含最后观测时间 `t`）
   * @returns 无
   */
  queue(row: LedgerRow): void {
    this.pending.set(row.i, row);
  }

  /**
   * 功能：把还没确认的行原样取出来（调用方重试时能带上它们）。
   * @returns 待确认行（顺序不保证）
   */
  waiting(): LedgerRow[] {
    return [...this.pending.values()];
  }

  /**
   * 功能：上报成功——把待确认行提升为「已同步快照」。
   * @param alive 主表里是否还有这条中继（`drop()` 可能已经删了它，写进去会造表外键）
   * @returns 无
   */
  ack(alive: (ip: string) => boolean): void {
    for (const r of this.pending.values()) {
      if (alive(r.i)) this.sent.set(r.i, { o: r.o, b: r.b, d: r.d });
    }
    this.pending.clear();
  }

  /**
   * 功能：上报失败——丢掉待确认行，下一轮的 delta 会按主表当前状态重算一遍。
   * @returns 无
   */
  nack(): void {
    this.pending.clear();
  }

  /**
   * 功能：冷启动合并之后，把快照对齐到表里的当前值（否则下一轮会把已确认的证据再发一次）。
   * @param ip 中继 IP
   * @param cur 合并后的计数
   * @returns 无
   */
  sync(ip: string, cur: RelayCounts): void {
    this.sent.set(ip, { o: cur.o, b: cur.b, d: cur.d });
  }

  /**
   * 功能：主表删掉一条中继时同步删掉两张账本（唯一删除入口）。
   * @param ip 中继 IP
   * @returns 无
   */
  forget(ip: string): void {
    this.sent.delete(ip);
    this.pending.delete(ip);
  }

  /**
   * 功能：两张账本的行数——用来观察「表外键」有没有泄漏。
   * @returns `{ sent, pending }`
   */
  counts(): { sent: number; pending: number } {
    return { sent: this.sent.size, pending: this.pending.size };
  }

  /**
   * 功能：清空两张账本（测试与自愈用）。
   * @returns 无
   */
  clear(): void {
    this.sent.clear();
    this.pending.clear();
  }
}
