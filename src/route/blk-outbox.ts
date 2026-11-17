// `blk` 事实的上报队列：谁清、谁不清，是这张表唯一会永久丢证据的地方。
//
// 单独成文件的理由（两条都是线上事故）：
// - v7.143：`ack()` 一次清空全部 pending，而 `delta()` 每批最多交 60 行 ⇒ 被上限挤掉的行
//   既没发出去、也不再重发，证据永久丢失；
// - v7.221：静音期内的站点不该再收别处的事实，否则自愈结论会被当场撤销（那条判据在
//   `BlkFacts.load`，不在这里，但同属「pending / mute 的语义」）。
// 所以「只有 ack() 才清 pending，且只清真正发出去的那批」这条纪律，现在只在一个文件里成立。

import type { Row, BlkWire } from "./blk-types";

/** 每批最多交出多少行（DO 的 `/add` 一次最多合并这么多键） */
export const BLK_DELTA_MAX = 60;

/**
 * 功能：封锁事实的待上报队列。
 *
 * 两张表的分工：`pending` 是「还没被 DO 收下的证据」，`sent` 是「这一批已经交出去的行」。
 * 只有 `ack()` 能清 `pending`，而且只清 `sent` 里那批 —— 这是 7.143 的修法。
 */
export class BlkOutbox {
  /** 还没被确认的证据（键 → 行） */
  private pending = new Map<string, Row>();
  /** 这一批真正发出去的行（键 → 发出时的 at）：ack 只清它们，见 ack() 的注释 */
  private sent = new Map<string, number>();

  /**
   * 功能：登记一条新证据（下一轮 `delta()` 会带走它）。
   * @param key 事实键 `host|relay`
   * @param row 证据行
   * @returns {void}
   */
  push(key: string, row: Row): void {
    this.pending.set(key, row);
  }

  /**
   * 功能：丢掉某个键的待发证据（站点级自愈时用）。
   * @param key 事实键
   * @returns {void}
   */
  drop(key: string): void {
    this.pending.delete(key);
  }

  /**
   * 功能：导出待上报增量。
   * @returns {BlkWire[]} 最多 `BLK_DELTA_MAX` 行；交出的行同时记进 `sent`
   */
  delta(): BlkWire[] {
    const out: BlkWire[] = [];
    for (const [k, r] of this.pending) {
      out.push({ k, n: r.n, at: r.at });
      this.sent.set(k, r.at);
      if (out.length >= BLK_DELTA_MAX) break;
    }
    return out;
  }

  /**
   * 功能：上报成功 —— 只清这一批真正发出去的行。
   * @returns {void}
   */
  ack(): void {
    // 只清这一批真正发出去的行：delta() 有上限（本表最多 60 行），一次清空全部 pending 会让
    // 超出上限的行既没发出去、也不再重发 —— 证据就这样永久丢了（v7.143 修）。
    // 只在值没变新时才清：delta 与 ack 之间可能又记了一条更新的观测，那条还没发过。
    for (const [k, at] of this.sent) {
      const cur = this.pending.get(k);
      if (cur && cur.at <= at) this.pending.delete(k);
    }
    this.sent.clear();
  }

  /**
   * 功能：上报失败 —— 什么都不清（重发 = 重试，幂等靠 `at`）。
   * @returns {void}
   */
  nack(): void {
    // 保留 pending：上报失败时下一轮 delta() 会把同一批原样再给一次（重发 = 重试，幂等靠 at）。
    // 清掉它就等于「这条证据从此不会送到 DO」—— 与 v8 §3 的 pending 语义相反（只有 ack 才清）。
    this.sent.clear();
  }

  /** 功能：清空两张表（单测用）。@returns {void} */
  clear(): void {
    this.pending.clear();
    this.sent.clear();
  }
}
