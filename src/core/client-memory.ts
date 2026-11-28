import { BoundedMap } from "./table";

/** 入口学习增量与旧 KV 键负缓存；快照层只消费它们。 */
export class EntryMemory {
  /** 按入口标签聚合的 RTT 样本（只留最近几个窗口，跨请求累积） */
  rows = new Map<string, Record<string, RttEntry>>();
  /** 旧 KV 键的负缓存（键 → 到期时刻）：避免反复查不存在的键 */
  misses = new BoundedMap<string, number>({ max: 500, timeOf: (until) => until });

  /** 功能：按已写出计数确认入口学习，保留新样本。@param sent 已写出的学习桶。@returns 无 */
  acknowledge(sent: Map<string, Record<string, RttEntry>>): void {
    // 计数相减而不是删桶：同一毫秒发生的新样本也必须保留。
    for (const [id, bucket] of sent) {
      const current = this.rows.get(id);
      if (!current) continue;
      for (const [tag, old] of Object.entries(bucket)) {
        const row = current[tag];
        if (!row) continue;
        row.hits = Math.max(0, (row.hits || 0) - (old.hits || 0));
        row.ok = Math.max(0, (row.ok || 0) - (old.ok || 0));
        row.fail = Math.max(0, (row.fail || 0) - (old.fail || 0));
        if (!row.hits && !row.ok && !row.fail) delete current[tag];
      }
      if (!Object.keys(current).length) this.rows.delete(id);
    }
  }

  /** 功能：记住旧键不存在，满表只淘汰最早到期行。@param id 用户标识。@param now 当前时间。@returns 无 */
  missing(id: string, now = Date.now()): void {
    this.misses.set(id, now + 600000);
    this.misses.prune(now, false);
  }
}

/** 有界错误记录；分类、去重与限流由 ErrRing 负责。 */
export class ErrorMemory {
  /** 错误环（最近若干条错误，超出按时间淘汰），/logs 从它读 */
  rows: ErrItem[] = [];

  /** 功能：只移除已持久化的对象，保留在途期间追加的错误。@param sent 已写出的错误。@returns 无 */
  acknowledge(sent: ErrItem[]): void {
    const delivered = new Set(sent);
    this.rows = this.rows.filter((item) => !delivered.has(item));
  }

  /** 功能：保留最近 50 条已通过限流的错误。@param item 错误记录。@returns 无 */
  append(item: ErrItem): void {
    this.rows.push(item);
    while (this.rows.length > 50) this.rows.shift();
  }
}

/** 入口学习的 isolate 所有者。 */
export const ENTRY_MEMORY = new EntryMemory();
/** 错误环所有者，快照不反向依赖 nodes 层。 */
export const ERROR_MEMORY = new ErrorMemory();
