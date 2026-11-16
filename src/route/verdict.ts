// 判定表：以 IP 为单位（目标站 IP × 通道 IP）。键 t|c，c ∈ {d, r:<ip>}。
// 状态机：0 unknown / 1 ok / 2 blocked / 3 dead。
// 纪律：弱证据（traffic）不得把强证据（probe/client）的结论冲掉；封锁只能由「行为证据」判定。
import { cnt } from "../core/counter";
import { St } from "../core/enums";
export type VState = 0 | 1 | 2 | 3;
export type VSrc = 0 | 1 | 2; // 0 traffic 弱证据 / 1 probe 强证据 / 2 client 端到端

/** 一行判定：某个目标站经某条通道的结论 */
export interface Verdict {
  t: string; // 目标站（主机名或 IP 字面量）
  c: string; // 通道键：d=直连 / r:<ip>=中继
  state: VState; // 0 未知 / 1 可用 / 2 被拦 / 3 连不上
  code: number; // 最近一次观察到的 HTTP 状态码（0 = 没拿到状态码）
  ms: number; // 首字节延迟（毫秒，EWMA）
  n: number; // 观察次数
  at: number; // 最近一次更新时间（毫秒时间戳）
  src: VSrc; // 这条结论的证据来源
}

/**
 * 判定表的过期时间（毫秒）。
 *
 * 为什么导出：`/<uuid>/debug?diag=` 要算「这条封锁还剩多少秒」，它必须与表里的 `ttl`
 * 是**同一个数**。7.153 删掉零读取点的 `SC.VT_TTL` 之后，那条诊断路径曾自己抄了一份
 * `1800000` 裸魔数——表一改就静默错报剩余时间。
 */
export const VT_TTL_MS = 30 * 60_000;

/**
 * 判定表：站点 × 通道的结论集合。
 *
 * 为什么按 IP 而不是按节点名：同一个中继的出口 IP 才是被封锁的对象，
 * 节点名会随优选域名/IP 轮换而变化，用它当键会把同一出口拆成多条互不相干的记录。
 *
 * 存储纪律：
 * - 30 分钟过期（TTL），最多 600 行；
 * - 弱证据只能「降级到未知」，不能把强证据的 blocked/dead 覆盖成 ok；
 * - 封锁只能由行为证据（2xx 存在与否）判定，不看响应体大小；
 * - 目标 `*`（通配）一律不落表：写入入口直接拒绝并计数（见 `blockWild`），读取侧也不再有通配回落。
 */
export class VerdictTable {
  private m = new Map<string, Verdict>();
  private ttl = VT_TTL_MS;
  private max = 600;

  /**
   * 功能：把（目标, 通道）拼成 Map 键。
   * @param t 目标站
   * @param c 通道键
   * @returns `目标|通道` 形式的字符串
   */
  private static key(t: string, c: string): string {
    return t + "|" + c;
  }

  /**
   * 功能：由 HTTP 状态码推断状态机取值（无状态码视为连不上）—— 全仓唯一实现。
   * @param code HTTP 状态码，0 表示连接失败/没拿到响应
   * @returns 3（连不上）/ 1（2xx-3xx 可用）/ 2（4xx-5xx 被拦）
   */
  private static stateOf(code: number): VState {
    if (code <= 0) return St.Dead;
    if (code >= 200 && code < 400) return St.Ok;
    return St.Blocked;
  }

  /**
   * 功能：取出一条尚未过期的记录。
   * @param v 候选记录，可能不存在
   * @returns 未过期则返回原记录，否则返回 undefined
   */
  private fresh(v: Verdict | undefined): Verdict | undefined {
    if (!v) return undefined;
    return Date.now() - v.at <= this.ttl ? v : undefined;
  }

