/** 本 isolate 即时用量与脏字节；不代替 Durable Object 总账。 */
export class UsageMemory {
  rows = new Map<string, StatsLocal>();
  dirtyBytes = 0;

  /** 功能：只确认已写出的增量，保留写入在途期间的新字节。@param sent 已写出的用量。@param bytes 已写出的脏字节。@returns 无 */
  acknowledge(sent: Map<string, StatsLocal>, bytes: number): void {
    for (const [id, old] of sent) {
      const row = this.rows.get(id);
      if (!row) continue;
      row.up = Math.max(0, row.up - old.up);
      row.down = Math.max(0, row.down - old.down);
      row.conns = Math.max(0, row.conns - old.conns);
      if (!row.up && !row.down && !row.conns) this.rows.delete(id);
    }
    this.dirtyBytes = Math.max(0, this.dirtyBytes - bytes);
  }

  /** 功能：累加本地用量并保留首末次时间。@param id 用户。@param up 上行。@param down 下行。@param isNew 新连接。@returns 无 */
  add(id: string, up: number, down: number, isNew = false): void {
    const now = Date.now();
    const row = this.rows.get(id) || { up: 0, down: 0, conns: 0, first: now, last: now };
    row.up += up || 0;
    row.down += down || 0;
    if (isNew) row.conns += 1;
    row.last = now;
    this.rows.set(id, row);
    this.dirtyBytes += (up || 0) + (down || 0);
  }
}

/** 本地用量增量所有者。 */
export const USAGE_MEMORY = new UsageMemory();
