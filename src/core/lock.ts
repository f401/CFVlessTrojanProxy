import { SC } from "./const";
import { cnt } from "./counter";
import { S } from "./state";

/**
 * 定时任务的互斥闸门（带截止时间）。
 *
 * 为什么不是布尔：旧版是 `S.cronBusy = true/false`，一旦某一轮卡在**永远不会返回**的
 * 子请求上（DO fetch 没有超时，排队中的 DO 可能几十秒地不响应），这个 isolate 的 cron
 * 就永久停摆 —— 探活、seed 落盘、计量上报、快照全都不再跑；更糟的是手动
 * `/<uuid>/proxyip?refresh=1` 与 cron **共用同一个闩**，也会一直被 "cron in progress"
 * 挡在门外，等于没有任何逃生门。
 *
 * 改成「持有时间戳」后，超过 `SC.CRON_STALE_MS` 的一轮视为已经死掉：后来者接管并计
 * `cronStale`，一轮最多损失一次重投递窗口（cron 周期 30 分钟，远大于 8 分钟）。
 */
export class CronLock {
  /**
   * 功能：尝试持有闸门。
   * @param now 当前时间（毫秒时间戳；测试可注入）
   * @returns 拿到返回 true；正被一轮**未超时**的任务持有则返回 false
   */
  static claim(now = Date.now()): boolean {
    const held = S.cronAt;
    // 没被持有，或持有已超时（上一轮大概率卡死了）→ 可以跑
    if (held && now - held < SC.CRON_STALE_MS) return false;
    // 超时接管要留痕：正常收尾的一轮不会走到这里
    if (held) cnt("cronStale");
    S.cronAt = now;
    return true;
  }

  /** 功能：释放闸门（只在该轮真正收尾时调用） */
  static release(): void {
    S.cronAt = 0;
  }

  /**
   * 功能：闸门已持有多少毫秒。
   * @param now 当前时间
   * @returns 0 表示空闲
   */
  static age(now = Date.now()): number {
    return S.cronAt ? now - S.cronAt : 0;
  }
}
