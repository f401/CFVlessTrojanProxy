import { S } from "../core/state";
import { httpProbe } from "./dial";

/** 冷启动时把 DO 里的 403 判定读回来（每 isolate 一次），否则每个新 isolate 都要从零踩坑。 */

/** 目标站点的 HTTP 判定缓存：200 = 本出口没被按 IP 拒，403 = 被拒（必须绕中继）。0 = 未知。 */
export function cfHttpCode(host: string): number {
  const c = S.cfHttp.get(host);
  return c && Date.now() - c.t < 180000 ? c.code : 0;
}

/** 过期就后台刷新一次（不进热路径，失败静默）。 */
export function refreshCfHttp(host: string, ctx: { waitUntil(p: Promise<unknown>): void }): void {
  const c = S.cfHttp.get(host);
  if (c && Date.now() - c.t < 180000) return;
  if (S.cfHttp.size > 200) S.cfHttp.clear();
  ctx.waitUntil(
    httpProbe(host, 2500)
      .then((v) => {
        if (v.code) S.cfHttp.set(host, { code: v.code, colo: v.colo, t: Date.now() });
      })
      .catch(() => {}),
  );
}

