// 「站点 × 中继」成功率事实的待上报队列（v8 §3 的 pending 语义）。
//
// 为什么单独成类：这三张表的语义与表本体完全不同 —— 表本体回答「这一对现在能不能过」，
// 队列回答「哪几行还没送到 Meter」。混在一个类里时，`ack()` 只清「这一批真正发出去的行」
// 这条纪律要靠读三十行才能确认，而它在 7.143 修过一次（清空全部 pending ⇒ 证据永久丢）。
import type { PsKey, PsRow, PsWire } from "./ps-types";

/** 一次 `delta()` 最多给出多少行：与子请求预算（50/轮）留余量 */
export const PS_BATCH = 60;

/**
 * 功能：「站点 × 中继」成功率的待上报队列。
 *
 * 状态只有两张表：`pending`（还没确认送达的行）与 `sent`（这一批发出去的行，
 * 记的是发出时那一行的 `at`）。`sent` 只在 `delta` 与 `ack`/`nack` 之间活着。
 */
export class PsOutbox {
  /** 待上报行（未 ack 前重发等于重试，不是重复） */
  private pending = new Map<PsKey, PsRow>();
  // 这一批真正发出去的行（键 → 发出时的 at）：ack 只清它们，见 ack() 的注释
  private sent = new Map<PsKey, number>();

  /**
   * 功能：把一行观测放进待上报队列（同键覆盖：队列只关心这一对的**最新**状态）。
   * @param {PsKey} k 事实键 `站点|中继 IP`
   * @param {PsRow} row 这一对的最新统计
   * @returns {void}
   */
  push(k: PsKey, row: PsRow): void {
    this.pending.set(k, row);
  }

  /**
   * 功能：导出待上报增量（未 ack 的行会被重复给出 —— 重发即重试）。
   * @returns {PsWire[]} 最多 `PS_BATCH` 行
   */
  delta(): PsWire[] {
    const out: PsWire[] = [];
    // 逐行走、到批次上限就停：一次全量给出会撑爆一轮的子请求预算，
    // 而「超出的行留到下一轮」正是 pending 的用途（它们不会被丢，只是晚一轮）。
    for (const [k, r] of this.pending) {
      out.push({ k, q: r.q, n: r.n, at: r.at, top: r.top ?? r.q });
      this.sent.set(k, r.at);
      if (out.length >= PS_BATCH) break;
    }
    return out;
  }

  /** 功能：上报成功 —— 待发转已发。@returns {void} */
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

  /** 功能：上报失败 —— 丢弃待发，下轮重算（不把失败当已送达）。@returns {void} */
  nack(): void {
    this.sent.clear();
    // 保留 pending：上报失败时下一轮 delta() 会把同一批原样再给一次（重发 = 重试，幂等靠 at）。
    // 清掉它就等于「这条证据从此不会送到 DO」—— 与 v8 §3 的 pending 语义相反（只有 ack 才清）。
  }

  /** 功能：清空队列（单测用）。@returns {void} */
  clear(): void {
    this.pending.clear();
    this.sent.clear();
  }
}
