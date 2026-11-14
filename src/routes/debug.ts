import { errMsg, withTimeout } from "../core/util";
import { probeHttp80 } from "../core/http80";
import { probeRaw } from "../core/tlsprobe";
import { probeTls } from "../core/tlsprobe";
import { connect } from "cloudflare:sockets";

import { S } from "../core/state";
import { json } from "../edge/respond";
import { diagVerdict, hostKey } from "../nodes/metrics";
import { nsGet } from "../nodes/score";
import { cfHttpCode } from "../proxy/cfverdict";
import { sweepHost } from "../route/sweep";
import { vAll, vState } from "../route/verdict";
import { vtDelta, vtLoad } from "../route/verdictsync";
import { cntView } from "../core/counter";
import { planView } from "../route/budget";
import { prefsJson } from "../route/prefs";
import { DIRECT, chanKey } from "../route/channel";
import { HEALTH } from "../route/relay-health";
import { verifyInfo } from "../route/verify";
import { checkTarget, dohQuery, expandV6, httpProbe, isCfHost, resolveAAAA, resolveV4All } from "../proxy/dial";
import { aliveList, commitPool, flushPx, pxSet } from "../px/pool";
import { EXTRA_HOSTS, probeProxy, probeSni, refillPool } from "../px/probe";
import { clSnapshot, restoreUsage } from "../store/index";
import { adminOnly } from "../edge/auth";
import { edgeFlush, edgeLoad, edgeNodes, edgeRank, edgeScan } from "../route/edge";

import type { Chan } from "../route/channel";
import type { RouteCtx } from "../edge/types";

type UserCtx = RouteCtx & { id: string };

