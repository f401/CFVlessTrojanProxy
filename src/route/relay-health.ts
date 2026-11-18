// 中继存活度（OOP）：按中继 IP 记「整页 / 小响应 / 零字节」，用来把废中继排到后面。
// 与判定表的区别：判定表回答「这条中继对这个站点行不行」，这里回答「这条中继本身还活着吗」。
// 跨 isolate：计数走 /add 搭车上 DO，冷启动从 /hl 拉一次（与判定表的 vt 同一套路）。

import { relayIpOf } from "../core/relay-addr";
import { RelayLedger } from "./relay-ledger";
import { PAGE_ABS } from "../core/facts";

/** 中继健康记录 */
export interface RelayStat {
  ok: number; // 整页成功次数（>= BIG）
  bad: number; // 有小响应但没整页（403/假页，按站点记在判定表，这里只做加权）
  dead: number; // 0 字节收尾（连接都没建立）
  at: number;
}

/**
 * 跨 isolate 传输的行（短键省字节）。
 * `t` 是这条证据的最后观测时间。它可以缺省（老 DO 里的行没有这个字段），
 * 但**必须带上**：没有它，`merge()` 只能把别处的旧证据当成「刚刚发生」，
 * `score()` 里的 30 分钟半衰期对冷启动最大的那批数据就完全失效。
 */
export interface HlRow {
  i: string;
  o: number;
  b: number;
  d: number;
  t?: number;
}

const BIG = PAGE_ABS.big;
const MAX_IP = 200;
const HL_MS = 30 * 60_000; // 存活证据的半衰期：30 分钟不动就回到中性

/**
 * 中继健康表：按「有没有拿到整页、有没有零字节关闭」给每条中继打一个与站点无关的分。
 *
 * 三张表分工（缺一张就会重复计数或者丢批次）：
 * · `m` —— 合并后的累计证据（ok / bad / dead 与最后观测时间）；
 * · `sent` —— 上次上行时的计数快照，用来算出「这一批该发哪些行」；
 * · `pending` —— 已交给调用方、还没等到 ack 的行，nack 时按它回滚。
 * 只在本 isolate 内使用（硬约束：统计不跨 isolate 共享），随上报管道同步给 DO 做展示。
 */
export class RelayHealth {
  private byRelay = new Map<string, RelayStat>();
  /**
   * 两张账本（已同步快照 + 待确认行）。
   *
   * 为什么单独成类：它们**必须与主表同生同灭** —— 7.161（第 68 条）与 7.215 那批缺陷都是
   * 「主表删了、账本没删」，键在账本里永久驻留而 `size()` 只看主表 ⇒ 泄漏完全不可见。
   * 现在删除只有 `RelayLedger.forget()` 一个入口。
   */
  private ledger = new RelayLedger();

  /** 记一次收尾结果；node 是 host:port，直连时为空 */
  note(node: string, down: number, ok: boolean): void {
    if (!node) return;
    // 与 ipOf() 同一套解析：裸 IP（没有 :port 后缀）也必须能用 ——
    // 以前这里用 slice(0, -1)，会把最后一位数字吃掉，记成一个不存在的 IP。
    const ip = ipOf(node);
    if (!ip) return;
    let s = this.byRelay.get(ip);
    if (!s) {
      s = { ok: 0, bad: 0, dead: 0, at: 0 };
      this.byRelay.set(ip, s);
      if (this.byRelay.size > MAX_IP) this.drop();
    }
    s.at = Date.now();
    if (down >= BIG && ok) s.ok++;
    else if (down > 0) s.bad++;
    else s.dead++;
  }