  /**
   * 功能：拒绝一切「通配目标」写入，并记一次 `vwild` 计数。
   * 为什么这条不变量要放在表里、而不是靠「没有调用点」：v6 时代 `*|<通道>` 的含义是
   * 「这条通道被所有站点拒绝」，7.57 的一次机房级突发就把它写满了整池中继，可用池由厚变薄，
   * 成功率从 97% 掉到 2/20。当时是靠删掉所有写入点止血的 —— 但「没有调用者」不是不变量，
   * 任何人重新接一个调用就能复现。放在写入入口拒绝、并让计数可见，才与调用点无关。
   * @param t 目标站
   * @returns 是通配目标（已被拒绝）返回 true，调用方应立即返回
   */
  private static blockWild(t: string): boolean {
    if (t !== "*") return false;
    cnt("vwild");
    return true;
  }

  /**
   * 功能：写入一条带状态码的观察结果。
   * @param t 目标站
   * @param c 通道键
   * @param code HTTP 状态码（0 = 没拿到）
   * @param ms 本次首字节延迟（毫秒）
   * @param src 证据来源，默认 1（探测）；0 表示流量弱证据
   * @returns 无
   */
  set(t: string, c: string, code: number, ms: number, src: VSrc = 1): void {
    if (VerdictTable.blockWild(t)) return;
    const k = VerdictTable.key(t, c);
    const old = this.m.get(k);
    const ems = old ? Math.round(old.ms * 0.6 + ms * 0.4) : Math.round(ms);
    // 弱证据不得把强证据的 blocked/dead 冲掉，也不得把 ok 冲成 blocked
    const st = src === 0 && old ? (old.state === St.Ok ? (code >= 200 ? St.Ok : old.state) : old.state) : VerdictTable.stateOf(code);
    this.m.set(k, { t, c, state: st, code, ms: ems, n: (old?.n || 0) + 1, at: Date.now(), src });
    if (this.m.size > this.max) this.trim();
  }

  /**
   * 功能：直接写入状态（不带状态码），用于「判定为封锁/死亡」这类结论。
   * 规则：强证据优先——已有更强的证据来源时不覆盖。
   * @param t 目标站
   * @param c 通道键
   * @param state 目标状态（2 被拦 / 3 连不上）
   * @param src 证据来源（1 探测 / 2 客户端）
   * @returns 无
   */
  setState(t: string, c: string, state: VState, src: VSrc): void {
    if (VerdictTable.blockWild(t)) return;
    const k = VerdictTable.key(t, c);
    const old = this.m.get(k);
    if (old && old.src > src) return;
    this.m.set(k, { t, c, state, code: old?.code || 0, ms: old?.ms || 0, n: (old?.n || 0) + 1, at: Date.now(), src });
    this.trim();
  }

  /**
   * 功能：查询某条结论的证据来源。
   * @param t 目标站
   * @param c 通道键
   * @returns 0 流量弱证据 / 1 探测 / 2 客户端端到端；无记录时返回 0
   */
  srcOf(t: string, c: string): VSrc {
    return this.fresh(this.m.get(VerdictTable.key(t, c)))?.src ?? 0;
  }

  /**
   * 功能：查询某条通道最近一次观察到的状态码。
   * @param t 目标站
   * @param c 通道键
   * @returns HTTP 状态码；无记录或已过期时返回 0
   */
  get(t: string, c: string): number {
    return this.fresh(this.m.get(VerdictTable.key(t, c)))?.code || 0;
  }

  /**
   * 功能：查询某条通道的状态机取值。
   * @param t 目标站
   * @param c 通道键
   * @returns 0 未知 / 1 可用 / 2 被拦 / 3 连不上；无记录时为 0
   */
  state(t: string, c: string): VState {
    return this.fresh(this.m.get(VerdictTable.key(t, c)))?.state ?? 0;
  }

  /**
   * 功能：查询某条结论的更新时间。
   * @param t 目标站
   * @param c 通道键
   * @returns 毫秒时间戳；无记录时为 0
   */
  at(t: string, c: string): number {
    return this.fresh(this.m.get(VerdictTable.key(t, c)))?.at || 0;
  }

