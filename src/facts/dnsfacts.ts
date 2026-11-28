// `dns` 事实：这个站点有没有 AAAA 记录。
//
// 为什么值得单独一条事实：出口族（`eg`）与站点接受度是两件事 —— 一个站点即使接受 v6，
// 也可能根本没配 AAAA（纯 v4 站点）。那种情况下 v6 出口的中继是**结构性**过不去，
// 不是「今天状态不好」，没必要让它参与采样、更没必要让它占探索预算。
//
// 严格区分「确证有 AAAA」和「确证没有」与「不知道」：
//   - 有 AAAA（Status=NOERROR 且有记录）→ 确证，写 1；
//   - 没有 AAAA（Status=NOERROR 但只回 CNAME/空）→ 确证，写 0；
//   - DoH 全部失败（超时/网络错误/NXDOMAIN）→ **不写**。把「没查到」当「没有」会让
//     一次 DoH 抖动把整个站点钉死在 v4 上，这是我在 7.6x 系列里踩过的同类错误。
//
// 生命周期：24 小时（DNS 是五类事实里最稳定的一个，比 `eg` 的 6 小时还稳）。
// 作用点只有一个 —— 选路的代价乘数：确证「纯 v4」时，v6 出口乘 2（贵，但不排除）。
// 纯 v4 站点在 v6 出口上也**可能**成功（NAT64/HTTP 代理型中继），所以只降权。
//
// 表本体与上报队列来自基类 `FactTable`；这里只实现「一次 DoH 结论怎么记账」。

import { FACT_TTL } from "../core/facts";
import { FactTable, type TimedRow } from "./fact-table";

/** DNS 事实寿命：24 小时 */
export const DNS_TTL = FACT_TTL.dns;
/** 表上限：512 个站点 */
export const DNS_MAX = 512;
/** 每批上行上限 */
const DNS_BATCH = 60;

/** 一条 DNS 事实：`v6 = 1` 有 AAAA，`0` 确证没有 */
interface DnsRow extends TimedRow {
  /** 1 表示确证有 AAAA，0 表示确证没有 */
  v6: number;
}

/** 上行/下行的 DNS 事实行：`h` 站点、`v` 1 有 AAAA / 0 确证没有、`at` 观测时间。 */
export interface DnsWire {
  /** 站点主机名 */
  h: string;
  /** 1 有 AAAA / 0 确证没有 */
  v: number;
  /** 观测时间（毫秒） */
  at: number;
}

/**
 * 功能：DNS 事实表（纯内存、isolate 内），并把确证过的结论攒成待上行增量。
 *
 * 与 `eg` 的分工：`eg` 说「这条中继的出口是哪一族」；`dns` 说「这个站点接受哪一族」。
 * 两者相乘才是「这条中继过不了这个站」的结构性理由，单独任何一个都不够。
 */
export class DnsFacts extends FactTable<DnsRow, DnsWire> {
  /** @returns {number} 寿命 24 小时 */
  protected get ttlMs(): number {
    return DNS_TTL;
  }

  /** @returns {number} 表上限 */
  protected get maxRows(): number {
    return DNS_MAX;
  }

  /** @returns {number} 每批上行上限 */
  protected get batchMax(): number {
    return DNS_BATCH;
  }

  /**
   * 功能：一行编成线格式。
   * @param {string} key 站点主机名
   * @param {DnsRow} row 行
   * @returns {DnsWire} 线格式
   */
  protected toWire(key: string, row: DnsRow): DnsWire {
    return { h: key, v: row.v6, at: row.at };
  }

  /**
   * 功能：线格式解码成一行（坏行返回 null）。
   * @param {DnsWire} wire 线格式
   * @returns {{ key: string; row: DnsRow } | null} 解出来的行
   */
  protected parseWire(wire: DnsWire): { key: string; row: DnsRow } | null {
    // 三件事任一不成立就整条跳过：站点非空字符串、族标记只能是 0/1、时间戳必须可用。
    // 旧格式或坏行宁可丢，也不能把「这个域的 AAAA 情况」写成一个瞎猜的值
    if (!wire || typeof wire.h !== "string" || !wire.h) return null;
    if (wire.v !== 0 && wire.v !== 1) return null;
    const at = Number(wire.at) || 0;
    if (!at) return null;
    return { key: wire.h, row: { v6: wire.v, at } };
  }

  /**
   * 功能：记一条确证过的 DNS 结论。
   * @param host 站点主机名
   * @param v6 是否确证有 AAAA
   * @param now 观测时间
   * @returns {void}
   */
  note(host: string, v6: boolean, now = Date.now()): void {
    if (!host) return;
    const cur = this.get(host, now);
    // 一分钟内的重复观测：保留「有 AAAA」的那条（它更保守：不会把站点误判成纯 v4，
    // 而误判成纯 v4 会把所有 v6 中继都按 ×2 压下去）
    if (cur && now - cur.at < 60_000 && cur.v6 === 1) return;
    // 只有确证过的结论才进增量：DoH 抖动时调用方根本不会调 note（见文件头）
    this.put(host, { v6: v6 ? 1 : 0, at: now }, now);
  }

  /**
   * 功能：查这个站点有没有 AAAA。
   * @param host 站点主机名
   * @param now 当前时间
   * @returns {number} 1 有 / 0 确证没有 / -1 不知道（含过期）
   */
  v6Of(host: string, now = Date.now()): number {
    // get 会把过期行就地删掉：过期与「不知道」是同一个答案（-1）
    const row = this.get(host, now);
    return row ? row.v6 : -1;
  }

  /**
   * 功能：选路用的代价乘数 —— 确证纯 v4 且这条中继走 v6 时乘 2。
   * @param host 站点主机名
   * @param fam 该中继出口族（4 / 6 / 0 未知）
   * @param now 当前时间
   * @returns {number} 1 或 2
   */
  penOf(host: string, fam: number, now = Date.now()): number {
    if (fam !== 6) return 1;
    return this.v6Of(host, now) === 0 ? 2 : 1;
  }

  /**
   * 功能：快照（调试与 `/health` 用）。
   * @returns {{ n: number, v6: number, v4: number }} 计数
   */
  snap(): { n: number; v6: number; v4: number } {
    const rows = this.entries(Date.now());
    let v6 = 0;
    let v4 = 0;
    for (const [, row] of rows) {
      if (row.v6) v6 += 1;
      else v4 += 1;
    }
    return { n: rows.length, v6, v4 };
  }
}

/** 进程内唯一的 DNS 事实表 */
export const DNS = new DnsFacts();
