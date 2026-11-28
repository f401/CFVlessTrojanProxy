import { BoundedMap } from "../core/table";
import { CONNECT_MS } from "../core/util";
import { BudgetedIO } from "../core/budgeted-io";
import { httpProbe } from "./dial";

/** 判定缓存的有效期：3 分钟 */
const CF_HTTP_TTL = 180000;
/** 探测失败后的负缓存：20 秒内不再重试（否则每个请求都会再探一次） */
const CF_HTTP_NEG = 20000;

/**
 * CF HTTP 探测在途集合：本 isolate 内同一站点只放一条探测。
 * 探测是一次真实 fetch（占 request.sub 额度），冷启动要靠它挡住重复探测。
 */
export class CfHttpState {
  /** 缓存与在途守卫由同一对象持有。 */
  cache = new BoundedMap<string, { code: number; colo: string; t: number }>({ max: 200, timeOf: (row) => row.t });
  /** 正在探测的站点 */
  readonly flight = new Set<string>();
}

/** CF HTTP 探测在途持有者 */
export const CF_HTTP = new CfHttpState();

/** 目标站点的 HTTP 判定缓存：200 = 本出口没被按 IP 拒，403 = 被拒（必须绕中继）。0 = 未知。 */
export function cfHttpCode(host: string): number {
  const c = CF_HTTP.cache.get(host);
  return c && Date.now() - c.t < CF_HTTP_TTL ? c.code : 0;
}

/**
 * 功能：过期就后台刷新一次（不进热路径，失败静默）。
 *
 * 去重是必需的：这个函数在 `Dialer.open` 里被**每个** CF 托管目标的连接调用，
 * 而探测是一次真实 fetch（吃 request.sub 额度，每计划最多 6 次）。冷启动时同一站点来 6 条连接，
 * 就是 6 次重复探测 —— 会正好把子请求额度吃完，表现是「所有站点一起变慢/失败」。
 * 因此：在途的站点只探一次；探失败也记 20 秒负缓存，避免逐请求重试。
 * @param {string} host 目标主机
 * @param {{ waitUntil(p: Promise<unknown>): void }} ctx 请求上下文
 * @param quota 请求的子请求账本：探测是一次真实 fetch，必须扣 request.sub，不能 unlimited
 * @returns {void}
 */
export function refreshCfHttp(host: string, ctx: { waitUntil(p: Promise<unknown>): void }, quota: BudgetedIO = BudgetedIO.unlimited()): void {
  const c = CF_HTTP.cache.get(host);
  if (c && Date.now() - c.t < CF_HTTP_TTL) return;
  // 在途：已经有人在探这个站点，不要再发一次
  if (CF_HTTP.flight.has(host)) return;
  // 守卫满时跳过新探测，不能清空仍在飞的集合而放行重复请求。
  if (CF_HTTP.flight.size >= 200) return;
  CF_HTTP.flight.add(host);
  ctx.waitUntil(
    httpProbe(host, CONNECT_MS, quota)
      .then((v) => {
        // 先写负缓存再覆盖：拿到状态码时正缓存覆盖它
        CF_HTTP.cache.set(host, { code: v.code, colo: v.colo, t: v.code ? Date.now() : Date.now() - CF_HTTP_TTL + CF_HTTP_NEG });
        if (CF_HTTP.cache.size > 200) CF_HTTP.cache.prune(Date.now());
      })
      .catch(() => {})
      .finally(() => {
        CF_HTTP.flight.delete(host);
      }),
  );
}
