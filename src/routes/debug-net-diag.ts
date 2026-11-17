import { S } from "../core/state";
import { St } from "../core/enums";
import { json } from "../edge/respond";
import { diagVerdict, hostKey } from "../nodes/metrics";
import { httpProbe, isCfHost, resolveV4All } from "../proxy/dial";
import { cfHttpCode } from "../proxy/cfverdict";
import { probeSni } from "../px/probe";
import { aliveList } from "../px/pool";
import { BLK_TTL } from "../route/commitfact";
import { VT_TTL_MS, vAll } from "../route/verdict";
import { doFetch } from "../store/index";

import type { RouteCtx } from "../edge/types";

/** 诊断路由的上下文：`/debug` 挂在用户前缀下，所以一定带着 `id` */
type DebugCtx = RouteCtx & { id: string };

/**
 * 站点诊断：这个站该用哪个节点 / 为什么被拦（读样本 + 主动探活 + 判定表 + 可选 DO 快照）。
 */
export class DebugDiag {
  /**
   * 站点诊断：这个站该用哪个节点 / 为什么被拦。
   * @param c 路由上下文
   * @param url 请求 URL（`?diag=<host>&probe=1&do=1&port=`）
   * @returns 命中时返回诊断结果，否则 `null`
   */
  async diag(c: DebugCtx, url: URL): Promise<Response | null> {
    const { env, id } = c;
    const diagHost = String(url.searchParams.get("diag") || "")
      .trim()
      .toLowerCase();
    if (!diagHost) return null;
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(diagHost)) {
      return json({ ok: false, error: "域名格式不对" });
    }
    const port = Number(url.searchParams.get("port")) || 443;
    const alive = await aliveList(env);
    const ccOf: Record<string, string> = {};
    for (const a of alive) ccOf[a.h + ":" + a.p] = a.cc || "";
    const fam = hostKey(diagHost);
    const rows: DiagRow[] = [];
    const m = S.hostNode.get(fam);
    if (m) {
      for (const [node, s] of m) {
        rows.push({ node, cc: ccOf[node] || "", ...s });
      }
    }
    rows.sort((a, b) => b.n - a.n);
    const direct = S.hostDirect.get(fam) || { ok: 0, bad: 0, at: 0 };

    // 主动探测：不信历史样本时，直接拿每个节点试一次
    // （只验「能不能把这个 SNI 转出去」：probeSni 发完 ClientHello 就等 ServerHello，不完成握手，拿不到应用层状态）
    let probe: Array<{ node: string; cc: string } & SniProbe> | null = null;
    if (url.searchParams.get("probe") === "1") {
      probe = await Promise.all(
        alive.slice(0, 6).map(async (a) => {
          // 第三个参数是目标 SNI；超时走 probeSni 自己的默认值（以前把 port 传进去，
          // 默认 443 会把超时压到 443ms，正常的慢站全被判死）。
          const r = await probeSni(a.h, a.p, diagHost);
          return { node: a.h + ":" + a.p, cc: a.cc || "", ...r };
        }),
      );
    }

    // 有真实样本就用真实样本；没有就退化成这一轮探测的结果
    let basis = rows;
    let basisLabel = "真实流量";
    if (!rows.length && probe) {
      basis = probe.map((p) => ({
        node: p.node,
        cc: p.cc,
        n: 1,
        ok: p.err ? 0 : 1,
        bad: p.err ? 1 : 0,
        bytes: 0,
        ttfb: p.hs || 0,
      }));
      basisLabel = "主动探测";
    }
    // 判定：先看 DNS 解析出的 IP 在不在 CF 网段，再用 HTTP 探一次拿真实状态码
    // （Worker 自己发 HTTPS 请求时看得到状态码；走中继的 WebSocket 隧道是端到端 TLS，看不到状态行——那一路要靠 tfb 在 DO 里用 tunnelfetch 单独建连）
    const ips = await resolveV4All(diagHost).catch(() => []);
    const cfHosted = await isCfHost(diagHost).catch(() => false);
    const live = await httpProbe(diagHost, 4000).catch(() => ({ code: 0, colo: "" }));
    if (live.code) S.cfHttp.set(diagHost, { code: live.code, colo: live.colo, t: Date.now() });
    const cfVerdict = {
      ips,
      cfHosted,
      code: live.code,
      colo: live.colo,
      cached: cfHttpCode(diagHost),
      blocked: live.code >= 400,
    };
    // 该站点在中继上被判 blocked/dead 的条目（来自判定表，带来源与时间）
    const relayBlocked: Array<{ node: string; state: number; src: number; left: number }> = [];
    for (const v of vAll()) {
      if (!v.channel.startsWith("r:") || v.state < St.Blocked) continue;
      relayBlocked.push({
        node: v.channel.slice(2) + ":443",
        state: v.state,
        src: v.src,
        left: Math.round((v.updatedAt + VT_TTL_MS - Date.now()) / 1000),
      });
    }
    // &do=1：把 DO 里跨 isolate 的那份判定也拉出来看（否则只能看到本 isolate 学到的）
    let ringBlk: Array<{ node: string; n: number; left: number }> = [];
    if (url.searchParams.get("do") === "1" && env.METER) {
      try {
        // 读的是 blk2 事实（host|relay → { n, at }），不是计量表里那张早已没有生产者的旧封锁表：
        // 那张表从 7.124 起就没有写者了，诊断会一直显示「DO 里没有封锁」，把空表当成了「没被封锁」。
        const rr = await doFetch(env, id, "https://meter/vt");
        const jj = (await rr.json()) as { blk2?: Array<{ k: string; n: number; at: number }> };
        const now2 = Date.now();
        for (const r of jj.blk2 || []) {
          if (!r || !r.k.startsWith(diagHost + "|")) continue;
          const left = Math.round((r.at + BLK_TTL - now2) / 1000);
          if (left <= 0) continue;
          ringBlk.push({ node: r.k.slice(diagHost.length + 1), n: r.n, left });
        }
        ringBlk.sort((a, b) => b.left - a.left);
      } catch (e) {
        ringBlk = [];
      }
    }
    relayBlocked.sort((a, b) => b.left - a.left);
    const v = diagVerdict(basis, direct);

    return json({
      host: diagHost,
      family: fam,
      port,
      kind: v.kind,
      verdict: v.verdict,
      suspect: v.suspect,
      basis: basisLabel,
      direct,
      samples: rows,
      probe,
      alive: alive.length,
      cfVerdict,
      relayBlocked,
      ringBlk,
      note: "这段说明的是「中转腿」：隧道里是端到端 TLS，只能拿到连接结果；要看真状态码用 cached（本 isolate 直连会话缓存）或 /debug?tfb=",
    });
  }
}

/** DebugDiag 的单例（无状态，可安全共享） */
export const DIAGONE = new DebugDiag();
