import { withTimeout } from "../core/util";
import { adminOnly } from "../edge/auth";
import { runTfb } from "../route/tfb";
import { doFetch } from "../store/index";

import type { RouteCtx } from "../edge/types";

/** 诊断路由的上下文：`/debug` 挂在用户前缀下，所以一定带着 `id` */
type DebugCtx = RouteCtx & { id: string };

/**
 * 借计量 DO 的 CPU 走 `tunnelfetch` 做真握手（免费计划上只有 DO 里跑得动单发 TLS）。
 */
export class DebugTf {
  /**
   * 判定批：由 DO 里的 `tunnelfetch` 对目标站连打几次，看封没封。
   * @param c 路由上下文
   * @param url 请求 URL（`?tfb=<host>&n=<次数>&r=<中继>`）
   * @returns 命中时返回判定批结果，否则 `null`
   */
  async tfb(c: DebugCtx, url: URL): Promise<Response | null> {
    if (!url.searchParams.get("tfb")) return null;
    const deny = await adminOnly(c);
    if (deny) return deny;
    const r = String(url.searchParams.get("r") || "");
    return runTfb(c, String(url.searchParams.get("tfb") || ""), Number(url.searchParams.get("n") || 2), r);
  }
  /**
   * 单次真握手：借 DO 的 CPU 走一回 `tunnelfetch`。
   * @param c 路由上下文
   * @param url 请求 URL（`?tf=<host>&r=<中继>`）
   * @returns 命中时返回 DO 的原始应答，否则 `null`
   */
  async tf(c: DebugCtx, url: URL): Promise<Response | null> {
    if (!url.searchParams.get("tf")) return null;
    const deny = await adminOnly(c);
    if (deny) return deny;
    const tfHost = String(url.searchParams.get("tf") || "");
    const tfRelay = String(url.searchParams.get("r") || "");
    // 实例名固定 `tf-probe`：这条探测不写任何用户账本，只是想借 DO 的 CPU 做一次真握手
    const r = (await withTimeout(
      doFetch(c.env, "tf-probe", `https://meter/tf?h=${encodeURIComponent(tfHost)}&r=${encodeURIComponent(tfRelay)}`),
      20000,
    )) as Response | undefined;
    const body = r ? await withTimeout(r.json(), 5000) : { ok: false, err: "tf-timeout" };
    return Response.json({ host: tfHost, relay: tfRelay, do: body });
  }
}

/** DebugTf 的单例（无状态，可安全共享） */
export const TFPROBES = new DebugTf();
