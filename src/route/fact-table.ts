// 事实表的公共骨架：一张有界内存表 + 一个「待上报」队列，生命周期全部由基类实现。
//
// 为什么要有这个基类：六张事实表（`eg` / `ps` / `dead` / `blk` / `dns` / `cap`）各自抄过一遍
// 「进表 → 进待上报 → 有界化 → 分批上行 → ack/nack」，其中 ack/nack 的纪律被抄了四遍、
// 修了两次（7.143「一次清空 pending 让超上限那批证据永久丢失」、7.177「按插入序切片等于永远
// 发最旧的」）。把这些纪律写在一处之后，子类只需要回答三个问题：
//   ① 这一行长什么样（线格式怎么编解码）；
//   ② 什么时刻算过期（`ttlMs`）；
//   ③ 远端行能不能覆盖本地的（默认「更晚的胜」，`ps`/`blk` 会按各自证据强度覆盖）。
//
// 三条不变量（基类保证，子类不许绕过）：
// 1) `ack()` 只清「这一批真的发出去的行」，且只在值没变新时才清 —— delta 与 ack 之间可能又
//    记了一条更新的观测，那条还没发过。
// 2) `nack()` 什么都不清 —— 上报失败时下一轮 `delta()` 把同一批原样再给一次（重发 = 重试，
//    幂等靠 `at`）；清掉就等于「这条证据从此不会送到 DO」。
// 3) 有界化永远在插入路径上执行（`put` 里就地裁剪），不依赖某条「成功」分支顺手调用 ——
//    7.189 的 `cap` 表就是因为裁剪只写在确认成功之后，导致 300 条未确认样本全部留在表里。
import type { EpochMs } from "../core/types";

/** 所有事实行都带观测时刻：过期判定、合并顺序、ack 幂等都靠它。 */
export interface TimedRow {
  /** 最后一次观测时间（毫秒时间戳） */
  at: EpochMs;
}

/**
 * 功能：事实表基类 —— 有界内存表 + 分批上行队列（模板方法模式）。
 *
 * 子类实现 `ttlMs` / `maxRows` / `batchMax` / `toWire` / `parseWire`，并提供自己的
 * `note(...)`（写入语义各不相同：`dead` 数连续失败、`eg` 记出口族、`dns` 记有无 AAAA）。
 * 读取与生命周期（`delta`/`ack`/`nack`/`load`/`clear`/`size`/`get`）由基类实现。
 */
export abstract class FactTable<Row extends TimedRow, Wire> {
  /** 表本体：键（中继 IP 或站点名）→ 行 */
  protected readonly rows = new Map<string, Row>();
  /** 待上报：本轮新记、还没被 ack 的行（未 ack 前重发 = 重试，不是重复计数） */
  private readonly pending = new Map<string, Row>();
  /** 这一批真正发出去的行（键 → 发出时的 at）：`ack()` 只清它们 */
  private readonly sent = new Map<string, EpochMs>();

  /** 行寿命（毫秒）：超过就当作没有样本 */
  protected abstract get ttlMs(): number;
  /** 表上限（行） */
  protected abstract get maxRows(): number;
  /** 每批上行上限（行）：由各表自己的车身预算决定 */
  protected abstract get batchMax(): number;

  /**
   * 功能：把一行编成线格式。
   * @param {string} key 行的键
   * @param {Row} row 行
   * @returns {Wire} 线格式
   */
  protected abstract toWire(key: string, row: Row): Wire;

  /**
   * 功能：把线格式解码成一行（坏行返回 null）。
   * @param {Wire} wire 线格式
   * @returns {{ key: string; row: Row } | null} 解出来的键与行；不合法返回 null
   */
  protected abstract parseWire(wire: Wire): { key: string; row: Row } | null;

  /**
   * 功能：这一行是否还没过期（默认按 `ttlMs` 判）。
   * @param {Row} row 行
   * @param {EpochMs} now 当前时间
   * @returns {boolean} true 表示仍是有效证据
   */
  protected fresh(row: Row, now: EpochMs): boolean {
    return now - row.at <= this.ttlMs;
  }

  /**
   * 功能：新观测是否可以覆盖已有行（默认「更晚的胜」）。
   * @param {Row | undefined} cur 本地已有的行
   * @param {Row} next 新的观测
   * @returns {boolean} true 表示应当覆盖
   */
  protected accept(cur: Row | undefined, next: Row): boolean {
    return !cur || next.at > cur.at;
  }

  /**
   * 功能：写一行（同时登记待上报，并就地有界化）。
   * @param {string} key 键
   * @param {Row} row 行
   * @param {EpochMs} now 当前时间
   * @returns {void}
   */
  protected put(key: string, row: Row, now: EpochMs): void {
    this.rows.set(key, row);
    // 同一个键的新观测覆盖旧观测：pending 里只留最新的那一版（否则一批里会出现同一键两次）
    this.pending.set(key, row);
    // 有界化写在插入路径上，不依赖任何「成功」分支顺手调用（7.189 的教训）
    this.trim(now);
  }

