/** 候选池的本地代际与扫描进度；持久化由 poolgen 编排。 */
export class PoolMemory {
  rows: PoolEntry[] = [];
  generation = 0;
  builtAt = 0;
  cursor = 0;
  scanCount = 12;
  probes = 0;
  hits = 0;
  probeWhy: Record<string, number> = {};
  probeColo = "";

  /** 功能：一次性采用已加载或提交成功的代际。@param rows 名单。@param generation 代际。@param builtAt 构建时刻。@returns 无 */
  adopt(rows: PoolEntry[], generation: number, builtAt = this.builtAt): void {
    this.rows = rows;
    this.generation = generation;
    this.builtAt = builtAt;
  }
}

/** 候选池与扫描进度的 isolate 所有者。 */
export const POOL_MEMORY = new PoolMemory();
