import { SC } from "../core/const";

/**
 * 功能：`tfb`（目标站出口实测）的每站点起搏记账 —— 「上次探测时间」与「已轮换批次」两栏。
 * 为什么要有这个类：这两栏原来是 `src/routes/cron.ts` 顶层的两个 `const … = new Map()`，
 * 只被「`S.needPx` 里过期的那些站点」这一条移除路径清理，而 `S.needPx` 本身还会被
 * `trimAged(…, SC.PX_MAX)` 淘汰（`src/route/judge.ts` 与 `src/proxy/attacher.ts` 各一处）
 * —— 被淘汰的站点在记账表里永久留行。键是客户端带来的站点名（不是有限集合），
 * 于是「上限」只存在于注释里。收类之后：状态有独占的持有者、`sweep()` 是唯一的清理入口、
 * `cap` 与 `S.needPx` 的上限同源（`SC.PX_MAX`），也给单测留了直接入口。
 * 语义不变：同一站点 10 分钟内不重复探、30 分钟窗口内最多 3 批。
 */
export class TfbBook {
  /** 站点 → 上次开批时间（毫秒时间戳）。 */
  private at: Map<string, number> = new Map();

  /** 站点 → 本窗口已开的批数（0–3）。 */
  private n: Map<string, number> = new Map();

  /**
   * 功能：判断该站点现在能不能再开一批 tfb。
   * @param host 站点名（客户端带来的目标主机）
   * @param now 当前时间戳（毫秒，同一个 cron 轮次里共用一个值）
   * @returns 能开批时返回 true；距上次不足 10 分钟、或本窗口已满 3 批时返回 false
   */
  due(host: string, now: number): boolean {
    const last = this.at.get(host) || 0;
    // 10 分钟内的第二次探测只会烧掉免费计划的 fetch 额度，拿不到新证据
    if (now - last < 600000) return false;
    // 距上次超过 30 分钟算新窗口：批数归零，否则一个站点用过 3 批之后就永远轮不到
    if (now - last >= 1800000) this.n.set(host, 0);
    return (this.n.get(host) || 0) < 3;
  }

  /**
   * 功能：记一批 tfb 已开（批数 +1、上次时间推进）。
   * @param host 站点名
   * @param now 当前时间戳（毫秒）
   * @returns 无
   */
  take(host: string, now: number): void {
    // 先 due() 再 take()：这里不再判断门槛，调用方已经确认过可以开批
    this.n.set(host, (this.n.get(host) || 0) + 1);
    this.at.set(host, now);
  }

  /**
   * 功能：忘掉某个站点的记账（站点已被移除时调用）。
   * @param host 站点名
   * @returns 无
   */
  forget(host: string): void {
    // 两栏必须同进同出：只删一栏会让下一个窗口的判据读到孤立的批数
    this.at.delete(host);
    this.n.delete(host);
  }

  /**
   * 功能：按「还活着的站点表」清理记账，顺带把总量压到上限内 —— 唯一清理入口。
   * @param keep 仍然有效的站点表（`S.needPx`：站点 → 到期时间戳）
   * @param now 当前时间戳（毫秒）
   * @returns 本次清掉的站点数（给日志与单测看）
   */
  sweep(keep: Map<string, number>, now: number): number {
    let gone = 0;
    for (const host of [...this.at.keys()]) {
      const until = keep.get(host) || 0;
      // 两条淘汰理由：站点已从 keep 里消失（被 trimAged 挤出），或它自己也过期了
      if (until > now) continue;
      this.forget(host);
      gone++;
    }
    // 兜底上限：keep 自己也可能涨到 PX_MAX 以上（attacher 那条写入路径不裁剪），
    // 那时按「最久没探过」淘汰，保证记账表永远不会比它服务的表更大
    while (this.at.size > SC.PX_MAX) {
      let oldest = "";
      let atOld = Infinity;
      for (const [h, t] of this.at) if (t < atOld) { atOld = t; oldest = h; }
      if (!oldest) break;
      this.forget(oldest);
      gone++;
    }
    return gone;
  }

  /**
   * 功能：记账表当前行数（`at` 与 `n` 同尺寸，只报一个）。
   * @returns 站点数
   */
  size(): number {
    return this.at.size;
  }
}

/** tfb 起搏账本的全局实例（每 isolate 一份，与 `S` 同样不跨 isolate 共享）。 */
export const TFB = new TfbBook();
