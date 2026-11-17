// 会对外拨号的诊断分支门面：七个分支按「花什么预算」分成四个组件。
//
// 为什么按预算分而不是按字母分：免费计划上三条额度互不相干，却都在这几个分支里被消耗 ——
// ① 同时打开的 `connect()` ≤ 6（原始探活、IPv6 可达性、明文 HTTP、站点诊断的主动探测）；
// ② 一次调用 fetch 子请求 ≤ 50（出口测速、判定批、单次真握手、站点诊断的 DO 快照）；
// ③ DO CPU 只有几十毫秒（判定批与单次真握手必须绕到 DO 里用 `tunnelfetch`）。
// 混在 344 行的同一个类里时，读者看不出点哪个参数会真的拨号、会花哪一种额度。
import { BENCH, DebugBench } from "./debug-net-bench";
import { DIAGONE, DebugDiag } from "./debug-net-diag";
import { PROBES, DebugProbe } from "./debug-net-probe";
import { TFPROBES, DebugTf } from "./debug-net-tf";

import type { RouteCtx } from "../edge/types";

/** 诊断路由的上下文：`/debug` 挂在用户前缀下，所以一定带着 `id` */
type DebugCtx = RouteCtx & { id: string };

/**
 * 会主动对外发起连接的诊断路由门面：七个分支的实现在四个组件里，这里只按原顺序派发。
 *
 * 顺序不能改：只读表 → 出口测速 → 站点诊断 → 原始探活 → 抓源 → 钉住 → 明文 HTTP →
 * 计量诊断 → 判定批 → 单次真握手 → 回填 → seed → 兜底 host。一旦颠倒，
 * `?diag=x&refill=1` 这种组合会先花掉一次抓源再回答只读问题。
 */
export class DebugNets {
  /**
   * 出口测速（花一次子请求）。
   * @param url 请求 URL（`?bench=<url>&bytes=<n>`）
   * @returns 命中时返回测速结果，否则 `null`
   */
  async bench(url: URL): Promise<Response | null> {
    return BENCH.bench(url);
  }

  /**
   * 站点诊断（读样本免费，可选主动探活占 `connect()` 名额）。
   * @param c 路由上下文
   * @param url 请求 URL（`?diag=<host>&probe=1&do=1&port=`）
   * @returns 命中时返回诊断结果，否则 `null`
   */
  async diag(c: DebugCtx, url: URL): Promise<Response | null> {
    return DIAGONE.diag(c, url);
  }

  /**
   * 原始探活（占 `connect()` 名额）。
   * @param url 请求 URL（`?probe=<host:port>`）
   * @returns 命中时返回探活结果，否则 `null`
   */
  async rawProbe(url: URL): Promise<Response | null> {
    return PROBES.rawProbe(url);
  }

  /**
   * 明文 HTTP（占 `connect()` 名额）。
   * @param c 路由上下文
   * @param url 请求 URL（`?http=<host>&r=<relay>&p=<path>`）
   * @returns 命中时返回探测结果，否则 `null`
   */
  async http(c: DebugCtx, url: URL): Promise<Response | null> {
    return PROBES.http(c, url);
  }

  /**
   * 判定批（子请求额度 + DO CPU）。
   * @param c 路由上下文
   * @param url 请求 URL（`?tfb=<host>&n=<次数>&r=<中继>`）
   * @returns 命中时返回判定批结果，否则 `null`
   */
  async tfb(c: DebugCtx, url: URL): Promise<Response | null> {
    return TFPROBES.tfb(c, url);
  }

  /**
   * 单次真握手（子请求额度 + DO CPU）。
   * @param c 路由上下文
   * @param url 请求 URL（`?tf=<host>&r=<中继>`）
   * @returns 命中时返回 DO 的原始应答，否则 `null`
   */
  async tf(c: DebugCtx, url: URL): Promise<Response | null> {
    return TFPROBES.tf(c, url);
  }

  /**
   * 兜底分支：IPv6 解析与可达性（占 `connect()` 名额）。
   * @param url 请求 URL（`?host=<域名>`，缺省 example.com）
   * @returns 解析与建连结果
   */
  async host(url: URL): Promise<Response> {
    return PROBES.host(url);
  }
}

/** 会对外拨号的诊断分支门面单例 */
export const NETS = new DebugNets();

export { BENCH, DIAGONE, DebugBench, DebugDiag, DebugProbe, DebugTf, PROBES, TFPROBES };
