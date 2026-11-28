/** 候选池的本地代际与扫描进度；持久化由 poolgen 编排。 */
export class PoolMemory {
  /** 候选池（proxyip 名单 + 来源 + 国家码），重建时整表替换 */
  rows: PoolEntry[] = [];
  /** 池子代际：每次重建 +1，seed/KV 靠它判断新旧 */
  generation = 0;
  /** 上次构建时刻（POOL_TTL 到期即重建） */
  builtAt = 0;
  /** 扫描游标：每次探活从上次位置继续，避免总打前几条 */
  cursor = 0;
  /** 一轮取多少个候选探活（随池子大小自适应） */
  scanCount = 12;
  /** 累计探活次数（诊断与命中率口径） */
  probes = 0;
  /** 累计探活命中数（能连上的次数） */
  hits = 0;
  /** 没被探活的原因分布（冷却/黑名单/额度…），给面板解释用 */
  probeWhy: Record<string, number> = {};
  /** 最近一轮探活所在机房（跨机房命中率不可比，记录来源） */
  probeColo = "";
  /** 上次尝试从 KV 载入池子的时刻：60 秒内不重试，冷 isolate 不至于每个请求都去读一次 */
  lastAttemptAt = 0;

  /** 功能：一次性采用已加载或提交成功的代际。@param rows 名单。@param generation 代际。@param builtAt 构建时刻。@returns 无 */
  adopt(rows: PoolEntry[], generation: number, builtAt = this.builtAt): void {
    this.rows = rows;
    this.generation = generation;
    this.builtAt = builtAt;
  }
}

/** 候选池与扫描进度的 isolate 所有者。 */
export const POOL_MEMORY = new PoolMemory();
