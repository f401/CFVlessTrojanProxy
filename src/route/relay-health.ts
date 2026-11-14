// 中继存活度（OOP）：按中继 IP 记「整页 / 小响应 / 零字节」，用来把废中继排到后面。
// 与判定表的区别：判定表回答「这条中继对这个站点行不行」，这里回答「这条中继本身还活着吗」。
// 跨 isolate：计数走 /add 搭车上 DO，冷启动从 /hl 拉一次（与判定表的 vt 同一套路）。
import { S } from "../core/state";

/** 中继健康记录 */
export interface RelayStat {
  ok: number; // 整页成功次数（>= BIG）
  bad: number; // 有小响应但没整页（403/假页，按站点记在判定表，这里只做加权）
  dead: number; // 0 字节收尾（连接都没建立）
  at: number;
}

/** 跨 isolate 传输的行（短键省字节） */
export interface HlRow {
  i: string;
  o: number;
  b: number;
  d: number;
}

const BIG = 20000;
const MAX_IP = 200;
const HL_MS = 30 * 60_000; // 存活证据的半衰期：30 分钟不动就回到中性

export class RelayHealth {
  private m = new Map<string, RelayStat>();
  /** 上次上报时的计数快照（决定 delta 里带哪些行） */
  private sent = new Map<string, { o: number; b: number; d: number }>();
  /** 已交给调用方、还没确认送达的行 */
  private pending = new Map<string, HlRow>();
  private loaded = false;

  /** 记一次收尾结果；node 是 host:port，直连时为空 */
  note(node: string, down: number, ok: boolean): void {
    if (!node) return;
    // 与 ipOf() 同一套解析：裸 IP（没有 :port 后缀）也必须能用 ——
    // 以前这里用 slice(0, -1)，会把最后一位数字吃掉，记成一个不存在的 IP。
    const ip = ipOf(node);
    if (!ip) return;
    let s = this.m.get(ip);
    if (!s) {
      s = { ok: 0, bad: 0, dead: 0, at: 0 };
      this.m.set(ip, s);
      if (this.m.size > MAX_IP) this.drop();
    }
    s.at = Date.now();
    if (down >= BIG && ok) s.ok++;
    else if (down > 0) s.bad++;
    else s.dead++;
  }

  /** 0..1，越大越好：整页多、无响应少；证据超过半衰期就回落到中性 0.5 */
  score(ip: string): number {
    const s = this.m.get(ip);
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
    const out: HlRow[] = [...this.pending.values()];
    for (const [i, s] of this.m) {
      const p = this.sent.get(i);
      if (p && p.o === s.ok && p.b === s.bad && p.d === s.dead) continue;
      if (this.pending.has(i)) continue;
      out.push({ i, o: s.ok, b: s.bad, d: s.dead });
      this.pending.set(i, { i, o: s.ok, b: s.bad, d: s.dead });
      if (out.length >= 40) break;
    }
    return out;
  }

  /** 上报成功：把 pending 里的快照正式提交为 sent */
  ack(): void {
    for (const r of this.pending.values()) this.sent.set(r.i, { o: r.o, b: r.b, d: r.d });
    this.pending.clear();
  }

  /** 上报失败：丢掉 pending，下次 delta 会从当前状态重新算一遍 */
  nack(): void {
    this.pending.clear();
  }

  /** 冷启动合并别处的计数（加性合并，不覆盖本地更强的结论） */
  merge(rows: HlRow[]): void {
    for (const r of rows) {
      if (!r || !r.i) continue;
      const s = this.m.get(r.i) || { ok: 0, bad: 0, dead: 0, at: 0 };
      s.ok = Math.max(s.ok, Number(r.o) || 0);
      s.bad = Math.max(s.bad, Number(r.b) || 0);
      s.dead = Math.max(s.dead, Number(r.d) || 0);
      s.at = Date.now();
      this.m.set(r.i, s);
      this.sent.set(r.i, { o: s.ok, b: s.bad, d: s.dead });
    }
    if (this.m.size > MAX_IP) this.drop();
  }

  /** 调试视图 */
  json(limit = 20): Array<{ ip: string; s: number; ok: number; bad: number; dead: number }> {
    const rows = [...this.m.entries()].map(([ip, s]) => ({ ip, s: this.score(ip), ok: s.ok, bad: s.bad, dead: s.dead }));
    rows.sort((a, b) => a.s - b.s);
    return rows.slice(0, limit);
  }

  /**
   * 功能：清空中继健康表（测试与自愈用）。
   * @returns 无
   */
  clear(): void {
    this.m.clear();
    this.sent.clear();
    this.pending.clear();
    this.loaded = false;
  }

  /**
   * 功能：当前表内中继条数（含未过期的 sent/pending）。
   * @returns 行数
   */
  size(): number {
    return this.m.size;
  }

  /** 冷启动只拉一次（失败不阻塞） */
  needLoad(): boolean {
    return !this.loaded;
  }

  /**
   * 功能：标记「已从 KV 载入过」，避免同一 isolate 反复读 KV。
   * @returns 无
   */
  markLoaded(): void {
    this.loaded = true;
  }

  /**
   * 超过容量时先丢「最老且没有零字节记录」的行。
   * 第一遍跳过 dead>0（那些行还带着「这中继连不上」的结论，有用），
   * 但必须有第二遍硬兜底：公开池里绝大多数中继一次都没连上过、全是 dead>0，
   * 只靠第一遍时 drop() 一个都删不掉，Map 会无限长下去。
   */
  private drop(): void {
    // 按最近使用时间升序排，先丢最老的；列表只算一次，两遍删除共用
    const rows = [...this.m.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k, s] of rows) {
      if (s.dead > 0) continue;
      this.m.delete(k);
      this.sent.delete(k);
      if (this.m.size <= MAX_IP) return;
    }
    // 第二遍硬兜底：不跳过 dead，从最老开始删到容量以内
    for (const [k] of rows) {
      this.m.delete(k);
      this.sent.delete(k);
      if (this.m.size <= MAX_IP) return;
    }
  }
}

export const HEALTH = new RelayHealth();

/** 中继键 → IP（`host:port` 或裸 IP） */
export function ipOf(node: string): string {
  if (!node) return "";
  const i = node.lastIndexOf(":");
  return i > 0 ? node.slice(0, i) : node;
}

/** 便利函数：从存活表取中继 IP 并按健康度排序 */
export function healthyRelays(limit = 16): string[] {
  const ips = Array.from(S.alive.keys()).map(ipOf);
  return HEALTH.rank(ips).slice(0, limit);
}

