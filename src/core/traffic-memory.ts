/** 连接观测与字节遥测；上报确认按增量消费，不能整表清空。 */
export class TrafficMemory {
  aggregates = new Map<string, { n: number; ok: number; dn: number; v: number[] }>();
  funnel: Record<string, number> = { direct: 0, node: 0, v6: 0 };
  egressBytes = 0;

  /** 功能：按通道累加已结算字节。@param via 通道名。@param bytes 增量字节。@returns 无 */
  account(via: string, bytes: number): void {
    this.funnel[via] = (this.funnel[via] || 0) + bytes;
  }
}

/** 连接遥测的 isolate 所有者。 */
export const TRAFFIC_MEMORY = new TrafficMemory();
