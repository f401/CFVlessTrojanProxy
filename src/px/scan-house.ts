// 一轮维护的收尾三件事：裁两张表（存活表 / 节点统计表）、中转实测、把池子落盘。
//
// 三件事的共同点是「都不产生新候选，只清理与记账」：放在一起，读者一眼能看出
// 哪一段会删数据（裁剪）、哪一段会花预算（中转实测）、哪一段会写 KV（落盘）。

import { HOOK } from "../core/hook";
import { S } from "../core/state";
import { isBlack, isFrozen } from "../nodes/score";
import { ALIVE, ALIVE_MAX } from "./alive";
import { keyOf } from "./const";
import { probeSni } from "./probe";
import { SEEDS } from "./seed";

/**
 * 一轮维护的收尾器：裁剪与记账，不产生新候选。
 */
export class ScanHouse {
  /**
   * 功能：裁存活表 —— 先移出被重罚的（冷却 ≥30 分钟），再按上限裁到 `ALIVE_MAX`。
   * @param pool 这一轮的池子快照（裁剪时优先保留仍在池里的）
   * @returns 是否改动过（改动过要清站点排行缓存）
   */
  prune(pool: PoolEntry[]): boolean {
    const pruned = ALIVE.pruneOverPunished();
    const trimmed = ALIVE.trimToMax(pool);
    return pruned || trimmed;
  }

  /**
   * 功能：给存活表补国家码（只影响展示与地区分组，不参与打分）。
   * @returns 无
   */
  async countries(): Promise<void> {
    await ALIVE.fillCountries();
  }

  /**
   * 功能：清理节点统计表 —— 候选池一轮轮扫下去 `nstat` 只增不减（实测能到 2000+ 条），
   * 每条带一个 12 格直方图。清掉「不在存活表、没有吞吐样本、6 小时没动静」的，再对总量做硬上限。
   * @returns 无
   */
  trimStats(): void {
    const live = new Set(S.alive.keys());
    const cut = Date.now() - 6 * 3600e3;
    for (const [k, s] of S.nstat) {
      // 有下行样本的节点可能还在被选（候选表会读它的分），不能按「不在存活表」删
      if (live.has(k) || (s.bytesDown || 0) > 0) continue;
      if ((s.at || 0) > cut) continue;
      S.nstat.delete(k);
    }
    if (S.nstat.size > ALIVE_MAX) {
      const old = [...S.nstat.entries()].filter(([k]) => !live.has(k)).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
      for (const [k] of old) {
        // 超上限时裁到 75%：留着余量，免得下一轮又要全表排序
        if (S.nstat.size <= ALIVE_MAX * 0.75) break;
        S.nstat.delete(k);
      }
    }
  }

  /**
   * 功能：中转实测 —— 拿「实际失败过的站点」当目标，由池子自己判断哪个节点能替它出网。
   *
   * Worker 看不到 HTTP 状态码，但能看「这个节点有没有把该 SNI 的握手转出去」。
   * @returns 无
   */
  async relays(): Promise<void> {
    const tNow = Date.now();
    const targets: string[] = [];
    // 每轮最多两个站点：每次瞄准 = 4 条节点 × 一次握手，预算要留给探活
    for (const [h, t] of S.needPx) if (t > tNow && targets.length < 2) targets.push(h);
    if (!targets.length) return;
    const pool4 = (await ALIVE.list())
      .filter((x) => !isBlack(keyOf(x)) && !isFrozen(keyOf(x)))
      .slice(0, 4);
    if (!pool4.length) return;
    for (const h of targets) {
      // 探测本身失败也只当「没转出去」：这里要的是可用的那条，不是错误分类
      const res = (await Promise.all(
        pool4.map((x) => probeSni(x.h, x.p, h, 2200).catch(() => ({ err: "tcp" }) as { hs?: number })),
      )) as { hs?: number }[];
      res.forEach((x, i) => {
        if (HOOK.relayProbe) HOOK.relayProbe(h, pool4[i].h, !!x.hs, x.hs || 0);
      });
    }
  }

  /**
   * 功能：每轮最多写一次 seed，且两次落盘间隔 ≥55 分钟（`S.seed.ts` 来自 KV，跨 isolate 有效）。
   *
   * cron 是 30 分钟一轮，早先每轮都强制写 = 48 次/天，光这一项就吃掉 5% 的日额度。
   * @param env Worker 环境
   * @returns 无
   */
  async persistSeed(env: Env): Promise<void> {
    if (Date.now() - (S.seed.ts || 0) >= 55 * 60000) {
      await SEEDS.write(env, S.colo ? undefined : true, true);
    }
  }
}
