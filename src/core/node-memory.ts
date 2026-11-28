import { BoundedMap } from "./table";

/** 本 isolate 的节点观测与排名失效协议，不跨 isolate 共享统计。 */
export class NodeMemory {
  alive = new Map<string, NodeEntry>();
  stats = new Map<string, NodeStats>();
  rankCache = new BoundedMap<string, { t: number; v: RankRow[] }>({ max: 80, timeOf: (row) => row.t });
  generation = 0;
  candidateCount = 0;
  statisticsDirty = false;
  inflight = new Map<string, number>();

  /** 功能：推进排名代数，候选表保留分片进度并惰性重算。@returns 无 */
  invalidateRanks(): void {
    this.generation += 1;
  }

  /** 功能：连接采用节点时增加在途引用。@param key 节点键。@returns 无 */
  acquire(key: string): void {
    if (key) this.inflight.set(key, (this.inflight.get(key) || 0) + 1);
  }

  /** 功能：连接结束或改用节点时释放引用，零值不占表。@param key 节点键。@returns 无 */
  release(key: string): void {
    const count = (this.inflight.get(key) || 1) - 1;
    if (count > 0) this.inflight.set(key, count);
    else this.inflight.delete(key);
  }
}

/** 节点样本与并发引用的领域所有者。 */
export const NODE_MEMORY = new NodeMemory();
