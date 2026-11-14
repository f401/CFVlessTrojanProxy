// 出口族事实（`eg`）：这条中继出站用的是 IPv4 还是 IPv6。
//
// 为什么值得单独一层：同一个站点对两种族的接受率差一个数量级（实测 x.com：v4 出口 6/6、
// 两边都 200 整页；v6 出口 2/16，其余是 737B 的拒绝页）。而这个差别是**中继出口地址**的属性，
// 与用户位置、与 isolate 无关 —— 所以它可以跨 isolate 共享（v8 §16.5 的共享边界）。
//
// 纪律（v8 §15 的 I2）：这里只产出**代价偏置**，永远不参与「能不能用」的判定。
// 一个 `eg=6` 的中继仍然可能在别的站点头等好使，把它从候选里删掉就是 7.57 的老路
// （通配硬封锁 → 可用池变薄 → 失败率 10%→50%）。
import { cnt } from "../core/counter";
import { probeTf } from "../core/tf";

/** 一条出口族事实：`i` 中继 IP，`f` 族（4 或 6），`at` 观测时间 */
export interface EgRow {
  i: string;
  f: number;
  at: number;
}

/** 事实寿命：实测 1.5 小时后出口族仍一致，但中继会换线路，6 小时足够保守 */
export const EG_TTL = 21600000;

/** 表上限：池子 1600 条，这里只留最常出现的几百条，避免内存与上报体积失控 */
const EG_MAX = 512;

/**
 * 功能：出口族事实表。持有 (中继 IP → 族) 的记忆、待上报增量与合并逻辑。
 *
 * 为什么要有待上报（pending）而不是「记下就算数」：增量是搭 `/meter/add` 的车上去的，
 * 一次 POST 失败（1102、超时）如果已经把本地标记成「已发送」，这条事实就永久丢了。
 * 所以取增量时不清理，等 DO 回 200 后由 `ack()` 统一清理，失败走 `nack()` 重发。
 */
export class EgFacts {
  /** 已知事实：IP → { f, at } */
  private m = new Map<string, { f: number; at: number }>();
  /** 尚未确认送达的增量：IP → { f, at } */
  private pend = new Map<string, { f: number; at: number }>();

  /**
   * 功能：记一条出口族事实。
   * @param {string} ip 中继 IP（不带端口）
   * @param {number} fam 出口族：4 或 6，其他值直接忽略
   * @param {number} at 观测时间（毫秒时间戳），默认当前时间
   * @returns {void}
   */
  note(ip: string, fam: number, at = Date.now()): void {
    if (!ip || (fam !== 4 && fam !== 6)) return;
    const cur = this.m.get(ip);
    // 同族且不比已知的新：什么都不用做（避免每次请求都刷新 at，把过期时间无限推后）
    if (cur && cur.f === fam && cur.at >= at) return;
    this.m.set(ip, { f: fam, at });
    this.pend.set(ip, { f: fam, at });
    this.trim(at);
  }

  /**
   * 功能：查一条中继的出口族，过期的当「未知」。
   * @param {string} ip 中继 IP
   * @param {number} now 当前时间（便于单测注入）
   * @returns {number} 4 / 6 / 0（0 表示未知或已过期）
   */
  famOf(ip: string, now = Date.now()): number {
    const e = this.m.get(ip);
    if (!e) return 0;
    if (now - e.at > EG_TTL) {
      this.m.delete(ip);
      return 0;
    }
    return e.f;
  }

  /**
   * 功能：把出口族折算成代价乘数（选路时乘在代价上，越小越优先）。
   * @param {string} ip 中继 IP
   * @param {number} now 当前时间
   * @returns {number} v4 → 0.8，v6 → 1.15，未知 → 1
   */
  bias(ip: string, now = Date.now()): number {
    const f = this.famOf(ip, now);
    if (f === 4) return 0.8;
    if (f === 6) return 1.15;
    return 1;
  }

  /**
   * 功能：取待上报的增量（不清空，等 ack）。
   * @returns {EgRow[]} 最多 16 行：`/meter/add` 的车身要小，剩下的下一轮再发
   */
  delta(): EgRow[] {
    const out: EgRow[] = [];
    for (const [i, e] of this.pend) {
      out.push({ i, f: e.f, at: e.at });
      if (out.length >= 16) break;
    }
    if (out.length) cnt("egSent", out.length);
    return out;
  }

  /** 功能：上报成功 —— 待发增量正式生效。@returns {void} */
  ack(): void {
    this.pend.clear();
  }

  /** 功能：上报失败 —— 丢弃待发标记，下一轮重新登记（值仍在 `m` 里，重发不会丢数据）。@returns {void} */
  nack(): void {
    this.pend.clear();
  }

