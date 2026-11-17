import { TRANSPORTS } from "./transport";
import type { TransportOutcome } from "./transport-types";

/** 一次探测的总预算：userland TLS 走中继，卡住的那一刻不会自己回来。
 * 不设上限时，DO 里那个请求会一直挂着 —— 探测是诊断路径，绝不能拖住计量端点。 */
const PROBE_BUDGET_MS = 8000;

/**
 * 功能：探测「目标（可选中继）能不能拿到响应」，实现由 `TRANSPORTS` 决定。
 *
 * 这里只留一层门面：具体怎么送（userland TLS 落中继 / 运行时自带 fetch 直连）在
 * `src/core/transport-tunnelfetch.ts` 的两个实现里，注册表在 `src/core/transport.ts`。
 * 这样加一个新的探测方式不需要改调用点，也不需要在这个文件里塞分支。
 *
 * @param host 目标主机名
 * @param relay 中继 `host:port`（空串表示直连）
 * @param path 请求路径
 * @param transportName 可选：指定用哪个传输（默认取注册表当前的；拼错则回落到默认）
 * @returns 结果（ok/status/server/bytes/head/ms 或 ok:false/err/ms）
 */
export async function probeTf(
  host: string,
  relay = "",
  path = "/",
  transportName?: string,
): Promise<TransportOutcome> {
  // 传输选择放在门面里做：调用点只关心「探测这件事」，不关心谁去送
  const transport = TRANSPORTS.get(transportName);
  return transport.probe(host, relay, path, PROBE_BUDGET_MS);
}
