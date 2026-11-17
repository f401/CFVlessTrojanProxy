// 存活节点复测：准入复测队列 → 头部（游标 + 吞吐前 3）→ 其余环切刷新延迟。
//
// 三段的差别只在「谁被选中」与「失败要不要记账」，探活动作本身由 `probe-batch.ts` 收口。

import { S } from "../core/state";
import { candsFor, nsProbe, nsProbeFail } from "../nodes/score";
import { noteProbe } from "./alive";
import { probeBatch, probeOne } from "./probe-batch";

/**
 * 存活节点复测器：三段各自一个方法，状态全在 `S.alive` / `S.reProbe` 里。
 */
export class ScanAlive {
  /**
   * 功能：复测上一轮「比同 /24 邻居慢一大截」的节点。
   *
   * 一次抖动会被 EWMA 吃掉 30%，紧接着再测一次就能拉回来。
   * @returns 无
   */
  async retestFlagged(): Promise<void> {
    const again = S.reProbe.splice(0, 4);
    if (!again.length) return;
    S.reProbeN += again.length;
    // 这几条上一轮刚被测过，再慢也就一个建连预算，直接并发
    const rows = await Promise.all(again.map(async (k) => ({ k, r: await probeOne(k) })));
    for (const { k, r } of rows) {
      noteProbe(r);
      if (r && !r.bad) {
        nsProbe(k, r.ms, r.tcp || r.ms, r.tls || 0);
        // 复测结果比历史更慢时不要把存活表里的延迟改大：这里只做「拉回来」
        const a = S.alive.get(k);
        if (a && r.ms < (a.ms || 1e9)) a.ms = r.ms;
      }
    }
  }

  /**
   * 功能：算出「这一轮要复测的头部」：当前游标 + 吞吐分前 3 名。
   *
   * 以前这里取的是存活表的前三个 key（插入顺序），跟「前 3 名」没关系，
   * 真正该复测的头部节点反而一直轮不到。
   * @returns 最多 4 个候选键
   */
  keys(): string[] {
    const cur = S.curs.tput || S.curs.lat || "";
    const top3 = candsFor("tput")
      .map((x) => x.k)
      .filter((k) => k !== cur)
      .slice(0, 3);
    // 最多 4 条：游标 + 3 个头部，再多就挤占探新候选的 connect 名额
    return [cur, ...top3].filter(Boolean).slice(0, 4);
  }

  /**
   * 功能：重测当前游标 + 吞吐分前 3 名（失败即进冷却）。
   * @returns 无
   */
  async recheckHead(): Promise<void> {
    await this.probeInto(this.keys(), true);
  }

  /**
   * 功能：其余存活节点只刷新延迟，不参与拉黑（抖动不该把存活项打死）。
   *
   * 从 `poolIdx` 开始轮转，别每次都测同样 12 个（插入顺序靠前的会一直被溺爱）。
   * @returns 无
   */
  async refreshRest(): Promise<void> {
    const recheck = this.keys();
    const allRest = [...S.alive.keys()].filter((k) => !recheck.includes(k));
    const start = allRest.length ? S.poolIdx % allRest.length : 0;
    // 从游标处环形切 12 条：这个数字要和一轮的 connect 预算（PROBE_CONC × 段数）配得上
    const rest = [...allRest.slice(start), ...allRest.slice(0, start)].slice(0, 12);
    await this.probeInto(rest, true);
  }

  /**
   * 功能：按并发上限探一批存活节点：成功就刷新延迟与统计，失败记一次探活失败。
   * @param keys 要探的候选键
   * @param failCounts 失败是否记进 `nsProbeFail`
   * @returns 无
   */
  private async probeInto(keys: string[], failCounts: boolean): Promise<void> {
    if (!keys.length) return;
    const rows = await probeBatch(keys);
    for (const { k, r } of rows) {
      noteProbe(r);
      if (r && !r.bad) {
        nsProbe(k, r.ms, r.tcp || r.ms, r.tls || 0);
        // 存活表里的 `ms` 就是面板与池子裁剪用的「实测延迟」，成功即覆盖
        const a = S.alive.get(k);
        if (a) a.ms = r.ms;
      } else if (failCounts) {
        nsProbeFail(k);
      }
    }
  }
}
