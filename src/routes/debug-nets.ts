import type { RouteCtx } from "../edge/types";
import { errMsg, withTimeout } from "../core/util";
import { json } from "../edge/respond";
import { S } from "../core/state";
import { St } from "../core/enums";
import { diagVerdict, hostKey } from "../nodes/metrics";
import { httpProbe, isCfHost, resolveV4All, checkTarget, dohQuery, expandV6, resolveAAAA } from "../proxy/dial";
import { cfHttpCode } from "../proxy/cfverdict";
import { probeSni, probeProxy } from "../px/probe";
import { aliveList } from "../px/pool";
import { BLK_TTL } from "../route/commitfact";
import { VT, VT_TTL_MS } from "../route/verdict";
import { doFetch } from "../store/index";
import { probeHttp80, splitRelay } from "../core/http80";
import { adminOnly } from "../edge/auth";
import { SOCKET_DIALER } from "../proxy/socket-dialer";
import { DIRECT, chanKey } from "../route/channel";
import type { Chan } from "../route/channel";
import { runTfb } from "../route/tfb";

// ---- 并入自 debug-net-bench.ts ----
/**
 * 出口测速：Worker 自己到源站有多快（只花一次子请求，不占 `connect()` 名额）。
 */
export class DebugBench {
  /**
   * 出口测速：Worker 自己到源站有多快。
   * @param url 请求 URL（`?bench=<url>&bytes=<n>`）
   * @returns 命中时返回测速结果，否则 `null`
   */
  async bench(url: URL): Promise<Response | null> {
    const benchUrl = String(url.searchParams.get("bench") || "").slice(0, 300);
    if (!benchUrl) return null;
    // 夹在 64KB 与 32MB 之间：太小测不出吞吐，太大会把这次调用拖到超时
    const cap = Math.max(
      64 * 1024,
      Math.min(32 * 1024 * 1024, Number(url.searchParams.get("bytes") || 4_000_000) || 4_000_000),
    );
    const t0 = Date.now();
    let got = 0;
    let first = 0;
    let status = 0;
    let err = "";
    let aborted = false;
    const ac = new AbortController();
    // 源站很慢时不能把这次调用拖死：20 秒后中止，已读到的字节照样报出来
    const timer = setTimeout(() => {
      aborted = true;
      ac.abort();
    }, 20000);
    try {
      const r = await fetch(benchUrl, { signal: ac.signal });
      status = r.status;
      if (r.body) {
        const rd = r.body.getReader();
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          if (value && value.length) {
            got += value.length;
            if (!first) first = Date.now();
            if (got >= cap) break;
          }
        }
        try {
          rd.cancel();
        } catch (e) {
          // 取消失败无所谓：连接本来就要丢
        }
      }
    } catch (e) {
      err = errMsg(e).slice(0, 80);
    }
    clearTimeout(timer);
    // 用「从发起到读完」的总时长算速率：cf 里同网源站会把整段 body 一次性缓冲好，
    // 只按「首字节到末字节」算会得到 3.9 GB/s 这种假数字。ttfb 单独报。
    const total = Math.max(1, Date.now() - t0);
    return json({
      bench: benchUrl,
      status,
      kb: Math.round(got / 1024),
      ms: total,
      kbs: Math.round(got / 1024 / (total / 1000)),
      ttfb: first ? first - t0 : 0,
      aborted,
      err,
    });
  }
}


