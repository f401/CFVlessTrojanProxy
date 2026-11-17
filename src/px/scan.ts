// 池子维护的一轮编排：取池子 → 新候选扫描 → 存活复测 → 裁剪与统计 → 中转实测 → 落盘。
//
// 八段的具体动作分别住在三个文件里（`scan-probe.ts` 探新、`scan-alive.ts` 复测、
// `scan-house.ts` 清理与记账），这里只保留顺序 —— 改一段不用再数行号，
// 也能一眼看出「哪一段会花 connect 名额、哪一段会删数据、哪一段会写 KV」。

import { S } from "../core/state";
import { logErr } from "../nodes/metrics";
import { invalidateRank } from "../nodes/score";
import { pxGet, sweepProbeBad } from "./alive";
import { POOL_TTL_MS, refillPool } from "./probe";
import { commitPool, ensurePool } from "./poolgen";
import { ScanAlive } from "./scan-alive";
import { ScanHouse } from "./scan-house";
import { ScanProbe } from "./scan-probe";

/**
 * 一轮池子维护的执行器。持有「这一轮」的池子快照与预算，每段一个执行器，`run()` 只负责顺序。
 */
export class PoolScan {
  /** 这一轮用的环境（`scanSub` 这类可调项从这里读） */
  private readonly env: Env;
  /** 本轮准入名额（0 表示按池子大小自适应） */
  private readonly adm: number;
  /** 这一轮的候选池快照：重建成功后立刻换成新的，后面所有段落都用它 */
  private pool: PoolEntry[] = [];
  /** 存活节点复测器（无自有状态，章节全在 `S` 里） */
  private readonly alive = new ScanAlive();
  /** 收尾器：裁剪、统计、中转实测、落盘 */
  private readonly house = new ScanHouse();

  /**
   * 功能：记下这一轮的环境与配额。
   * @param env Worker 环境
   * @param adm 本轮准入名额（0 表示按池子大小自适应）
   */
  constructor(env: Env, adm = 0) {
    this.env = env;
    this.adm = adm;
  }

  /**
   * 功能：跑完整的一轮。任一段失败都不影响后面的段落（各段自有 try/catch 的调用方在 cron）。
   * @returns 无
   */
  async run(): Promise<void> {
    // 每轮先收拾「暂时跳过」表：过期记录对跳过判断已无意义，表本身也没有自愈路径
    sweepProbeBad();
    await pxGet(this.env);
    // 空池子直接结束这一轮：没有候选可探，写任何东西都是噪声
    if (!(await this.loadPool())) return;
    await this.alive.retestFlagged();
    await new ScanProbe(this.pool, this.adm, this.env).run();
    await this.alive.recheckHead();
    await this.alive.refreshRest();
    // 裁剪动过存活表时，站点排行与分片排序里可能还留着刚被删的节点
    if (this.house.prune(this.pool)) {
      S.hostRankCache.clear();
      invalidateRank();
    }
    // 国家码只影响展示与地区分组，放在裁剪之后（被裁掉的节点不必再查一次）
    await this.house.countries();
    await this.house.trimStats();
    await this.house.relays();
    await this.house.persistSeed(this.env);
  }

  /**
   * 功能：取候选池，必要时从上游重建。
   * @returns 有没有可用池子
   */
  private async loadPool(): Promise<boolean> {
    this.pool = await ensurePool(this.env);
    if (!this.pool.length || Date.now() - S.poolBuilt > POOL_TTL_MS) {
      const { pool: fresh } = await refillPool(this.env, S.pool.length);
      if (fresh.length) {
        const c = await commitPool(this.env, fresh);
        // 提交被拒（缩水守卫）时保留旧池：换成缩水的新池会让可用节点瞬间变少
        if (c.ok) this.pool = fresh;
        else logErr(`pool commit rejected: ${c.reason}`, "");
      }
      if (!this.pool.length) return false;
    }
    return true;
  }
}

/**
 * 功能：跑一轮池子维护（对外入口，`cron.ts` 与 `/<uuid>/debug?scan=` 都用它）。
 * @param env Worker 环境
 * @param adm 本轮准入名额（0 表示按池子大小自适应）
 * @returns 无
 */
export async function cronScan(env: Env, adm = 0): Promise<void> {
  await new PoolScan(env, adm).run();
}
