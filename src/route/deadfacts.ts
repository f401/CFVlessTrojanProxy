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
//
// 表本体、待上报队列、有界化、ack/nack 纪律全部来自基类 `FactTable`（见它的文件头）；
// 这里只实现「一次失败怎么记账」与「什么样的行才算判死」。
import { cnt } from "../core/counter";
import { DEAD_TTL } from "./commitfact";
import { FactTable, type TimedRow } from "./fact-table";

/** 判死需要连续失败几次 */
export const DEAD_N = 2;
/** 表上限 */
export const DEAD_MAX = 256;
/** 每批上行上限：与 `blk`/`dns` 同档（`/meter/add` 的车身要小） */
const DEAD_BATCH = 60;

/** 一行失败记录 */
export interface DeadRow extends TimedRow {
  /** 连续失败次数 */
  n: number;
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
export class DeadFacts extends FactTable<DeadRow, DeadWire> {
  /** @returns {number} 复活期（基类用它判过期） */
  protected get ttlMs(): number {
    return DEAD_TTL;
  }

  /** @returns {number} 表上限 */
  protected get maxRows(): number {
    return DEAD_MAX;
  }

  /** @returns {number} 每批上行上限 */
  protected get batchMax(): number {
    return DEAD_BATCH;
  }

  /**
   * 功能：一行编成线格式。
   * @param {string} key 中继 IP
   * @param {DeadRow} row 行
   * @returns {DeadWire} 线格式
   */
  protected toWire(key: string, row: DeadRow): DeadWire {
    return { i: key, n: row.n, at: row.at };
  }

  /**
   * 功能：线格式解码成一行（坏行返回 null）。
   * @param {DeadWire} wire 线格式
   * @returns {{ key: string; row: DeadRow } | null} 解出来的行
   */
  protected parseWire(wire: DeadWire): { key: string; row: DeadRow } | null {
    // 远端行逐条校验：地址必须是字符串、时间与批数必须是有限数 —— 坏行整条跳过，
    // 不能让一个 undefined 的时间戳把「谁已经判死」这件事写坏
    if (!wire || typeof wire.i !== "string" || !wire.i) return null;
    const at = Number(wire.at);
    const n = Number(wire.n);
    if (!Number.isFinite(at) || !Number.isFinite(n)) return null;
    // 批数夹在 1..9：远端可能给出 0（没意义）或很大的值（面板读起来失真）
    return { key: wire.i, row: { n: Math.max(1, Math.min(9, n)), at } };
  }

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
      // 连上了就把失败计数清掉；清掉一行也算一次观测（面板要能看出「康复」）
      if (this.forget(ip)) cnt("deadClear");
      return;
    }
    // `get` 会把过期的行就地删掉 ⇒ 过了复活期就自然从头数：
    // 「上次坏一次」与「这次坏一次」不会被拼成两次连续失败
    const cur = this.get(ip, now);
    const n = cur ? cur.n + 1 : 1;
    this.put(ip, { n, at: now }, now);
    cnt("deadNote");
  }

  /**
   * 功能：这条中继现在是否不可用（连续失败 ≥ 2 且未过复活期）。
   * @param {string} ip 中继 IP
   * @param {number} now 当前时间
   * @returns {boolean} true 表示应挪到候选队尾
   */
  isDead(ip: string, now = Date.now()): boolean {
    const row = this.get(ip, now);
    // get 已经把过期行删掉了，这里只剩「连续失败够不够」这一件事
    return !!row && row.n >= DEAD_N;
  }

  /**
   * 功能：快照（`/health` 与单测用），按最后失败时间降序，最多 12 行。
   * @param {number} now 当前时间
   * @returns {Array<{ i: string; n: number; at: number; dead: boolean }>} 快照
   */
  snap(now = Date.now()): Array<{ i: string; n: number; at: number; dead: boolean }> {
    const out = this.entries(now).map(([i, row]) => ({ i, n: row.n, at: row.at, dead: row.n >= DEAD_N }));
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, 12);
  }
}

/** 进程内唯一的「连不上」事实表 */
export const DEAD = new DeadFacts();

