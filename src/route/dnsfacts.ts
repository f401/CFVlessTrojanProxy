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

/** 上行/下行的 DNS 事实行：`h` 站点、`v` 1 有 AAAA / 0 确证没有、`at` 观测时间。 */
export interface DnsWire {
  h: string;
  v: number;
  at: number;
}

/**
 * 功能：DNS 事实表（纯内存、isolate 内），并把确证过的结论攒成待上行增量。
 * @returns {DnsFacts} 进程内单例见 `DNS`
 */
export class DnsFacts {
  private rows = new Map<string, DnsRow>();
  /** 待上行：本轮新记、还没被 ack 的行（未 ack 前重发 = 重试，不是重复计数）。 */
  private pend = new Map<string, DnsRow>();
  // 这一批真正发出去的行（键 → 发出时的 at）：ack 只清它们，见 ack() 的注释
  private sent = new Map<string, number>();
  // 这里原有一张 `sent`（ack 后留作参考）—— 没有任何读端，长跑时只增不减；v7.138 删除

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
    // 只有确证过的结论才进增量：DoH 抖动时调用方根本不会调 note（见文件头）
    this.pend.set(host, { v6: v6 ? 1 : 0, at: now });
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
   * 功能：取出待上行的增量。
   * @returns {DnsWire[]} 最多 60 行
   */
  delta(): DnsWire[] {
    const out: DnsWire[] = [];
    for (const [h, r] of this.pend) {
      out.push({ h, v: r.v6, at: r.at });
      this.sent.set(h, r.at);
      if (out.length >= 60) break;
    }
    return out;
  }

  /** 功能：上报成功 —— 待发转已发。@returns {void} */
  ack(): void {
    // 只清这一批真正发出去的行：delta() 有上限（本表最多 60 行），一次清空全部 pending 会让
    // 超出上限的行既没发出去、也不再重发 —— 证据就这样永久丢了（v7.143 修）。
    // 只在值没变新时才清：delta 与 ack 之间可能又记了一条更新的观测，那条还没发过。
    for (const [k, at] of this.sent) {
      const cur = this.pend.get(k);
      if (cur && cur.at <= at) this.pend.delete(k);
    }
    this.sent.clear();
  }

  /** 功能：上报失败 —— 丢弃待发，下轮重算（不把失败当已送达）。@returns {void} */
  nack(): void {
    this.sent.clear();
    // 保留 pending：上报失败时下一轮 delta() 会把同一批原样再给一次（重发 = 重试，幂等靠 at）。
    // 清掉它就等于「这条证据从此不会送到 DO」—— 与 v8 §3 的 pending 语义相反（只有 ack 才清）。
  }

  /**
   * 功能：合并远端事实（冷启动一次灌入）。只认更新的观测。
   * @param rows 远端行
   * @returns {number} 实际并入的行数
   */
  load(rows: DnsWire[]): number {
    let n = 0;
    for (const r of rows) {
      if (!r || typeof r.h !== "string" || !r.h) continue;
      if (r.v !== 0 && r.v !== 1) continue;
      const at = Number(r.at) || 0;
      if (!at) continue;
      const cur = this.rows.get(r.h);
      if (cur && cur.at >= at) continue;
      this.rows.set(r.h, { v6: r.v, at });
      n += 1;
    }
    return n;
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
    this.pend.clear();
    this.sent.clear();
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
