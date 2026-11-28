import { BoundedMap } from "./table";

/** 本 isolate 的节点观测与排名失效协议，不跨 isolate 共享统计。 */
export class NodeMemory {
  /** 本 isolate 观测到的存活节点（key = host:port → 入口/端口/国家码/最近 RTT） */
  alive = new Map<string, NodeEntry>();
  /** 节点统计（成功/失败、带宽直方图、冻结与黑名单时刻），只在本 isolate 累积 */
  stats = new Map<string, NodeStats>();
  /** 候选排名分片缓存（按查询键缓存 topN；上限 80 条，超出按时间淘汰） */
  rankCache = new BoundedMap<string, { t: number; v: RankRow[] }>({ max: 80, timeOf: (row) => row.t });
  /** 排名代际号：任何统计写入都 +1，缓存键带它，代际一变就重算 */
  generation = 0;
  /** 上一次构建候选表时的池宽（判断分片是否需要重建） */
  candidateCount = 0;
  /** 统计已被写脏：下次取排名前要先重算 p90 与权重 */
  statisticsDirty = false;
  /** 每个节点当前在途连接数（并发选择时估排队代价） */
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
