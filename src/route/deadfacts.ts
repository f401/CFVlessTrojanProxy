// 「中继连接层坏」事实（v8 §3 的 `dead`）：v8 里**唯一**会缩小候选集合的事实。
//
// 为什么允许它硬排除：它的证据是「连不上」——没有 HTTP 状态行、没有响应字节，与站点的
// 业务响应（403/404/415…）在物理上不可混淆。而业务 403 永远有状态行，所以它进不了这张表
// （写 `dead` 的条件里根本没有「状态码是几」这一项，见 `commitFact` 的规则 2）。
//
// 三个边界条件，缺一个就会变成 7.57 那类事故：
// 1) 连续两次才判死：单次失败可能只是本 isolate 这一瞬间的网络抖动。
// 2) 30 分钟自动复活：否则坏一次就永久出局（v7.86 的 `PROBE_BAD_TTL` 是同一课）。
// 3) 判死只由「连接层」触发：`down > 0` 的连接永远不算 dead，哪怕它是 4 字节拒绝页。
import { cnt } from "../core/counter";
import { DEAD_TTL } from "./commitfact";

/** 判死需要连续失败几次 */
export const DEAD_N = 2;
/** 表上限 */
export const DEAD_MAX = 256;

/** 一行失败记录 */
export interface DeadRow {
  /** 连续失败次数 */
  n: number;
  /** 最后一次失败时间 */
  at: number;
}

/** 上报用的行 */
export interface DeadWire {
  /** 中继 IP */
  i: string;
  /** 连续失败次数 */
  n: number;
  /** 最后一次失败时间 */
  at: number;
}

/**
 * 功能：中继「连不上」事实表。只在本 isolate 内存里累积，随上报管道同步。
 *
 * 与 `ps` 的分工：`ps` 说「能连上，但过不了这个站点」；`dead` 说「连都连不上」。
 * 前者只折价，后者才允许把候选挪到队尾（不是删除，见 `policy` 的 `stick` 分区）。
 */
export class DeadFacts {
  private rows = new Map<string, DeadRow>();
  private pend = new Map<string, DeadRow>();
  // 这一批真正发出去的行（键 → 发出时的 at）：ack 只清它们，见 ack() 的注释
  private sent = new Map<string, number>();

  /**
   * 功能：记录一次连接层结果。
   * @param {string} ip 中继 IP
   * @param {boolean} ok 是否连上了（连上就清零）
   * @param {number} now 记录时间
   * @returns {void}
   */
  note(ip: string, ok: boolean, now = Date.now()): void {
    if (!ip) return;
    if (ok) {
      if (this.rows.delete(ip)) cnt("deadClear");
      return;
    }
    const cur = this.rows.get(ip);
    // 已经过了复活期就从头数：否则「上次坏一次」和「这次坏一次」会被拼成两次
    const n = cur && now - cur.at <= DEAD_TTL ? cur.n + 1 : 1;
    const row: DeadRow = { n, at: now };
    this.rows.set(ip, row);
    this.pend.set(ip, row);
    cnt("deadNote");
    if (this.rows.size > DEAD_MAX) this.drop(now);
  }

  /**
   * 功能：这条中继现在是否不可用（连续失败 ≥ 2 且未过复活期）。
   * @param {string} ip 中继 IP
   * @param {number} now 当前时间
   * @returns {boolean} true 表示应挪到候选队尾
   */
  isDead(ip: string, now = Date.now()): boolean {
    const r = this.rows.get(ip);
    if (!r) return false;
    if (now - r.at > DEAD_TTL) return false;
    return r.n >= DEAD_N;
  }

  /**
   * 功能：导出待上报增量（未 ack 前重发等于重试）。
   * @returns {DeadWire[]} 最多 60 行
   */
  delta(): DeadWire[] {
    const out: DeadWire[] = [];
    for (const [i, r] of this.pend) {
      out.push({ i, n: r.n, at: r.at });
      this.sent.set(i, r.at);
      if (out.length >= 60) break;
    }
    return out;
  }

  /** 功能：上报成功。@returns {void} */
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

  /** 功能：上报失败（丢弃待发，事实本身保留）。@returns {void} */
  nack(): void {
    this.sent.clear();
    // 保留 pending：上报失败时下一轮 delta() 会把同一批原样再给一次（重发 = 重试，幂等靠 at）。
    // 清掉它就等于「这条证据从此不会送到 DO」—— 与 v8 §3 的 pending 语义相反（只有 ack 才清）。
  }

  /**
   * 功能：合并远端事实 —— 只认更新时间的行，且只并「已经判死」的行（失败一次不算事实）。
   * @param {DeadWire[]} rows 远端行
   * @returns {number} 合并条数
   */
  load(rows: DeadWire[]): number {
    let n = 0;
    for (const r of rows) {
      if (!r || typeof r.i !== "string") continue;
      const at = Number(r.at);
      const cntN = Number(r.n);
      if (!Number.isFinite(at) || !Number.isFinite(cntN)) continue;
      const cur = this.rows.get(r.i);
      if (cur && cur.at >= at) continue;
      this.rows.set(r.i, { n: Math.max(1, Math.min(9, cntN)), at });
      n += 1;
    }
    if (this.rows.size > DEAD_MAX) this.drop(0);
    return n;
  }

  /**
   * 功能：快照（`/health` 与单测用），按最后失败时间降序，最多 12 行。
   * @param {number} now 当前时间
   * @returns {Array<{ i: string; n: number; at: number; dead: boolean }>} 快照
   */
  snap(now = Date.now()): Array<{ i: string; n: number; at: number; dead: boolean }> {
    const out: Array<{ i: string; n: number; at: number; dead: boolean }> = [];
    for (const [i, r] of this.rows) out.push({ i, n: r.n, at: r.at, dead: now - r.at <= DEAD_TTL && r.n >= DEAD_N });
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, 12);
  }

  /** 功能：清空（单测用）。@returns {void} */
  clear(): void {
    this.rows.clear();
    this.pend.clear();
    this.sent.clear();
  }

  /**
   * 功能：容量淘汰 —— 先扔已过复活期的行，再按时间扔最旧的。
   * @param {number} now 当前时间（0 表示只做容量淘汰）
   * @returns {void}
   */
  private drop(now: number): void {
    if (now > 0) {
      for (const [i, r] of this.rows) if (now - r.at > DEAD_TTL) this.rows.delete(i);
    }
    if (this.rows.size <= DEAD_MAX) return;
    const keys = [...this.rows.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [i] of keys) {
      if (this.rows.size <= DEAD_MAX) break;
      this.rows.delete(i);
    }
  }
}

/** 进程内唯一的「连不上」事实表 */
export const DEAD = new DeadFacts();

/**
 * 功能：薄包装 —— 记一次连接层结果。
 * @param {string} ip 中继 IP
 * @param {boolean} ok 是否连上
 * @param {number} now 记录时间
 * @returns {void}
 */
export function deadNote(ip: string, ok: boolean, now = Date.now()): void {
  DEAD.note(ip, ok, now);
}

/**
 * 功能：薄包装 —— 是否判死。
 * @param {string} ip 中继 IP
 * @param {number} now 当前时间
 * @returns {boolean} true 表示应挪到队尾
 */
export function isDead(ip: string, now = Date.now()): boolean {
  return DEAD.isDead(ip, now);
}
