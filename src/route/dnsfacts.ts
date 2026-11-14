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

/** DNS 事实寿命：24 小时 */
export const DNS_TTL = 24 * 3600_000;
/** 表上限：512 个站点 */
export const DNS_MAX = 512;

/** 一条 DNS 事实：`v6 = 1` 有 AAAA，`0` 确证没有 */
interface DnsRow {
  v6: number;
  at: number;
}

/**
 * 功能：DNS 事实表（纯内存、isolate 内）。
 * @returns {DnsFacts} 进程内单例见 `DNS`
 */
export class DnsFacts {
  private rows = new Map<string, DnsRow>();

  /**
   * 功能：记一条确证过的 DNS 结论。
   * @param host 站点主机名
   * @param v6 是否确证有 AAAA
   * @param now 观测时间
   * @returns {void}
   */
  note(host: string, v6: boolean, now = Date.now()): void {
    if (!host) return;
    const cur = this.rows.get(host);
    // 同一时刻的重复观测：保留「有 AAAA」的那条（它更保守：不会把站点误判成纯 v4）
    if (cur && now - cur.at < 60_000 && cur.v6 === 1) return;
    this.rows.set(host, { v6: v6 ? 1 : 0, at: now });
    this.drop(now);
  }

  /**
   * 功能：查这个站点有没有 AAAA。
   * @param host 站点主机名
   * @param now 当前时间
   * @returns {number} 1 有 / 0 确证没有 / -1 不知道（含过期）
   */
  v6Of(host: string, now = Date.now()): number {
    const r = this.rows.get(host);
    if (!r) return -1;
    if (now - r.at > DNS_TTL) {
      this.rows.delete(host);
      return -1;
    }
    return r.v6;
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
    const now = Date.now();
    let v6 = 0;
    let v4 = 0;
    for (const [h, r] of this.rows) {
      if (now - r.at > DNS_TTL) {
        this.rows.delete(h);
        continue;
      }
      if (r.v6) v6 += 1;
      else v4 += 1;
    }
    return { n: this.rows.size, v6, v4 };
  }

  /** 功能：清空（测试与调试端点用） @returns {void} */
  clear(): void {
    this.rows.clear();
  }

  /**
   * 功能：容量淘汰 —— 满了按观测时间删最旧的。
   * @param now 当前时间
   * @returns {void}
   */
  private drop(now: number): void {
    if (this.rows.size <= DNS_MAX) return;
    for (const [h, r] of this.rows) if (now - r.at > DNS_TTL) this.rows.delete(h);
    if (this.rows.size <= DNS_MAX) return;
    const old = [...this.rows.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.rows.size - DNS_MAX);
    for (const [h] of old) this.rows.delete(h);
  }
}

/** 进程内唯一的 DNS 事实表 */
export const DNS = new DnsFacts();