  /** 0..1，越大越好：整页多、无响应少；证据超过半衰期就回落到中性 0.5 */
  score(ip: string): number {
    const s = this.byRelay.get(ip);
    if (!s) return 0.5; // 未测 = 中性，不能惩罚新中继
    const n = s.ok + s.bad + s.dead;
    const rate = (s.ok + 1) / (n + 2);
    const alive = (n - s.dead + 1) / (n + 1);
    const raw = Math.max(0, Math.min(1, 0.7 * rate + 0.3 * alive));
    const w = Math.pow(0.5, Math.max(0, Date.now() - s.at) / HL_MS);
    return 0.5 + w * (raw - 0.5);
  }

  /** 按健康度排序（好在前，未测居中），同分保持原序 */
  rank(ips: string[]): string[] {
    return ips
      .map((ip, i) => ({ ip, i, v: this.score(ip) }))
      .sort((a, b) => (b.v === a.v ? a.i - b.i : b.v - a.v))
      .map((x) => x.ip);
  }

  /**
   * 未上报的增量（每次 /add 最多 40 行）。
   * 只登记到 pending，不推进 sent：DO 那边可能根本没收到（超时/1102/断网），
   * 由调用方在收到成功响应后 ack()、失败后 nack()。以前在这里直接写 sent，
   * 等于把「已发出」当成「已送达」，一次失败就永久少一段证据。
   */
  delta(): HlRow[] {
    // 上次已经交出去、还没 ack 的行，原样再给一次（调用方重试时能带上）
    const out: HlRow[] = this.ledger.waiting();
    for (const [i, s] of this.byRelay) {
      // 上限判断放在压入之前：以前写在压入之后，`pending` 里已经有 40 行时会返回 41 行，
      // 多出来那一行既没有契约也没有预算（车身每多一行就多几字节，且突破「每批 ≤40 行」）
      if (out.length >= 40) break;
      if (!this.ledger.changed(i, { o: s.ok, b: s.bad, d: s.dead })) continue;
      if (this.ledger.queued(i)) continue;
      // 带上最后观测时间：接收端要靠它判断「这份证据有多旧」，否则只能当刚发生
      const row: HlRow = { i, o: s.ok, b: s.bad, d: s.dead, t: s.at };
      out.push(row);
      this.ledger.queue(row);
    }
    return out;
  }

  /** 上报成功：把 pending 里的快照正式提交为 sent */
  ack(): void {
    // 只登记还活着的行：`drop()` 可能已经把这条删了，往账本里塞一个表外键就是 7.161 那个泄漏。
    this.ledger.ack((ip) => this.byRelay.has(ip));
  }

  /** 上报失败：丢掉 pending，下次 delta 会从当前状态重新算一遍 */
  nack(): void {
    this.ledger.nack();
  }

  /**
   * 功能：冷启动合并别处的计数。一条证据整体胜出，不逐字段取最大值。
   *
   * 为什么必须整体胜出（v7.161 修）：以前每个计数各取 `Math.max`、时间却单独取「较新的一个」，
   * 于是两边的观测会被拼成一条从未存在过的证据 —— 本地 3 小时前攒下的 8 次成功，
   * 会顶着「刚刚」的时间戳去算分（`score()` 的半衰期按 `at` 衰减，等于让旧证据永不过期）；
   * 反过来，别处更强的计数可能配着本地更旧的时间，被无谓地衰减掉。
   * 现在的规则：证据条数（o+b+d）多的那条整体胜出；条数相等时较新的观测整体胜出 ——
   * 计数与时间永远来自同一次观测，`不覆盖本地更强的结论` 也仍然成立。
   * （v7.191 补：条数相等而构成不同时，原先只把时间戳搬过来、计数留本地，
   * 于是本地「3 次整页」会顶着别处「3 次零字节」的时间戳算半衰期 —— 同一个错的另一半。）
   * @param rows 别处报来的行（`t` 缺省 = 老 DO 行，按「刚刚」算）
   * @returns 无
   */
  merge(rows: HlRow[]): void {
    const now = Date.now();
    for (const r of rows) {
      if (!r || !r.i) continue;
      // 老行没有 t（DO 里 7.160 之前的记录）时按「刚刚」算，避免把全部历史证据一次性衰减掉
      const at = Math.min(Number(r.t) || now, now);
      const o = Math.max(0, Number(r.o) || 0);
      const b = Math.max(0, Number(r.b) || 0);
      const d = Math.max(0, Number(r.d) || 0);
      const inN = o + b + d;
      const cur = this.byRelay.get(r.i);
      const curN = cur ? cur.ok + cur.bad + cur.dead : 0;
      // 条数更多的那条胜出；条数一样多时，较新的观测胜出（构成可能不同：本地 3 次整页
      // vs 别处 3 次零字节，只搬时间戳会把两份观测拼成一条从未存在过的证据）。
      // 计数与时间必须来自同一次观测，绝不做 Math.max 拼接。
      if (!cur || inN > curN || (inN === curN && at > cur.at)) this.byRelay.set(r.i, { ok: o, bad: b, dead: d, at });
      // 胜出之后还要把「已同步到 DO 的计数」对齐到表里的当前值，
      // 否则下一轮 delta 会把这条已经确认过的证据再发一次。
      const s2 = this.byRelay.get(r.i) as RelayStat;
      this.ledger.sync(r.i, { o: s2.ok, b: s2.bad, d: s2.dead });
    }
    if (this.byRelay.size > MAX_IP) this.drop();
  }

