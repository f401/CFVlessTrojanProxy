import { errMsg, withTimeout } from "../core/util";
import { probeHttp80, splitRelay } from "../core/http80";
import { json } from "../edge/respond";
import { adminOnly } from "../edge/auth";
import { checkTarget, dohQuery, expandV6, resolveAAAA } from "../proxy/dial";
import { SOCKET_DIALER } from "../proxy/socket-dialer";
import { probeProxy } from "../px/probe";
import { DIRECT, chanKey } from "../route/channel";
import { vState } from "../route/verdict";

import type { Chan } from "../route/channel";

import type { RouteCtx } from "../edge/types";

/** 诊断路由的上下文：`/debug` 挂在用户前缀下，所以一定带着 `id` */
type DebugCtx = RouteCtx & { id: string };

/**
 * 直接对外拨号的三个探针：原始 ClientHello、明文 HTTP、IPv6 可达性（每一个都受 `connect()` 名额约束）。
 */
export class DebugProbe {
  /**
   * 原始探活：给一个 `host:port` 发 ClientHello 看能不能拿到 ServerHello。
   * @param url 请求 URL（`?probe=<host:port>`）
   * @returns 命中时返回探活结果，否则 `null`；格式不合法时报错而不拨号
   */
  async rawProbe(url: URL): Promise<Response | null> {
    const pr = url.searchParams.get("probe");
    if (!pr) return null;
    // 拆地址只准有一份实现：内联 lastIndexOf 会把 [v6]:443 当成主机名 "[v6]" 拒掉，
    // 而 IPv6 中继恰恰是最需要用 ?probe= 量的那批（v6 出口是 CF 托管站点 403 的来源）。
    const [ph, pp] = splitRelay(pr, 443);
    const bad = checkTarget(ph, pp);
    if (bad) return json({ probe: pr, ok: false, error: bad });
    const r = await probeProxy(ph, pp);
    return json({ probe: pr, ok: !!r, result: r });
  }
  /**
   * 明文 HTTP 诊断：`?http=<host>&r=<relay>&p=<path>`。
   * @param c 路由上下文
   * @param url 请求 URL
   * @returns 命中时返回探测结果（只诊断、不写判定），否则 `null`
   */
  async http(c: DebugCtx, url: URL): Promise<Response | null> {
    if (!url.searchParams.get("http")) return null;
    const deny = await adminOnly(c);
    if (deny) return deny;
    const hh = String(url.searchParams.get("http"));
    const rr = url.searchParams.get("r") || "";
    const pp = url.searchParams.get("p") || "/";
    if (!c.env.METER) return json({ ok: false, error: "no METER" });
    try {
      // 明文探测很便宜（connect + 读 ≤2KB），直接在请求路径做，不绕 DO（DO 那条会等 20s+ 才被重置）
      const out = await withTimeout(probeHttp80(hh, rr, pp), 6000);
      const chan = rr ? ({ kind: "r", ip: rr.split(":")[0] } as Chan) : DIRECT;
      return json({ ok: true, probe: out, note: "diagnostic only", chan: chanKey(chan), state: vState(hh, chanKey(chan)) });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  /**
   * 兜底分支：`AAAA` 与 `A` 各查一次，再试一次 IPv6 建连。
   * @param url 请求 URL（`?host=<域名>`，缺省 example.com）
   * @returns 解析与建连结果
   */
  async host(url: URL): Promise<Response> {
    const h = url.searchParams.get("host") || "example.com";
    const out: Record<string, unknown> = { host: h, aaaa: null, a: null, v6Connect: null };
    try {
      out.aaaa = await resolveAAAA(h);
    } catch (e) {
      out.aaaa = "ERR " + errMsg(e);
    }
    try {
      out.a = await dohQuery(h, "A");
    } catch (e) {
      out.a = "ERR " + errMsg(e);
    }
    if (out.aaaa && typeof out.aaaa === "string" && out.aaaa.includes(":")) {
      const bad6 = checkTarget(out.aaaa, 443);
      if (bad6) out.v6Connect = "denied: " + bad6;
      else {
        // 只想知道这条 v6 地址能不能建连。`connect()` 本身没有超时：黑洞地址会一直挂着，
        // 占住免费计划全局 6 个 `connect` 名额中的一个（7.169–7.171 修过五处同类）。
        try {
          // 预算与「超时后关掉迟到 socket」只有一处实现（`SocketDialer.open`）：这个分支以前
          // 自己抄了一遍，7.272 收敛时漏了它，于是两个文件各有一份建连预算的语义。
          const s6 = await SOCKET_DIALER.open(expandV6(out.aaaa), 443);
          out.v6Connect = "ok";
          try {
            s6.close();
          } catch (e) {
            // 关不掉无所谓：这条连接只为验一次可达性
          }
        } catch (e) {
          out.v6Connect = "ERR " + errMsg(e);
        }
      }
    }
    return json(out);
  }
}

/** DebugProbe 的单例（无状态，可安全共享） */
export const PROBES = new DebugProbe();