  /**
   * 功能：删一行（例如「连上了」就要把失败计数清掉）。
   * @param {string} key 键
   * @returns {boolean} 原来是否存在
   */
  protected forget(key: string): boolean {
    return this.rows.delete(key);
  }

  /**
   * 功能：撤掉某个键的待上报证据（「这条结论被反向证据推翻了」时用）。
   *
   * 与 `forget` 的区别：`forget` 只删表里那一行，待上报队列里可能还躺着它 —— 不一起撤掉，
   * 下一轮 `delta()` 会把一条已经作废的结论送到 DO，别的 isolate 收下之后又把它当成事实。
   * @param {string} key 键
   * @returns {void}
   */
  protected unpend(key: string): void {
    this.pending.delete(key);
  }

  /**
   * 功能：读一行，过期就地删除。
   * @param {string} key 键
   * @param {EpochMs} now 当前时间
   * @returns {Row | null} 仍然有效的行；不存在或已过期返回 null
   */
  protected get(key: string, now: EpochMs): Row | null {
    const row = this.rows.get(key);
    if (!row) return null;
    if (this.fresh(row, now)) return row;
    // 过期即删：把「删」和「不新鲜」绑在同一处，避免读端各自记得清
    this.rows.delete(key);
    return null;
  }

  /**
   * 功能：遍历仍然有效的行（顺带清掉过期的）。
   * @param {EpochMs} now 当前时间
   * @returns {Array<[string, Row]>} 键与行
   */
  protected entries(now: EpochMs): Array<[string, Row]> {
    const out: Array<[string, Row]> = [];
    for (const [key, row] of this.rows) {
      if (this.fresh(row, now)) out.push([key, row]);
      else this.rows.delete(key);
    }
    return out;
  }

  /**
   * 功能：导出待上报增量（不清空，等 ack）。
   * @returns {Wire[]} 最多 `batchMax` 行
   */
  delta(): Wire[] {
    const out: Wire[] = [];
    for (const [key, row] of this.pending) {
      out.push(this.toWire(key, row));
      // 记下「这一批发出去时的 at」：ack 只清这一版（值更新过的不清）
      this.sent.set(key, row.at);
      if (out.length >= this.batchMax) break;
    }
    return out;
  }

  /**
   * 功能：上报成功 —— 只清这一批真的发出去的行。
   * @returns {void}
   */
  ack(): void {
    for (const [key, at] of this.sent) {
      const cur = this.pending.get(key);
      // delta 与 ack 之间可能又记了一条更新的观测：那条还没发过，必须留着
      if (cur && cur.at <= at) this.pending.delete(key);
    }
    this.sent.clear();
  }

  /**
   * 功能：上报失败 —— 只丢掉「这一批已发出」的标记，待上报原样保留。
   * @returns {void}
   */
  nack(): void {
    // 保留 pending：下一轮 delta() 会把同一批原样再给一次（重发 = 重试，幂等靠 at）
    this.sent.clear();
  }

  /**
   * 功能：合并远端事实（冷启动一次灌入）。
   * @param {Wire[]} list 远端行
   * @returns {number} 实际被采纳的行数
   */
  load(list: Wire[]): number {
    let n = 0;
    for (const wire of list) {
      const one = this.parseWire(wire);
      // 坏行整条跳过：键、时间、值三件事任一不成立就整条跳过 ——
      // 不能让一个坏时间戳把「谁已经判死」这类结论写坏
      if (!one) continue;
      // 合并口径由子类的 `accept` 决定，默认「更晚的观测胜出」：
      // 远端手里可能是三分钟前的快照，用它盖掉本地刚测出来的结果会让判定原地倒退
      if (!this.accept(this.rows.get(one.key), one.row)) continue;
      this.rows.set(one.key, one.row);
      n += 1;
    }
    // 批量灌入时先删一轮比逐条判更快，也避免中间态超上限
    this.trim(0);
    return n;
  }

  /**
   * 功能：清空（单测与调试端点用）。
   * @returns {void}
   */
  clear(): void {
    this.rows.clear();
    this.pending.clear();
    this.sent.clear();
  }

  /**
   * 功能：当前表里还有几行（含已过期但尚未被读到的）。
   * @returns {number} 行数
   */
  size(): number {
    return this.rows.size;
  }

  /**
   * 功能：有界化 —— 先清过期行，仍超上限就按观测时间淘汰最旧的。
   * @param {EpochMs} now 当前时间（0 表示只做容量淘汰，不做过期扫描）
   * @returns {void}
   */
  protected trim(now: EpochMs): void {
    // 过期清理：now=0 时跳过（合并路径刚写完，不值得再扫一遍）
    if (now > 0) {
      for (const [key, row] of this.rows) if (!this.fresh(row, now)) this.rows.delete(key);
    }
    if (this.rows.size <= this.maxRows) return;
    // 容量淘汰：按 at 升序删最旧的（`at` 是最后一次有效观测，越旧越没价值）
    const aged = [...this.rows.entries()].sort((a, b) => a[1].at - b[1].at);
    const over = this.rows.size - this.maxRows;
    for (let i = 0; i < over; i++) this.rows.delete(aged[i][0]);
  }
}
