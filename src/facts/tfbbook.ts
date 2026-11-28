/**
 * 功能：`tfb`（目标站出口实测）的每站点起搏记账 —— 「上次探测时间」与「已轮换批次」两栏。
 *
 * 为什么要有这个类：这两栏原来是 `src/routes/cron.ts` 顶层的两个 `const … = new Map()`，
 * 只被「`RELAY_DEMAND` 里过期的那些站点」这一条移除路径清理，而 `RELAY_DEMAND` 本身还会被
 * `trimAged(…, SC.PX_MAX)` 淘汰（`src/route/judge.ts` 与 `src/proxy/attacher.ts` 各一处）
 * —— 被淘汰的站点在记账表里永久留行。键是客户端带来的站点名（不是有限集合），
 * 于是「上限」只存在于注释里。收类之后：状态有独占的持有者、`sweep()` 是唯一的清理入口、
 * 容量与 `RELAY_DEMAND` 的上限同源（`SC.PX_MAX`），也给单测留了直接入口。
 *
 * 7.251 起容量淘汰交给 `src/core/table.ts` 的 `BoundedMap`（「先删过期、超限按时间收到低水位」
 * 这条规则在全仓只有一份实现），这里只剩「哪些站点还该记账」这一层业务判据。
 * 语义不变：同一站点 10 分钟内不重复探、30 分钟窗口内最多 3 批。
 */
import { SC } from "../core/const";
import { BoundedMap } from "../core/table";
import type { DurationMs, EpochMs } from "../core/types";

/** 同一站点两次开批的最小间隔：10 分钟内的第二次探测只会烧额度，拿不到新证据 */
const BATCH_GAP_MS: DurationMs = 600_000;

/** 记账窗口：距上次开批超过它就当新窗口，批数归零（否则一个站点用满 3 批就永远轮不到） */
const WINDOW_MS: DurationMs = 1_800_000;

/** 一个窗口内最多开几批 */
const BATCH_LIMIT = 3;

/**
 * 功能：tfb 的每站点起搏账本（「上次开批时刻」+「本窗口已开批数」）。
 */
export class TfbBook {
  /** 上一批判定标签，配合两批共识与日志去重，清理随站点过期。 */
  verdicts = new Map<string, string>();
  /** 站点 → 上次开批时刻（毫秒时间戳）；行本身就是时间戳，容量与淘汰由 `BoundedMap` 管 */
  private lastBatchAt = new BoundedMap<string, EpochMs>({ max: SC.PX_MAX, timeOf: (stamp) => stamp });

  /** 站点 → 本窗口已开的批数（0–3） */
  private batchCount = new Map<string, number>();

  /**
   * 功能：判断该站点现在能不能再开一批 tfb。
   * @param host 站点名（客户端带来的目标主机）
   * @param now 当前时间戳（毫秒，同一个 cron 轮次里共用一个值）
   * @returns 能开批时返回 true；距上次不足 10 分钟、或本窗口已满 3 批时返回 false
   */
  due(host: string, now: EpochMs): boolean {
    const lastBatch = this.lastBatchAt.get(host) || 0;
    if (now - lastBatch < BATCH_GAP_MS) return false;
    if (now - lastBatch >= WINDOW_MS) this.batchCount.set(host, 0);
    return (this.batchCount.get(host) || 0) < BATCH_LIMIT;
  }

  /**
   * 功能：记一批 tfb 已开（批数 +1、上次开批时刻推进）。
   * @param host 站点名
   * @param now 当前时间戳（毫秒）
   * @returns 无
   */
  take(host: string, now: EpochMs): void {
    // 先 due() 再 take()：这里不再判断门槛，调用方已经确认过可以开批
    this.batchCount.set(host, (this.batchCount.get(host) || 0) + 1);
    this.lastBatchAt.set(host, now);
  }

  /**
   * 功能：忘掉某个站点的记账（站点已被移除时调用）。
   * @param host 站点名
   * @returns 无
   */
  forget(host: string): void {
    // 两栏必须同进同出：只删一栏会让下一个窗口的判据读到孤立的批数
    this.lastBatchAt.delete(host);
    this.batchCount.delete(host);
  }

  /**
   * 功能：按「还活着的站点表」清理记账，顺带把总量压到上限内 —— 唯一清理入口。
   * @param keep 仍然有效的站点表（`RELAY_DEMAND`：站点 → 到期时间戳）
   * @param now 当前时间戳（毫秒）
   * @returns 本次清掉的站点数（给日志与单测看）
   */
  sweep(keep: Map<string, number>, now: EpochMs): number {
    let gone = 0;
    for (const host of [...this.lastBatchAt.keys()]) {
      const until = keep.get(host) || 0;
      // 两条淘汰理由：站点已从 keep 里消失（被 trimAged 挤出），或它自己也过期了
      if (until > now) continue;
      this.forget(host);
      gone += 1;
    }
    // 兜底上限：keep 自己也可能涨到 PX_MAX 以上（attacher 那条写入路径不裁剪），
    // 那时按「最久没开过批」淘汰 —— 排序与低水位都在 BoundedMap.prune 里，这里不再手写
    if (this.lastBatchAt.size > this.lastBatchAt.capacity()) this.lastBatchAt.prune(now, false);
    // 批数表跟着时刻表走：时刻已被淘汰的站点不该在批数里留行
    for (const host of [...this.batchCount.keys()]) {
      if (this.lastBatchAt.has(host)) continue;
      this.batchCount.delete(host);
      gone += 1;
    }
    return gone;
  }

  /**
   * 功能：记账表当前行数（两栏同进同出，只报一个）。
   * @returns 站点数
   */
  size(): number {
    return this.lastBatchAt.size;
  }
}

/** tfb 起搏账本的全局实例（每 isolate 一份，与 `S` 同样不跨 isolate 共享）。 */
export const TFB = new TfbBook();