  /**
   * 功能：合并远端事实（冷启动拉回来的那份）。
   * @param {EgRow[]} rows 远端行
   * @returns {number} 真正被采纳的行数（更旧的忽略，便于观察合并效果）
   */
  load(rows: EgRow[]): number {
    let n = 0;
    for (const r of rows) {
      if (!r || typeof r.i !== "string" || (r.f !== 4 && r.f !== 6) || typeof r.at !== "number") continue;
      const cur = this.m.get(r.i);
      if (cur && cur.at >= r.at) continue;
      this.m.set(r.i, { f: r.f, at: r.at });
      n += 1;
    }
    this.trim(0);
    return n;
  }

  /**
   * 功能：调试快照（按 `at` 降序）。
   * @returns {EgRow[]} 未过期的行，最多 64 条
   */
  snap(): EgRow[] {
    const now = Date.now();
    const out: EgRow[] = [];
    for (const [i, e] of this.m) if (now - e.at <= EG_TTL) out.push({ i, f: e.f, at: e.at });
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, 64);
  }

  /** 功能：清零（单测用）。@returns {void} */
  clear(): void {
    this.m.clear();
    this.pend.clear();
  }

  /**
   * 功能：有界化 —— 清掉过期行，仍超上限就按观测时间淘汰最旧的。
   * @param {number} now 当前时间
   * @returns {void}
   */
  private trim(now: number): void {
    if (this.m.size <= EG_MAX) {
      if (now > 0) for (const [ip, e] of this.m) if (now - e.at > EG_TTL) this.m.delete(ip);
      return;
    }
    if (now > 0) for (const [ip, e] of this.m) if (now - e.at > EG_TTL) this.m.delete(ip);
    if (this.m.size <= EG_MAX) return;
    const rows = [...this.m.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < rows.length - EG_MAX; i++) this.m.delete(rows[i][0]);
  }
}

/** 进程内唯一的出口族事实表（每个 isolate 一份，读到的远端事实会在冷启动时灌进来） */
export const EG = new EgFacts();

/** 回显服务：它把请求方看到的出口 IP 原样写回来，是最好的出口族证据（v8 §13.6） */
export const EG_ECHO = "icanhazip.com";

/**
 * 功能：探测若干中继的出口族（走回显服务，经中继转发），命中的结果直接记进事实表。
 * @param {string[]} ips 中继 IP 列表（不带端口）
 * @param {number} max 最多探几条（免费计划每次调用只有 6 个并发 connect，别贪）
 * @returns {Promise<Array<{ ip: string; fam: number; ms: number; head: string }>>} 每条的结果
 */
export async function probeEg(ips: string[], max = 4): Promise<Array<{ ip: string; fam: number; ms: number; head: string }>> {
  const out: Array<{ ip: string; fam: number; ms: number; head: string }> = [];
  for (const ip of ips.slice(0, max)) {
    const r = await probeTf(EG_ECHO, ip + ":443", "/");
    const head = String(r.head || "").trim();
    // 回显正文就是一个 IP 字面量：带冒号是 v6，纯点分四段是 v4，其余当「没测到」
    const fam = head.includes(":") ? 6 : /^(\d{1,3}\.){3}\d{1,3}$/.test(head) ? 4 : 0;
    if (fam) EG.note(ip, fam);
    out.push({ ip, fam, ms: Number(r.ms || 0), head: head.slice(0, 40) });
  }
  return out;
}

/**
 * 功能：统计一组中继的出口族分布 —— `alive` 里到底有几条 v4 出口，是 v8 的一等预算项。
 * 为什么要它：好出口为 0 条时排序再好也只有个位数成功率（0→1 条值 82 个点），
 * 所以「有几条 v4 出口」必须能在 `/health` 上直接看到，而不是靠猜。
 * @param ips 中继 IP 列表
 * @param now 当前时间
 * @returns {{ v4: number, v6: number, unk: number }} 分布
 */
export function egCounts(ips: string[], now = Date.now()): { v4: number; v6: number; unk: number } {
  let v4 = 0;
  let v6 = 0;
  let unk = 0;
  for (const ip of ips) {
    const f = EG.famOf(ip, now);
    if (f === 4) v4 += 1;
    else if (f === 6) v6 += 1;
    else unk += 1;
  }
  return { v4, v6, unk };
}

/**
 * 功能：这一轮该花几个 connect 名额去测「出口族未知」的中继。
 * 依据（v8 §7.3）：v4 出口 <3 条时把更多预算给未知项 —— 每轮 4 条；够 3 条就回到 2 条，
 * 因为再多的 v4 出口只值 0.9 个点，而 connect 名额是全局 6 个的硬上限。
 * @param v4 当前已知 v4 出口条数
 * @returns {number} 本轮探测条数
 */
export function egQuota(v4: number): number {
  return v4 < 3 ? 4 : 2;
}
