// 新候选扫描：在「还没有结论」的候选里轮转，探一批，成功的进存活表并记样本。
//
// 与「存活节点复测」（`scan-alive.ts`）分开：那边的对象已经在表里、失败要记账；
// 这边的对象连表都没进、失败只记冷却，两者的失败语义完全不同。

import { SC } from "../core/const";
import { S } from "../core/state";
import { STATS } from "../nodes/score";
import { bumpProbeBad, noteProbe, PROBE_COOL } from "./alive";
import { keyOf } from "./const";
import { type ProbeHit, probeBatch } from "./probe-batch";

/**
 * 新候选的执行器：持有这一轮的池子快照与准入名额。
 */
export class ScanProbe {
  /** 这一轮的候选池快照 */
  private readonly pool: PoolEntry[];
  /** 本轮准入名额（0 表示按池子大小自适应） */
  private readonly adm: number;
  /** 这一轮用的环境（`scanSub` 这类可调项从这里读） */
  private readonly env: Env;

  /**
   * 功能：记下这一轮要扫的池子与配额。
   * @param pool 候选池快照
   * @param adm 本轮准入名额（0 表示自适应）
   * @param env Worker 环境
   */
  constructor(pool: PoolEntry[], adm: number, env: Env) {
    this.pool = pool;
    this.adm = adm;
    this.env = env;
  }

  /**
   * 功能：探一批「还没有结论」的新候选，并给同 /24 明显偏慢的节点打上「下一轮复测」。
   * @returns 无
   */
  async run(): Promise<void> {
    // 每轮扫多少：默认按「4 轮覆盖全池」，管理员的 ?scan= 只能往上抬，天花板 SCAN_MAX。
    // 120/轮时 1600 池要 6.7 小时才轮完，冷启动期（isolate 寿命短）等于永远只认识前 120 个。
    const want = this.adm > 0 ? this.adm : Math.max(S.scanN || 12, Math.ceil(this.pool.length / 4));
    // 子请求是硬上限：免费计划 50/次调用，每次探活 = 1 个 connect()。默认压在 48，
    // 付费计划或提高配额后用 env.scanSub 抬（仍不超过 SCAN_MAX）。
    const sub = Number(this.env.scanSub) > 0 ? Math.max(12, Number(this.env.scanSub)) : SC.SCAN_SUB;
    const scanN = Math.max(12, Math.min(Math.min(SC.SCAN_MAX, sub), want));
    // 只在「还没有结论」的候选里轮转：已经进池的（有流量样本，另有头部复测）和连续探活失败的
    // 不再占名额。公开池里九成以上是死的，纯轮转时它们每轮都被重复探一遍，好候选永远排不上。
    const open = this.pool.filter((c) => {
      const k = c.h + ":" + c.p;
      return !S.alive.has(k) && !PROBE_COOL.skip(k);
    });
    // 全都有结论时退回「没进池的候选」做低频复检（能在池里的靠头部复测 + 真实流量，不用再探活）
    const live = this.pool.filter((c) => !S.alive.has(c.h + ":" + c.p));
    const src = open.length ? open : live.length ? live : this.pool;
    const idx = S.poolIdx % Math.max(src.length, 1);
    const batch = src.slice(idx, idx + scanN);
    S.probeColo = S.colo || "cron";
    const rows = await probeBatch(batch.map((c) => c.h + ":" + c.p));
    const hits: ProbeHit[] = [];
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i].r;
      noteProbe(x);
      bumpProbeBad(rows[i].k, !!(x && !x.bad));
      if (x && !x.bad) hits.push(x);
    }
    S.poolIdx = (idx + scanN) % Math.max(src.length, 1);
    S.probes += batch.length;
    S.hits += hits.length;
    this.markLaggards(hits);
    this.enterAlive(hits);
  }

  /**
   * 功能：同批对照 —— 同一个 /24 里其它节点都很快、只有它慢 3 倍以上，就排进下一轮复测。
   *
   * 不用绝对阈值（不同 /24 的基线差很多），也不动选路，只是多测一次。
   * @param hits 这一批探活的成功结果
   * @returns 无（写进 `S.reProbe`）
   */
  private markLaggards(hits: ProbeHit[]): void {
    const by24 = new Map<string, number[]>();
    for (const x of hits) {
      const p = String(x.h).split(".");
      if (p.length !== 4 || !(x.ms > 0)) continue;
      const k24 = p.slice(0, 3).join(".");
      const arr = by24.get(k24) || [];
      arr.push(x.ms);
      by24.set(k24, arr);
    }
    for (const x of hits) {
      const p = String(x.h).split(".");
      // 复测队列最多 8 条：再多就会把下一轮的探测预算全吃掉
      if (p.length !== 4 || !(x.ms > 0) || S.reProbe.length >= 8) continue;
      const arr = by24.get(p.slice(0, 3).join(".")) || [];
      // 少于此数无法算「同 /24 的中位」，单条样本的偏差不值得再测一次
      if (arr.length < 3) continue;
      const med = arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
      if (x.ms > Math.max(3 * med, 250) && !S.reProbe.includes(keyOf(x))) S.reProbe.push(keyOf(x));
    }
  }

  /**
   * 功能：把这一批成功的候选写进存活表并记节点统计。
   *
   * 探活 RTT 是「ClientHello → ServerHello」，与真实请求的首字节（含 TLS 握手）不是同一个量：
   * 写进 `nsLatency` 会让 `pSum` 停在 40ms 量级，第一条真实请求就 `cusumSum += 330 > CUSUM_H`
   * 把它冻 60 秒（7.183 在 `warm.ts` 修过同一处）。探活只贡献样本数与 `tcp`/`tls` 的 EWMA。
   * @param hits 这一批探活的成功结果
   * @returns 无
   */
  private enterAlive(hits: ProbeHit[]): void {
    for (const x of hits) {
      const k = keyOf(x);
      S.alive.set(k, {
        h: x.h,
        p: x.p,
        cc: x.cc || S.alive.get(k)?.cc || "",
        ms: x.ms,
      });
      STATS.nsProbe(k, x.ms, x.tcp || x.ms, x.tls || 0);
    }
  }
}
