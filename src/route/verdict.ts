// 判定表：以 IP 为单位（目标站 IP × 通道 IP）。键 t|c，c ∈ {d, r:<ip>, e:<ip>}。
// 状态机：0 unknown / 1 ok / 2 blocked / 3 dead；只有 probe(src=1) 与 client(src=2) 能把状态推到 blocked/dead。
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

const TAB: { m: Map<string, Verdict> } = { m: new Map() };
const TTL = 30 * 60_000;
const MAX = 600;

const keyOf = (t: string, c: string): string => t + "|" + c;

function stateOf(code: number): VState {
  if (code <= 0) return 3;
  if (code >= 200 && code < 400) return 1;
  return 2;
}

export function vSet(t: string, c: string, code: number, ms: number, src: VSrc = 1): void {
  const k = keyOf(t, c);
  const old = TAB.m.get(k);
  const ems = old ? Math.round(old.ms * 0.6 + ms * 0.4) : Math.round(ms);
  const weak = src === 0;
  // 弱证据不得把强证据的 blocked/dead 冲掉，也不得把 ok 冲成 blocked
  const st = weak && old ? (old.state === 1 ? (code >= 200 ? 1 : old.state) : old.state) : stateOf(code);
  TAB.m.set(k, { t, c, state: st, code, ms: ems, n: (old?.n || 0) + 1, at: Date.now(), src });
  if (TAB.m.size > MAX) {
    const now = Date.now();
    for (const [k2, v] of TAB.m) if (now - v.at > TTL) TAB.m.delete(k2);
  }
}

function entry(t: string, c: string): Verdict | undefined {
  const v = TAB.m.get(keyOf(t, c));
  if (!v) return undefined;
  return Date.now() - v.at <= TTL ? v : undefined;
}

/** 弱证据写状态：不得覆盖 probe/client 留下的更强结论 */
export function vSetState(t: string, c: string, state: VState, src: VSrc): void {
  const k = keyOf(t, c);
  const old = TAB.m.get(k);
  if (old && old.src > src) return;
  TAB.m.set(k, { t, c, state, code: old?.code || 0, ms: old?.ms || 0, n: (old?.n || 0) + 1, at: Date.now(), src });
}

/** 0 = 未知；否则最近一次 HTTP 状态码（0 也可能是连不上，配合 vState 判断） */
export function vGet(t: string, c: string): number {
  return entry(t, c)?.code || 0;
}

export function vState(t: string, c: string): VState {
  return entry(t, c)?.state ?? 0;
}

export function vAt(t: string, c: string): number {
  return entry(t, c)?.at || 0;
}

/** 该通道对目标 IP 是否可用：精确对优先，其次节点级通配（中继自己解析目标，钉不死 A 记录） */
export function vOk(t: string, c: string): boolean {
  const e = entry(t, c);
  if (e) return e.state === 1;
  const w = entry("*", c);
  return !!w && w.state === 1;
}

/** 该通道是否被强证据判死/封（用于选路过滤） */
export function vBad(t: string, c: string): boolean {
  const e = entry(t, c) || entry("*", c);
  return !!e && (e.state === 2 || e.state === 3);
}

/** 该目标 IP 是否被全网判死（直连与所有通道都非 2xx） */
export function vDead(t: string): boolean {
  let seen = 0;
  for (const v of TAB.m.values()) {
    if (v.t !== t || Date.now() - v.at > TTL) continue;
    if (v.state === 1) return false;
    seen++;
  }
  return seen > 0;
}

export function vAll(t = ""): Verdict[] {
  const now = Date.now();
  const out: Verdict[] = [];
  for (const v of TAB.m.values()) {
    if (now - v.at > TTL) continue;
    if (t && v.t !== t) continue;
    out.push(v);
  }
  return out.sort((a, b) => (a.t === b.t ? a.ms - b.ms : a.t < b.t ? -1 : 1));
}

/** 远端同步过来的强证据：只接受 blocked/dead，且不过期 */
export function vImport(rows: Array<{ k: string; s: number; t: number }>): void {
  const now = Date.now();
  let n = 0;
  for (const r of rows) {
    if (n >= 120) break;
    if (!r || typeof r.k !== "string" || r.t <= now) continue;
    const i = r.k.lastIndexOf("|");
    if (i <= 0) continue;
    vSetState(r.k.slice(0, i), r.k.slice(i + 1), (r.s === 3 ? 3 : 2) as VState, 1);
    n++;
  }
}

export function vClear(): void {
  TAB.m.clear();
}
