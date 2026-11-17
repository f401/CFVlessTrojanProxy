// 探活批处理：把「一批候选键」按并发上限切成段，逐段握手，结果原样交回。
//
// 抽出来是因为池子维护、头部复测、新候选扫描三处都做同一件事（切段 + 并发 + 收集），
// 而并发上限 `SC.PROBE_CONC` 是免费计划最容易撞线的额度（全局同时只有 6 个 `connect()`）。

import { SC } from "../core/const";
import { splitRelay } from "../core/http80";
import { chunks, probeProxy } from "./probe";

/**
 * 一条探活结果（`bad` 非空表示失败原因；`tcp`/`tls` 是两段握手的耗时）。
 *
 * 继承 `NodeEntry` 而不是另立一份：探活结果要直接喂给 `keyOf()` 与存活表，
 * 那两个函数的入参是 `NodeEntry`，形状不一致时只能靠 `as` 硬转 —— 转错不会有任何编译错误。
 */
export interface ProbeHit extends NodeEntry {
  /** 探活耗时（毫秒，两段握手之和）；`NodeEntry` 里它是可选的，这里必须有值才算命中 */
  ms: number;
  /** TCP 段耗时（失败时是它先失败，两者一起看才分得清是网络还是 TLS） */
  tcp?: number;
  /** TLS 段耗时 */
  tls?: number;
  /** 失败原因（`err`/`notTls`/`noCf` 等，写进 `S.probeWhy` 的同一套词） */
  bad?: string;
}

/**
 * 功能：探一条候选（键形如 `host:port`）。
 * @param key 候选键
 * @returns 探活结果；解析不出端口时回 `null`
 */
export async function probeOne(key: string): Promise<ProbeHit | null> {
  const [probeHost, probePort] = splitRelay(key, 443);
  return (await probeProxy(probeHost, probePort)) as ProbeHit | null;
}

/**
 * 功能：按并发上限探一批候选键（顺序与入参一致，失败项原样留在结果里）。
 *
 * `SC.PROBE_CONC` 是段大小而不是总并发：超时那条会被 `probeProxy` 内部收口，
 * 所以段与段之间不必再等待，串行发段只是为了让同时在飞的握手数不超过额度。
 * @param keys 候选键
 * @returns 与 `keys` 一一对应的结果
 */
export async function probeBatch(keys: string[]): Promise<Array<{ k: string; r: ProbeHit | null }>> {
  const out: Array<{ k: string; r: ProbeHit | null }> = [];
  for (const seg of chunks(keys, SC.PROBE_CONC)) {
    const part = await Promise.all(seg.map(async (k) => ({ k, r: await probeOne(k) })));
    for (const row of part) out.push(row);
  }
  return out;
}