/** /<uuid>/debug：站点诊断（?diag=<host>&probe=1 做一次 SNI 探测） */
export async function debug(c: UserCtx): Promise<Response> {
  const { env, url, host: _host, id, first: _first, ctx: _ctx } = c;

  /* ---------- 连接记录：本 isolate 最近 40 条 +（&do=1）DO 环形 60 条 ---------- */
  const vtHost = String(url.searchParams.get("vt") || "").slice(0, 80);
  // &do=1：先把这个 isolate 学的强证据写回 DO，再把 DO 里的合并回来，
  // 这样从任意边缘读都能看到「刚刚在别的 isolate 学到的封锁」。
  if (url.searchParams.get("do") === "1" && env.METER) {
    try {
      const rows = vtDelta();
      if (rows.length) {
        await env.METER.get(env.METER.idFromName(String(env.uuid || env.uuids).split(",")[0].trim().toLowerCase())).fetch("https://meter/add", {
          method: "POST",
          body: JSON.stringify({ vt: rows }),
        });
      }
    } catch {
      // 忽略
    }
    S.vtLoaded = false;
    await vtLoad(env);
  }
  if (vtHost) {
    // 默认只读表（TLS 探测在免费计划会 1102，只有显式 &probe=1 才做）
    const wantProbe = url.searchParams.get("probe") === "1";
    const sw = wantProbe ? await sweepHost(vtHost) : { ips: [], nodes: [], rows: [] };
    const plan = planView(S.pool.length, S.alive.size);
    const pol = { same: S.polSame, diff: S.polDiff, why: S.polWhy };
    return json({ host: vtHost, ips: sw.ips, nodes: sw.nodes, rows: sw.rows, table: vAll(), pol, plan, counters: cntView() });
  }
  /* ---------- 站点偏好表：判定表按通道聚合后的「能打通 / 打不通」两栏 ---------- */
  if (url.searchParams.get("vtq") === "1") return json({ ...verifyInfo() });
  if (url.searchParams.get("hl") === "1") {
    let ring: unknown = [];
    if (url.searchParams.get("do") === "1") {
      try {
        const raw = String(c.env.uuid || c.env.uuids).split(",")[0].trim().toLowerCase();
        const rr = await c.env.METER.get(c.env.METER.idFromName(raw)).fetch("https://meter/hl");
        ring = ((await rr.json()) as { hl?: unknown }).hl || [];
      } catch {
        ring = [];
      }
    }
    return json({ local: HEALTH.json(20), ring });
  }
  if (url.searchParams.get("prefs") === "1") {
    return json({ prefs: prefsJson(60), pol: { same: S.polSame, diff: S.polDiff, why: S.polWhy } });
  }

  if (url.searchParams.get("cl") === "1") {
    const local = clSnapshot(40);
    let ring: ClRec[] = [];
    if (url.searchParams.get("do") === "1" && env.METER) {
      try {
        const r = await env.METER.get(env.METER.idFromName(id)).fetch("https://meter/cl");
        const j = (await r.json()) as { cl?: ClRec[] };
        if (Array.isArray(j.cl)) ring = j.cl;
      } catch {
        ring = [];
      }
    }
    return json({ local, ring, now: Date.now() });
  }

  /* ---------- 站点诊断：这个站该用哪个节点 / 为什么被拦 ---------- */
  const diagHost = String(url.searchParams.get("diag") || "")
    .trim()
    .toLowerCase();
  if (diagHost) {
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
    // （只验"能不能把这个 SNI 转出去"，看不到 HTTP 状态）
    let probe: Array<{ node: string; cc: string } & SniProbe> | null = null;
    if (url.searchParams.get("probe") === "1") {
      probe = await Promise.all(
        alive.slice(0, 8).map(async (a) => {
          // 第 4 个参数是探测超时（ms），不是目标端口；以前把 port 传进去，
          // 默认 443 会把超时压到 443ms，正常的慢站全被判死。
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
    // （Worker 里唯一能“看见 403”的办法；隧道内 TLS 是端到端的，看不到状态行）
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
      if (!v.c.startsWith("r:") || v.state < 2) continue;
      relayBlocked.push({ node: v.c.slice(2) + ":443", state: v.state, src: v.src, left: Math.round((v.at + 1800000 - Date.now()) / 1000) });
    }
    // &do=1：把 DO 里跨 isolate 的那份判定也拉出来看（否则只能看到本 isolate 学到的）
    let ringBlk: Array<{ node: string; left: number }> = [];
    if (url.searchParams.get("do") === "1" && env.METER) {
      try {
        const id = String(env.uuid || env.uuids).split(",")[0].trim().toLowerCase();
        const rr = await env.METER.get(env.METER.idFromName(id)).fetch("https://meter/blk");
        const jj = (await rr.json()) as { blk?: Record<string, number> };
        const now2 = Date.now();
        for (const [bk, exp] of Object.entries(jj.blk || {})) {
          if (exp <= now2 || !bk.startsWith(diagHost + "|")) continue;
          ringBlk.push({ node: bk.slice(diagHost.length + 1), left: Math.round((exp - now2) / 1000) });
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
      note: "Worker 看不到 HTTP 状态码（TLS 端到端），这里靠的是连接结果与对照",
    });
  }

  const pr = url.searchParams.get("probe");
  if (pr) {
    const idx = pr.lastIndexOf(":");
    const ph = idx > 0 ? pr.slice(0, idx) : pr;
    const pp = Number(idx > 0 ? pr.slice(idx + 1) : 443) || 443;
    const bad = checkTarget(ph, pp);
    if (bad) return json({ probe: pr, ok: false, error: bad });
    const r = await probeProxy(ph, pp);
    return json({ probe: pr, ok: !!r, result: r });
  }
  if (url.searchParams.get("refill") === "1") {
    const deny = await adminOnly(c);
    if (deny) return deny;
    // 和 cron 共用同一套抓取/去重/2MB 截断，别再维护第二份
    const refill = await refillPool(env);
    const merged = refill.pool;
    // 默认提交（debug 端点已有 UUID 鉴权）；&dry=1 只看不写，&force=1 无视线池 60% 守卫
    let commit: Record<string, unknown> = { ok: true, skipped: true };
    if (merged.length && url.searchParams.get("dry") !== "1") {
      commit = await commitPool(env, merged, url.searchParams.get("force") === "1");
    }
    return json({
      sources: refill.sources,
      merged: merged.length,
      pool: merged.length,
      committed: !!commit.ok && !commit.skipped,
      gen: commit.gen || 0,
      reason: commit.reason || "",
      kvLastWrite: S.kvStat,
      extra: EXTRA_HOSTS,
    });
  }

  // 手动指定当前节点：?cur=1.2.3.4:443（用于对比不同节点的真实速度）
  if (url.searchParams.get("cur")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const want = String(url.searchParams.get("cur")).trim();
    if (!/^[0-9a-zA-Z.\-]+:\d+$/.test(want)) return json({ ok: false, error: "格式应为 host:port" });
    await pxSet(env, { cur: want });
    const s0 = nsGet(want);
    s0.blackUntil = 0;
    s0.freeUntil = 0;
    s0.streak = 0;
    await flushPx(env, true);
    S.pxFailMem = 0;
    return json({ ok: true, cur: want, curs: S.curs });
  }

  // 手动把 KV 快照续回 DO（写操作，必须管理员）
  if (url.searchParams.get("edge") === "1") {
    const deny = await adminOnly(c);
    if (deny) return deny;
    await edgeLoad(env);
    const probed = await edgeScan(env);
    await edgeFlush(env, true);
    return json({ ok: true, probed, rank: edgeRank(5), nodes: edgeNodes(5) });
  }
  // 明文 HTTP 诊断：?http=x.com&r=185.253.117.147:80（r 省略=直连）。
  // :80 的状态码语义因站而异（x.com 直连回 500、经中继常回中继自己的 404），只诊断、不写判定。
  if (url.searchParams.get("http")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const hh = String(url.searchParams.get("http"));
    const rr = url.searchParams.get("r") || "";
    const pp = url.searchParams.get("p") || "/";
    if (!env.METER) return json({ ok: false, error: "no METER" });
    try {
      // 明文探测很便宜（connect + 读 ≤2KB），直接在请求路径做，不绕 DO（DO 那条会等 20s+ 才被重置）
      const out = await withTimeout(probeHttp80(hh, rr, pp), 6000);
      const chan = rr ? ({ kind: "r", ip: rr.split(":")[0] } as Chan) : DIRECT;
      return json({ ok: true, probe: out, note: "diagnostic only", chan: chanKey(chan), state: vState(hh, chanKey(chan)) });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // 真实 TLS 探测：请求路径只有 10ms CPU，握手交给 DO（DO 也会超限，见 docs/判定验收.md §7）。
  // 用法：?tls=x.com&r=185.253.117.147:443&p=/
  if (url.searchParams.get("tls")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const ph = String(url.searchParams.get("tls"));
    const pr = url.searchParams.get("r") || "";
    const pp = url.searchParams.get("p") || "/";
    if (!env.METER) return json({ ok: false, error: "no METER" });
    try {
      const inst = url.searchParams.get("n") || "";
      const stub = env.METER.get(env.METER.idFromName(inst ? id + "::" + inst : id));
      const q = new URLSearchParams({ h: ph, r: pr, p: pp });
      const resp = await withTimeout(stub.fetch("https://meter/probe?" + q.toString()), 26000);
      const out = (await withTimeout(resp.json(), 3000)) as Record<string, unknown>;
      return json({ ok: true, probe: out });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // 诊断：只发 ClientHello / 只读首个记录，不碰密码学。
  // 用来区分「CPU 上限装不下握手」与「stream 读泵本身太贵」。
  if (url.searchParams.get("raw")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const rh = String(url.searchParams.get("raw"));
    const rr = url.searchParams.get("r") || "";
    const st = url.searchParams.get("stage") || "sh";
    try {
      const out = await withTimeout(probeRaw(rh, rr, st), 6000);
      return json({ ok: true, raw: out });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // 诊断：在**请求路径**里直接跑完整握手（不经 DO），用来看免费额度到底卡在哪
  if (url.searchParams.get("tlsnow")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const th = String(url.searchParams.get("tlsnow"));
    const tr = url.searchParams.get("r") || "";
    const tp = url.searchParams.get("p") || "/";
    try {
      const out = await probeTls(th, tp, tr);
      return json({ ok: true, probe: out });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // 诊断：量 DO 的 CPU 预算（不涉及 TLS）
  if (url.searchParams.get("burn")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    if (!env.METER) return json({ ok: false, error: "no METER" });
    const ms = Number(url.searchParams.get("burn") || 50);
    try {
      // 独立实例名：上一次被 CPU 墙打断的请求可能让该实例的串行队列永久 pending
      const inst = url.searchParams.get("n") || "burn";
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      const resp = await withTimeout(stub.fetch(`https://meter/burn?ms=${ms}`), 15000);
      return json({ ok: true, burn: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // 读 DO 里记录下来的探测阶段
  if (url.searchParams.get("stage")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    try {
      const inst = url.searchParams.get("n") || "";
      if (!inst) return json({ ok: false, error: "need &n=<inst>" });
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      const resp = await withTimeout(stub.fetch("https://meter/stage"), 8000);
      return json({ ok: true, stage: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // DO 里 setTimeout 是否触发 / 根库解析耗时
  if (url.searchParams.get("tim") || url.searchParams.get("dbt")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const inst = url.searchParams.get("n") || "t" + Date.now();
    try {
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      const path = url.searchParams.get("tim") ? `https://meter/tim?ms=${Number(url.searchParams.get("tim"))}` : "https://meter/dbt";
      const resp = await withTimeout(stub.fetch(path), 20000);
      return json({ ok: true, out: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // 固定迭代量的纯 CPU 循环：量 DO 的真实算力预算（不依赖 Date.now）
  if (url.searchParams.get("iter")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const n = Number(url.searchParams.get("iter") || 1000000);
    try {
      const inst = url.searchParams.get("n") || "it" + Date.now();
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      const resp = await withTimeout(stub.fetch(`https://meter/iter?n=${n}`), 20000);
      return json({ ok: true, iter: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // 握手分片骨架：?ch=<host>&gap=<ms> 建连 → 等 gap → 回来读（验证 socket 跨请求存活）
  if (url.searchParams.get("ch")) {
    const denyCh = await adminOnly(c);
    if (denyCh) return denyCh;
    const chHost = String(url.searchParams.get("ch") || "");
    const gap = Math.max(0, Math.min(15000, Number(url.searchParams.get("gap") || 800)));
    const cid = "c" + Date.now().toString(36);
    const stub = c.env.METER.get(c.env.METER.idFromName("chan-probe"));
    const t0 = Date.now();
    const o1 = (await withTimeout(stub.fetch(`https://meter/chopen?id=${cid}&h=${encodeURIComponent(chHost)}&p=443`), 8000)) as Response | undefined;
    const j1 = o1 ? await o1.json() : { ok: false, err: "open-timeout" };
    await new Promise((r) => setTimeout(r, gap));
    const o2 = (await withTimeout(stub.fetch(`https://meter/chread?id=${cid}&w=2000`), 9000)) as Response | undefined;
    const j2 = o2 ? await o2.json() : { ok: false, err: "read-timeout" };
    const o3 = (await withTimeout(stub.fetch(`https://meter/chclose?id=${cid}`), 5000)) as Response | undefined;
    const j3 = o3 ? await o3.json() : { ok: false };
    return Response.json({ gap, ms: Date.now() - t0, open: j1, read: j2, close: j3 });
  }

  // 跨请求 socket 存活实验：?hold=<host> 建连并发 hello，?cont=1 在下一个请求里读
  if (url.searchParams.get("hold")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const hh = String(url.searchParams.get("hold"));
    try {
      const inst = url.searchParams.get("n") || "hold" + Date.now();
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      const q = new URLSearchParams({ h: hh });
      const resp = await withTimeout(stub.fetch("https://meter/hold?" + q.toString()), 15000);
      return json({ ok: true, hold: await resp.json(), inst });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  if (url.searchParams.get("cont")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    try {
      const inst = url.searchParams.get("n") || "";
      if (!inst) return json({ ok: false, error: "need &n=<same inst as hold>" });
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      const resp = await withTimeout(stub.fetch("https://meter/cont"), 20000);
      return json({ ok: true, cont: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // DO 里发 ClientHello（不碰密码学）：验证 DO 是否能对外 connect
  if (url.searchParams.get("draw")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const hh = String(url.searchParams.get("draw"));
    const rr = url.searchParams.get("r") || "";
    try {
      const inst = url.searchParams.get("n") || "raw" + Date.now();
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      const q = new URLSearchParams({ h: hh, r: rr });
      const resp = await withTimeout(stub.fetch("https://meter/raw?" + q.toString()), 15000);
      return json({ ok: true, raw: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // 纯同步忙等：区分「CPU 预算」与「crypto.subtle 不返回」
  if (url.searchParams.get("burnjs")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const ms = Number(url.searchParams.get("burnjs") || 20);
    try {
      const inst = url.searchParams.get("n") || "js" + Date.now();
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      const resp = await withTimeout(stub.fetch(`https://meter/burnjs?ms=${ms}`), 20000);
      return json({ ok: true, burn: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // 逐项量 DO 里的 WebCrypto API
  if (url.searchParams.get("crypto")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    try {
      const inst = url.searchParams.get("n") || "cr" + Date.now();
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      const resp = await withTimeout(stub.fetch("https://meter/crypto"), 25000);
      return json({ ok: true, crypto: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  if (url.searchParams.get("restore") === "1") {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const v = await restoreUsage(env, id);
    return json({ ok: !!v, restored: v || null });
  }

  // 手动回填用量（仅在 DO 累计为 0 时生效，用于重建脚本后恢复历史数字）
  if (url.searchParams.get("seed")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const [u0, d0, c0] = String(url.searchParams.get("seed"))
      .split(",")
      .map((x) => Number(x) || 0);
    let seeded = null;
    try {
      const stub = env.METER.get(env.METER.idFromName(id));
      const r = await stub.fetch("https://meter/seed", {
        method: "POST",
        body: JSON.stringify({ up: u0, down: d0, conns: c0, first: Date.now() }),
      });
      seeded = await r.json();
      S.meterCache.set(id, { v: seeded, t: Date.now() });
    } catch (e) {
      return json({ ok: false, error: String(errMsg(e)) });
    }
    return json({ ok: true, seeded });
  }

  const h = url.searchParams.get("host") || "x.com";
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
    else
      try {
        const s6 = await connect({ hostname: expandV6(out.aaaa), port: 443 });
        out.v6Connect = "ok";
        try {
          s6.close();
        } catch (e) {}
      } catch (e) {
        out.v6Connect = "ERR " + errMsg(e);
      }
  }
  return json(out);
}