  /**
   * 功能：该通道对该目标是否可用。
   * 只认精确结论（`站点|通道`）：通配回落在 `blockWild` 之后已不可能存在（表内不接受 `*`），
   * 留着回落只会让人误以为「有一条通配的好消息」能救场。
   * @param t 目标站
   * @param c 通道键
   * @returns 可用返回 true
   */
  ok(t: string, c: string): boolean {
    return this.fresh(this.m.get(VerdictTable.key(t, c)))?.state === St.Ok;
  }

  /**
   * 功能：该通道是否被判死/被拦（选路时据此过滤）。
   * @param t 目标站
   * @param c 通道键
   * @returns 状态为 2 或 3 返回 true
   */
  bad(t: string, c: string): boolean {
    const e = this.fresh(this.m.get(VerdictTable.key(t, c)));
    return !!e && (e.state === St.Blocked || e.state === St.Dead);
  }

  /**
   * 功能：该目标是否「所有已知通道都不可用」。
   * @param t 目标站
   * @returns 有记录且没有任何一条可用通道时返回 true
   */
  dead(t: string): boolean {
    let seen = 0;
    for (const v of this.m.values()) {
      if (v.t !== t) continue;
      if (!this.fresh(v)) continue;
      if (v.state === St.Ok) return false;
      seen++;
    }
    return seen > 0;
  }

  /**
   * 功能：列出全部未过期结论（可按目标过滤），按目标名、再按延迟排序。
   * @param t 目标站过滤条件，空串表示全部
   * @returns 未过期的判定行数组
   */
  all(t = ""): Verdict[] {
    const out: Verdict[] = [];
    for (const v of this.m.values()) {
      if (!this.fresh(v)) continue;
      if (t && v.t !== t) continue;
      out.push(v);
    }
    return out.sort((a, b) => (a.t === b.t ? a.ms - b.ms : a.t < b.t ? -1 : 1));
  }

  /**
   * 功能：站点自愈——清掉某个目标的全部结论。
   * 用途：当某站点一条可用通道都不剩时，保留旧结论等于宣布「这个站点不可访问」，
   * 而真实原因可能只是这一批出口同时失效；清空后回到「未知」，至少还能再试。
   * @param t 目标站
   * @returns 无
   */
  clearHost(t: string): void {
    for (const [k, v] of this.m) if (v.t === t) this.m.delete(k);
  }

  /**
   * 功能：合并远端（别的 isolate）同步来的强证据。
   * 规则：只接受 blocked(2)/dead(3)；单批最多 120 条；已过期的行直接丢弃。
   * @param rows 远端行数组，键为 `目标|通道`，s 为状态，t 为到期时间戳
   * @returns 无
   */
  import(rows: Array<{ k: string; s: number; t: number }>): void {
    const now = Date.now();
    let n = 0;
    for (const r of rows) {
      if (n >= 120) break;
      if (!r || typeof r.k !== "string" || r.t <= now) continue;
      const i = r.k.lastIndexOf("|");
      if (i <= 0) continue;
      const t = r.k.slice(0, i);
      // 远端行是不可信输入（可能来自旧版本 isolate）：通配行在这里就丢掉，不靠上游过滤
      if (VerdictTable.blockWild(t)) continue;
      this.setState(t, r.k.slice(i + 1), (r.s === St.Dead ? St.Dead : St.Blocked) as VState, 1);
      n++;
    }
    this.trim();
  }

  /**
   * 功能：清空整张表（测试与自愈用）。
   * @returns 无
   */
  clear(): void {
    this.m.clear();
  }

  /**
   * 功能：当前表内记录数（含已过期但尚未清理的行）。
   * @returns 行数
   */
  size(): number {
    return this.m.size;
  }

