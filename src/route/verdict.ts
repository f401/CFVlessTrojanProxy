// 判定表：以 IP 为单位（目标站 IP × 通道 IP）。键 t|c，c ∈ {d, r:<ip>, e:<ip>}。
// 状态机：0 unknown / 1 ok / 2 blocked / 3 dead。
// 纪律：弱证据（traffic）不得把强证据（probe/client）的结论冲掉；封锁只能由「行为证据」判定。
export type VState = 0 | 1 | 2 | 3;
export type VSrc = 0 | 1 | 2; // 0 traffic 弱证据 / 1 probe 强证据 / 2 client 端到端

export interface Verdict {
  t: string;
  c: string;
  state: VState;
  code: number;
  ms: number;
  n: number;
  at: number;
  src: VSrc;
}

/** 判定表：一个站点 × 通道的结论，30 分钟过期，最多 600 行 */
export class VerdictTable {
  private m = new Map<string, Verdict>();
  private ttl = 30 * 60_000;
  private max = 600;

  private static key(t: string, c: string): string {
    return t + "|" + c;
  }

  private static stateOf(code: number): VState {
    if (code <= 0) return 3;
    if (code >= 200 && code < 400) return 1;
    return 2;
  }

  private fresh(v: Verdict | undefined): Verdict | undefined {
    if (!v) return undefined;
    return Date.now() - v.at <= this.ttl ? v : undefined;
  }

  set(t: string, c: string, code: number, ms: number, src: VSrc = 1): void {
    const k = VerdictTable.key(t, c);
    const old = this.m.get(k);
    const ems = old ? Math.round(old.ms * 0.6 + ms * 0.4) : Math.round(ms);
    // 弱证据不得把强证据的 blocked/dead 冲掉，也不得把 ok 冲成 blocked
    const st = src === 0 && old ? (old.state === 1 ? (code >= 200 ? 1 : old.state) : old.state) : VerdictTable.stateOf(code);
    this.m.set(k, { t, c, state: st, code, ms: ems, n: (old?.n || 0) + 1, at: Date.now(), src });
    if (this.m.size > this.max) this.sweep();
  }

  setState(t: string, c: string, state: VState, src: VSrc): void {
    const k = VerdictTable.key(t, c);
    const old = this.m.get(k);
    if (old && old.src > src) return;
    this.m.set(k, { t, c, state, code: old?.code || 0, ms: old?.ms || 0, n: (old?.n || 0) + 1, at: Date.now(), src });
  }

  /** 该结论的证据来源（0 流量 / 1 探测 / 2 端到端） */
  srcOf(t: string, c: string): VSrc {
    return this.fresh(this.m.get(VerdictTable.key(t, c)))?.src ?? 0;
  }

  get(t: string, c: string): number {
    return this.fresh(this.m.get(VerdictTable.key(t, c)))?.code || 0;
  }

  state(t: string, c: string): VState {
    return this.fresh(this.m.get(VerdictTable.key(t, c)))?.state ?? 0;
  }

  at(t: string, c: string): number {
    return this.fresh(this.m.get(VerdictTable.key(t, c)))?.at || 0;
  }

  /** 该通道对目标是否可用：精确对优先，其次节点级通配（中继自己解析目标，钉不死 A 记录） */
  ok(t: string, c: string): boolean {
    const e = this.fresh(this.m.get(VerdictTable.key(t, c)));
    if (e) return e.state === 1;
    const w = this.fresh(this.m.get(VerdictTable.key("*", c)));
    return !!w && w.state === 1;
  }

  /** 该通道是否被判死/封（用于选路过滤） */
  bad(t: string, c: string): boolean {
    const e = this.fresh(this.m.get(VerdictTable.key(t, c))) || this.fresh(this.m.get(VerdictTable.key("*", c)));
    return !!e && (e.state === 2 || e.state === 3);
  }

  /** 该目标是否被全网判死（所有通道都非 2xx） */
  dead(t: string): boolean {
    let seen = 0;
    for (const v of this.m.values()) {
      if (v.t !== t) continue;
      if (!this.fresh(v)) continue;
      if (v.state === 1) return false;
      seen++;
    }
    return seen > 0;
  }

  all(t = ""): Verdict[] {
    const out: Verdict[] = [];
    for (const v of this.m.values()) {
      if (!this.fresh(v)) continue;
      if (t && v.t !== t) continue;
      out.push(v);
    }
    return out.sort((a, b) => (a.t === b.t ? a.ms - b.ms : a.t < b.t ? -1 : 1));
  }

  /** 站点自愈：某站点一条可用通道都不剩时，清掉它的全部结论（保证「绝不会因为判定而没路可走」） */
  clearHost(t: string): void {
    for (const [k, v] of this.m) if (v.t === t) this.m.delete(k);
  }

  /** 远端同步过来的强证据：只接受 blocked/dead */
  import(rows: Array<{ k: string; s: number; t: number }>): void {
    const now = Date.now();
    let n = 0;
    for (const r of rows) {
      if (n >= 120) break;
      if (!r || typeof r.k !== "string" || r.t <= now) continue;
      const i = r.k.lastIndexOf("|");
      if (i <= 0) continue;
      this.setState(r.k.slice(0, i), r.k.slice(i + 1), (r.s === 3 ? 3 : 2) as VState, 1);
      n++;
    }
  }

  clear(): void {
    this.m.clear();
  }

  size(): number {
    return this.m.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.m) if (now - v.at > this.ttl) this.m.delete(k);
  }
}

/** 进程内唯一判定表 */
export const VT = new VerdictTable();

export const stateOfCode = (code: number): VState => (code <= 0 ? 3 : code >= 200 && code < 400 ? 1 : 2);

export function vSet(t: string, c: string, code: number, ms: number, src: VSrc = 1): void {
  VT.set(t, c, code, ms, src);
}
export function vSetState(t: string, c: string, state: VState, src: VSrc): void {
  VT.setState(t, c, state, src);
}
export function vGet(t: string, c: string): number {
  return VT.get(t, c);
}
export function vSrc(t: string, c: string): VSrc {
      return VT.srcOf(t, c);
    }
    export function vState(t: string, c: string): VState {
  return VT.state(t, c);
}
export function vAt(t: string, c: string): number {
  return VT.at(t, c);
}
export function vOk(t: string, c: string): boolean {
  return VT.ok(t, c);
}
export function vBad(t: string, c: string): boolean {
  return VT.bad(t, c);
}
export function vDead(t: string): boolean {
  return VT.dead(t);
}
export function vAll(t = ""): Verdict[] {
  return VT.all(t);
}
export function vClear(): void {
  VT.clear();
}
export function vClearHost(t: string): void {
  VT.clearHost(t);
}
export function vImport(rows: Array<{ k: string; s: number; t: number }>): void {
  VT.import(rows);
}