  /** 调试视图 */
  json(limit = 20): Array<{ ip: string; s: number; ok: number; bad: number; dead: number }> {
    const rows = [...this.byRelay.entries()].map(([ip, s]) => ({ ip, s: this.score(ip), ok: s.ok, bad: s.bad, dead: s.dead }));
    rows.sort((a, b) => a.s - b.s);
    return rows.slice(0, limit);
  }

  /**
   * 功能：清空中继健康表（测试与自愈用）。
   * @returns 无
   */
  clear(): void {
    this.byRelay.clear();
    this.ledger.clear();
  }

  /**
   * 功能：主表里的中继条数。
   *
   * **只数主表**：7.161 之后账本（`sent`/`pending`）理论上不会多出行，但「不会」需要有地方可看，
   * 所以账本的规模单独暴露在 `counts()` 里 —— 7.261 之前这个方法声称连两张账本一起数，
   * 实际只回主表行数（文档与行为长期不一致）。
   * @returns 主表行数
   */
  size(): number {
    return this.byRelay.size;
  }

  /**
   * 功能：三张表的规模（主表 + 两张账本），用来观察账本有没有泄漏。
   * @returns `{ rows, sent, pending }`
   */
  counts(): { rows: number; sent: number; pending: number } {
    const led = this.ledger.counts();
    return { rows: this.byRelay.size, sent: led.sent, pending: led.pending };
  }

  /**
   * 超过容量时先丢「最老且没有零字节记录」的行。
   * 第一遍跳过 dead>0（那些行还带着「这中继连不上」的结论，有用），
   * 但必须有第二遍硬兜底：公开池里绝大多数中继一次都没连上过、全是 dead>0，
   * 只靠第一遍时 drop() 一个都删不掉，Map 会无限长下去。
   */
  private drop(): void {
    // 按最近使用时间升序排，先丢最老的；列表只算一次，两遍删除共用
    const rows = [...this.byRelay.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k, s] of rows) {
      if (s.dead > 0) continue;
      this.byRelay.delete(k);
      this.ledger.forget(k);
      if (this.byRelay.size <= MAX_IP) return;
    }
    // 第二遍硬兜底：不跳过 dead，从最老开始删到容量以内
    for (const [k] of rows) {
      this.byRelay.delete(k);
      this.ledger.forget(k);
      if (this.byRelay.size <= MAX_IP) return;
    }
  }
}

export const HEALTH = new RelayHealth();

/** 中继键 → IP（委托 `relayIpOf`：解析只准有一份） */
export function ipOf(node: string): string {
  if (!node) return "";
  return relayIpOf(node);
}