  /**
   * 功能：把表压到上限以内——先清过期行，仍超限就删最旧的。
   * 为什么分两步（v7.181）：只清过期行时，「全新鲜」的表一行也删不掉，
   * 600 行上限名存实亡（实测灌 700 条走 setState 仍是 700、走 import 能到 960）；
   * 而键里的站点名来自客户端，长命 isolate 会一路涨。trim 在 set/setState/import 三处都调。
   * @returns 无
   */
  private trim(): void {
    if (this.m.size <= this.max) return;
    this.sweep();
    if (this.m.size <= this.max) return;
    // 仍超限：按写入时间升序删最旧的（at 相同时保持插入顺序，行为稳定可测）
    const over = this.m.size - this.max;
    const rows = [...this.m.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < over && i < rows.length; i++) this.m.delete(rows[i][0]);
  }

  /**
   * 功能：清掉过期行（trim 的第一步）。
   * @returns 无
   */
  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.m) if (now - v.at > this.ttl) this.m.delete(k);
  }
}

/** 进程内唯一判定表 */
export const VT = new VerdictTable();

/**
 * 功能：写入一条带状态码的观察。
 * @param t 目标站
 * @param c 通道键
 * @param code HTTP 状态码
 * @param ms 首字节延迟（毫秒）
 * @param src 证据来源，默认 1
 * @returns 无
 */
export function vSet(t: string, c: string, code: number, ms: number, src: VSrc = 1): void {
  VT.set(t, c, code, ms, src);
}

/**
 * 功能：直接写入状态（用于判定「被拦/连不上」）。
 * @param t 目标站
 * @param c 通道键
 * @param state 2 被拦 / 3 连不上
 * @param src 证据来源
 * @returns 无
 */
export function vSetState(t: string, c: string, state: VState, src: VSrc): void {
  VT.setState(t, c, state, src);
}

/**
 * 功能：读证据来源。
 * @param t 目标站
 * @param c 通道键
 * @returns 0/1/2
 */
export function vSrc(t: string, c: string): VSrc {
  return VT.srcOf(t, c);
}

/**
 * 功能：读状态机取值。
 * @param t 目标站
 * @param c 通道键
 * @returns 0/1/2/3
 */
export function vState(t: string, c: string): VState {
  return VT.state(t, c);
}

/**
 * 功能：读结论更新时间。
 * @param t 目标站
 * @param c 通道键
 * @returns 毫秒时间戳，无记录为 0
 */
export function vAt(t: string, c: string): number {
  return VT.at(t, c);
}

/**
 * 功能：该通道对该目标是否可用（含通配回落）。
 * @param t 目标站
 * @param c 通道键
 * @returns 可用为 true
 */
export function vOk(t: string, c: string): boolean {
  return VT.ok(t, c);
}

/**
 * 功能：该通道是否被判死/被拦。
 * @param t 目标站
 * @param c 通道键
 * @returns 被判死或被拦为 true
 */
export function vBad(t: string, c: string): boolean {
  return VT.bad(t, c);
}

/**
 * 功能：该目标是否所有通道都不可用。
 * @param t 目标站
 * @returns 全不可用为 true
 */
export function vDead(t: string): boolean {
  return VT.dead(t);
}

/**
 * 功能：列出结论。
 * @param t 目标过滤，空串为全部
 * @returns 判定行数组
 */
export function vAll(t = ""): Verdict[] {
  return VT.all(t);
}

/**
 * 功能：清空判定表。
 * @returns 无
 */
export function vClear(): void {
  VT.clear();
}

/**
 * 功能：清空某个目标的全部结论（站点自愈）。
 * @param t 目标站
 * @returns 无
 */
export function vClearHost(t: string): void {
  VT.clearHost(t);
}

/**
 * 功能：合并远端同步来的强证据。
 * @param rows `目标|通道` 行数组
 * @returns 无
 */
export function vImport(rows: Array<{ k: string; s: number; t: number }>): void {
  VT.import(rows);
}