// ---- 并入自 debug-net-diag.ts ----
/** 允许诊断的站点名形状（小写字母数字与点、连字符，首尾不能是符号） */
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
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
    // 这个分支只服务 ?diag=：没传就直接让给后面的探针分支
    const { env, id } = c;
    const host = this.hostOf(url);
    if (!host) return null;
    if (!HOST_RE.test(host)) return json({ ok: false, error: "域名格式不对" });
    const port = Number(url.searchParams.get("port")) || 443;
    const alive = await aliveList(env);
    const fam = hostKey(host);
    // 真实样本（本 isolate 学到的）与主动探测（?probe=1）是两份证据，后者只在没样本时兜底
    const rows = this.sampleRows(alive, fam);
    const probe = url.searchParams.get("probe") === "1" ? await this.probeTops(alive, host) : null;
    const picked = this.pickBasis(rows, probe);
    const direct = S.hostDirect.get(fam) || { ok: 0, bad: 0, at: 0 };
    // 三段证据各自独立取：CF 托管事实（两次外部探测）、本 isolate 判定表、DO 里跨 isolate 的封锁环
    const cfVerdict = await this.cfFacts(host);
    const relayBlocked = this.relayBlocked();
    const ringBlk = await this.doRing(env, id, url, host);
    const v = diagVerdict(picked.rows, direct);

    return json({
      host,
      family: fam,
      port,
      kind: v.kind,
      verdict: v.verdict,
      suspect: v.suspect,
      basis: picked.label,
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

  /**
   * 功能：从查询串取出要诊断的目标站点（去掉首尾空白、统一小写）。
   * @param url 请求 URL
   * @returns 站点名；没有传 `?diag=` 时返回空串（调用方据此判定「不是这个分支」）
   */
  private hostOf(url: URL): string {
    return String(url.searchParams.get("diag") || "")
      .trim()
      .toLowerCase();
  }

  /**
   * 功能：把本 isolate 记在站点画像里的样本展开成诊断行（带上每个节点的国家码）。
   * @param alive 当前存活表（用来补国家码）
   * @param fam 站点族键（`hostKey` 的结果）
   * @returns 按样本数降序的行；一条样本都没有时是空数组
   */
  private sampleRows(alive: Array<{ h: string; p: number; cc?: string }>, fam: string): DiagRow[] {
    const ccOf: Record<string, string> = {};
    for (const a of alive) ccOf[a.h + ":" + a.p] = a.cc || "";
    const rows: DiagRow[] = [];
    const m = S.hostNode.get(fam);
    if (m) {
      for (const [node, s] of m) rows.push({ node, cc: ccOf[node] || "", ...s });
    }
    rows.sort((a, b) => b.n - a.n);
    return rows;
  }

  /**
   * 功能：不信历史样本时，拿前面几条存活节点各探一次「能不能把这个 SNI 转出去」。
   *
   * 只验中转腿：`probeSni` 发完 ClientHello 就等 ServerHello，不完成握手，拿不到应用层状态。
   * 超时走 `probeSni` 自己的默认值 —— 第三个参数是目标 SNI，以前把 port 传进去，
   * 默认 443 会把超时压到 443ms，正常的慢站全被判死。
   * @param alive 当前存活表
   * @param host 目标站点
   * @returns 每条节点的探测结果（最多 6 条）
   */
  private async probeTops(
    alive: Array<{ h: string; p: number; cc?: string }>,
    host: string,
  ): Promise<Array<{ node: string; cc: string } & SniProbe> | null> {
    return Promise.all(
      alive.slice(0, 6).map(async (a) => {
        const r = await probeSni(a.h, a.p, host);
        return { node: a.h + ":" + a.p, cc: a.cc || "", ...r };
      }),
    );
  }

  /**
   * 功能：决定用哪份证据给结论 —— 有真实样本就用真实样本，没有就退化成这一轮主动探测的结果。
   * @param rows 真实流量样本
   * @param probe 主动探测结果（没开 `?probe=1` 时是 `null`）
   * @returns `{ rows, label }`：参与判定的行与它们的来源说明
   */
  private pickBasis(
    rows: DiagRow[],
    probe: Array<{ node: string; cc: string } & SniProbe> | null,
  ): { rows: DiagRow[]; label: string } {
    if (rows.length || !probe) return { rows, label: "真实流量" };
    return {
      rows: probe.map((p) => ({
        node: p.node,
        cc: p.cc,
        n: 1,
        ok: p.err ? 0 : 1,
        bad: p.err ? 1 : 0,
        bytes: 0,
        ttfb: p.hs || 0,
      })),
      label: "主动探测",
    };
  }

  /**
   * 功能：取这个站点的「CF 托管 + 真实状态码」事实。
   *
   * Worker 自己发 HTTPS 请求时看得到状态码；走中继的 WebSocket 隧道是端到端 TLS，看不到状态行。
   * 探到的状态码顺手写进本 isolate 的会话缓存（`S.cfHttp`），后续 `cfHttpCode()` 直接用。
   * @param host 目标站点
   * @returns 诊断用的四元组：解析出的 IP、是否 CF 托管、状态码与机房、缓存里的值、是否算被拦
   */
  private async cfFacts(host: string): Promise<{
    ips: string[];
    cfHosted: boolean;
    code: number;
    colo: string;
    cached: number;
    blocked: boolean;
  }> {
    // 三次探测都带兜底：诊断不该因为 DNS 或一次 HTTP 失败就整体 5xx
    const ips = await resolveV4All(host).catch(() => []);
    const cfHosted = await isCfHost(host).catch(() => false);
    const live = await httpProbe(host, 4000).catch(() => ({ code: 0, colo: "" }));
    if (live.code) S.cfHttp.set(host, { code: live.code, colo: live.colo, t: Date.now() });
    return {
      ips,
      cfHosted,
      code: live.code,
      colo: live.colo,
      cached: cfHttpCode(host),
      blocked: live.code >= 400,
    };
  }

  /**
   * 功能：列出判定表里「本 isolate 学到」的中继侧封锁条目。
   * @returns 每个被判 blocked/dead 的中继：通道名、状态、证据来源、剩余封锁秒数
   */
  private relayBlocked(): Array<{ node: string; state: number; src: number; left: number }> {
    const out: Array<{ node: string; state: number; src: number; left: number }> = [];
    for (const v of VT.all()) {
      if (!v.channel.startsWith("r:") || v.state < St.Blocked) continue;
      out.push({
        node: v.channel.slice(2) + ":443",
        state: v.state,
        src: v.src,
        left: Math.round((v.updatedAt + VT_TTL_MS - Date.now()) / 1000),
      });
    }
    out.sort((a, b) => b.left - a.left);
    return out;
  }

  /**
   * 功能：`&do=1` 时把 DO 里跨 isolate 的那份封锁事实拉出来（否则只能看到本 isolate 学到的）。
   *
   * 读的是 `blk2` 事实（`host|relay → { n, at }`），不是计量表里那张从 7.124 起就没有生产者的旧封锁表 ——
   * 读旧表会一直显示「DO 里没有封锁」，把空表当成了「没被封锁」。
   * @param env 环境绑定
   * @param id 用户 id（DO 实例名）
   * @param url 请求 URL（只用来判 `&do=1`）
   * @param host 目标站点
   * @returns 每条中继的批数与剩余秒数，按剩余时间降序；没开 `&do=1` 时是空数组
   */
  private async doRing(
    env: Env,
    id: string,
    url: URL,
    host: string,
  ): Promise<Array<{ node: string; n: number; left: number }>> {
    if (url.searchParams.get("do") !== "1" || !env.METER) return [];
    try {
      const rr = await doFetch(env, id, "https://meter/vt");
      const jj = (await rr.json()) as { blk2?: Array<{ k: string; n: number; at: number }> };
      const now2 = Date.now();
      const out: Array<{ node: string; n: number; left: number }> = [];
      for (const r of jj.blk2 || []) {
        if (!r || !r.k.startsWith(host + "|")) continue;
        const left = Math.round((r.at + BLK_TTL - now2) / 1000);
        if (left <= 0) continue;
        out.push({ node: r.k.slice(host.length + 1), n: r.n, left });
      }
      out.sort((a, b) => b.left - a.left);
      return out;
    } catch (e) {
      // 读不到就当「这一轮没有跨 isolate 证据」：诊断不该因为一次 DO 往返失败而整体报错
      return [];
    }
  }
}


// ---- 并入自 debug-net-probe.ts ----

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
      return json({ ok: true, probe: out, note: "diagnostic only", chan: chanKey(chan), state: VT.state(hh, chanKey(chan)) });
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


// ---- 并入自 debug-net-tf.ts ----

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


// ---- 门面（对外导出面保持不变） ----
// 会对外拨号的诊断分支门面：七个分支按「花什么预算」分成四个组件。
//
// 为什么按预算分而不是按字母分：免费计划上三条额度互不相干，却都在这几个分支里被消耗 ——
// ① 同时打开的 `connect()` ≤ 6（原始探活、IPv6 可达性、明文 HTTP、站点诊断的主动探测）；
// ② 一次调用 fetch 子请求 ≤ 50（出口测速、判定批、单次真握手、站点诊断的 DO 快照）；
// ③ DO CPU 只有几十毫秒（判定批与单次真握手必须绕到 DO 里用 `tunnelfetch`）。
// 混在 344 行的同一个类里时，读者看不出点哪个参数会真的拨号、会花哪一种额度。



/**
 * 会主动对外发起连接的诊断路由门面：七个分支的实现在四个组件里，这里只按原顺序派发。
 *
 * 顺序不能改：只读表 → 出口测速 → 站点诊断 → 原始探活 → 抓源 → 钉住 → 明文 HTTP →
 * 计量诊断 → 判定批 → 单次真握手 → 回填 → seed → 兜底 host。一旦颠倒，
 * `?diag=x&refill=1` 这种组合会先花掉一次抓源再回答只读问题。
 */
export class DebugNets {
  /** 出口测速（花一次子请求） */
  readonly benchRunner = new DebugBench();
  /** 站点诊断（读样本免费，可选主动探活占 `connect()` 名额） */
  readonly diagRunner = new DebugDiag();
  /** 原始探活与明文 HTTP（都占 `connect()` 名额） */
  readonly probeRunner = new DebugProbe();
  /** 判定批与单次真握手（花子请求并吃 DO CPU） */
  readonly tfRunner = new DebugTf();
  /**
   * 出口测速（花一次子请求）。
   * @param url 请求 URL（`?bench=<url>&bytes=<n>`）
   * @returns 命中时返回测速结果，否则 `null`
   */
  async bench(url: URL): Promise<Response | null> {
    return this.benchRunner.bench(url);
  }

  /**
   * 站点诊断（读样本免费，可选主动探活占 `connect()` 名额）。
   * @param c 路由上下文
   * @param url 请求 URL（`?diag=<host>&probe=1&do=1&port=`）
   * @returns 命中时返回诊断结果，否则 `null`
   */
  async diag(c: DebugCtx, url: URL): Promise<Response | null> {
    return this.diagRunner.diag(c, url);
  }

  /**
   * 原始探活（占 `connect()` 名额）。
   * @param url 请求 URL（`?probe=<host:port>`）
   * @returns 命中时返回探活结果，否则 `null`
   */
  async rawProbe(url: URL): Promise<Response | null> {
    return this.probeRunner.rawProbe(url);
  }

  /**
   * 明文 HTTP（占 `connect()` 名额）。
   * @param c 路由上下文
   * @param url 请求 URL（`?http=<host>&r=<relay>&p=<path>`）
   * @returns 命中时返回探测结果，否则 `null`
   */
  async http(c: DebugCtx, url: URL): Promise<Response | null> {
    return this.probeRunner.http(c, url);
  }

  /**
   * 判定批（子请求额度 + DO CPU）。
   * @param c 路由上下文
   * @param url 请求 URL（`?tfb=<host>&n=<次数>&r=<中继>`）
   * @returns 命中时返回判定批结果，否则 `null`
   */
  async tfb(c: DebugCtx, url: URL): Promise<Response | null> {
    return this.tfRunner.tfb(c, url);
  }

  /**
   * 单次真握手（子请求额度 + DO CPU）。
   * @param c 路由上下文
   * @param url 请求 URL（`?tf=<host>&r=<中继>`）
   * @returns 命中时返回 DO 的原始应答，否则 `null`
   */
  async tf(c: DebugCtx, url: URL): Promise<Response | null> {
    return this.tfRunner.tf(c, url);
  }

  /**
   * 兜底分支：IPv6 解析与可达性（占 `connect()` 名额）。
   * @param url 请求 URL（`?host=<域名>`，缺省 example.com）
   * @returns 解析与建连结果
   */
  async host(url: URL): Promise<Response> {
    return this.probeRunner.host(url);
  }
}

/** 会对外拨号的诊断分支门面单例 */