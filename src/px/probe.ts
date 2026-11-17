// 探活与池子抓取的门面：`probe.ts` 曾经 524 行、把四件事挤在一起，现在只做再导出。
// 实现分别在 ./poolsrc（源清单与抓取）、./rawprobe（原始 TLS 探活）、
// ./geo（国家码）、./failpolicy（失败阈值策略）—— 调用点与单测一行都不用改。

export { EXTRA_HOSTS, POOL_ENOUGH, POOL_MAX, POOL_SOURCES, POOL_TTL_MS, PX_LINE, REFILL_MAX, SourceHealth, SOURCES, chunks, poolSources, refillPool, takePoolLine } from "./poolsrc";
export type { PoolRefill } from "./poolsrc";
export { PROBE_HELLO, probeProxy, probeSni, tlsHello } from "./rawprobe";
export { geoLabel } from "./geo";
export { pxPolicy } from "./failpolicy";
