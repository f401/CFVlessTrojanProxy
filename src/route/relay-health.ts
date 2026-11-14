// 中继存活度（OOP）：按中继 IP 记「整页 / 失败 / 无响应」，用来把废中继排到后面。
// 与判定表的区别：判定表回答「这条中继对这个站点行不行」，这里回答「这条中继本身还活着吗」。
import { S } from "../core/state";

/** 中继健康记录 */
export interface RelayStat {
  ok: number; // 整页成功次数（>= BIG）
  bad: number; // 有小响应但没整页（403/假页，按站点记在判定表，这里只做加权）
  dead: number; // 0 字节收尾（连接都没建立）
  at: number;
}

const BIG = 20000;

export class RelayHealth {
  private m = new Map<string, RelayStat>();

  /** 记一次收尾结果；node 是 host:port，直连时为空 */
  note(node: string, down: number, ok: boolean): void {
    if (!node) return;
    const ip = node.slice(0, node.lastIndexOf(":"));
    if (!ip) return;
    let s = this.m.get(ip);
    if (!s) {
      s = { ok: 0, bad: 0, dead: 0, at: 0 };
      this.m.set(ip, s);
    }
    s.at = Date.now();
    if (down >= BIG && ok) s.ok++;
    else if (down > 0) s.bad++;
    else s.dead++;
  }

  /** 0..1，越大越好：整页多、无响应少 */
  score(ip: string): number {
    const s = this.m.get(ip);
    if (!s) return 0.5; // 未测 = 中性，不能惩罚新中继
    const n = s.ok + s.bad + s.dead;
    const rate = (s.ok + 1) / (n + 2);
    const alive = (n - s.dead + 1) / (n + 1);
    return Math.max(0, Math.min(1, 0.7 * rate + 0.3 * alive));
  }

  /** 按健康度排序（好在前，未测居中），同分保持原序 */
  rank(ips: string[]): string[] {
    return ips
      .map((ip, i) => ({ ip, i, v: this.score(ip) }))
      .sort((a, b) => (b.v === a.v ? a.i - b.i : b.v - a.v))
      .map((x) => x.ip);
  }

  /** 调试视图 */
  json(limit = 20): Array<{ ip: string; s: number; ok: number; bad: number; dead: number }> {
    const rows = [...this.m.entries()].map(([ip, s]) => ({ ip, s: this.score(ip), ok: s.ok, bad: s.bad, dead: s.dead }));
    rows.sort((a, b) => a.s - b.s);
    return rows.slice(0, limit);
  }

  clear(): void {
    this.m.clear();
  }

  /** 池子里已知的 IP 数（调试用） */
  size(): number {
    return this.m.size;
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
