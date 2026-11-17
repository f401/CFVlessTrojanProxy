/**
 * 功能：定义「探测传输」的契约 —— 诊断路径要的是「给一个目标（可选中继），发一次请求并回报结果」，
 * 而不关心底下用的是 userland TLS、运行时自带 fetch，还是将来某个别的库。
 *
 * 为什么单独放一个只有类型的文件：实现文件（`transport-tunnelfetch.ts`）与注册表
 * （`transport.ts`）互相需要这些类型，放这里可以避免实现与注册表之间形成循环 import。
 */

/** 一次探测成功时的结果：只留诊断需要看的几项，不把完整响应体带出去 */
export interface TransportProbe {
  /** HTTP 状态码 */
  status: number;
  /** 响应头里的 `server`（CF 的托管站点会暴露这一项） */
  server: string;
  /** 响应体字节数 */
  bytes: number;
  /** 响应体开头 64 字节的可打印形式（用来一眼认出「4 字节 IPv6」这种封锁页） */
  head: string;
  /** 从建连到读完这段的总耗时 */
  ms: number;
}

/** 一次探测的结果：成功带 `probe`，失败带 `err`，两者都带 `ms` */
export type TransportOutcome = ({ ok: true } & TransportProbe) | { ok: false; err: string; ms: number };

/** 探测传输的契约：一个实现只负责「怎么把请求送到目标」 */
export interface ProbeTransport {
  /** 传输名，注册表用它索引，诊断端点也用它告诉调用方当前是谁 */
  readonly transportName: string;
  /** 能否把 TCP 落到指定中继上；直连型实现为 false（调用方据此判断「这条结论能不能代表中继」） */
  readonly relayAware: boolean;
  /**
   * 功能：对目标发一次请求。
   * @param host 目标主机名（会用于 SNI 与 Host 头）
   * @param relay 中继 `host:port`；空串表示直连
   * @param path 请求路径
   * @param timeoutMs 整段预算（含建连、请求、读体）
   * @returns 探测结果（从不 reject：失败包成 `{ ok: false, err }`，诊断路径不该抛异常）
   */
  probe(host: string, relay: string, path: string, timeoutMs: number): Promise<TransportOutcome>;
}
