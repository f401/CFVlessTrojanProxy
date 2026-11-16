import { CONNECT_MS, errMsg, withTimeout } from "../core/util";
import { probeHttp80 } from "../core/http80";
import { connect } from "cloudflare:sockets";
import type { Socket } from "cloudflare:sockets";

import { S } from "../core/state";
import { json } from "../edge/respond";
import { diagVerdict, hostKey } from "../nodes/metrics";
import { nsGet } from "../nodes/score";
import { cfHttpCode } from "../proxy/cfverdict";
import { runTfb } from "../route/tfb";
import { BLK_TTL } from "../route/commitfact";
import { VT_TTL_MS, vAll, vState } from "../route/verdict";
import { vtDelta, vtLoad } from "../route/verdictsync";
import { cntView } from "../core/counter";
import { planView } from "../route/budget";
import { prefsJson } from "../route/prefs";
import { REL_SAMPLE_TTL, relSnap } from "../route/relperf";
import { BLK } from "../route/blkfacts";
import { FACTS } from "../route/factsstore";
import { EG } from "../route/egfacts";
import { psSnap } from "../route/psfacts";
import { DEAD } from "../route/deadfacts";
import { DIRECT, chanKey } from "../route/channel";
import { HEALTH } from "../route/relay-health";
import { checkTarget, dohQuery, expandV6, httpProbe, isCfHost, resolveAAAA, resolveV4All } from "../proxy/dial";
import { aliveList, commitPool, flushPx, pxSet } from "../px/pool";
import { EXTRA_HOSTS, probeProxy, probeSni, refillPool } from "../px/probe";
import { clSnapshot, restoreUsage } from "../store/index";
import { adminOnly } from "../edge/auth";

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
  if (url.searchParams.get("dd")) return json({ rows: DEAD.snap() }); // 判死的会挪到队尾，30 分钟复活
  // 站点 × 中继的成功率事实（本 isolate）：样本越多越可信，因子越靠近 1
  if (url.searchParams.get("pss")) return json({ host: String(url.searchParams.get("pss")), rows: psSnap(String(url.searchParams.get("pss"))) });
  if (url.searchParams.get("eg")) return json({ rows: EG.snap() });
  if (url.searchParams.get("rt")) return json({ host: String(url.searchParams.get("rt") || "").slice(0, 80), rows: relSnap(String(url.searchParams.get("rt") || "").slice(0, 80)), alive: S.alive.size, ttl: REL_SAMPLE_TTL });
  // 站点 × 中继的封锁行（v7.222）：文档里从 v8 起就写着 `?blk=<host>`，代码里一直没有这个分支。
  // 只读内存表，不打 DO：要看别处 isolate 回传的行得配合 `?do=1` 那条链（那里是 /meter/vt）。
  if (url.searchParams.get("blk")) {
    const bh = String(url.searchParams.get("blk") || "").slice(0, 80);
    const rows = BLK.snap().filter((r) => r.k === bh || r.k.startsWith(bh + "|"));
    return json({ host: bh, muted: BLK.muted(bh), rows: rows.slice(0, 60), ttl: BLK_TTL });
  }
  // 事实层五张表一次看全（v7.222）：eg / ps / dead / blk2 / dns，容量与条数都能直接看出来
  if (url.searchParams.get("facts") === "1") return json({ tables: FACTS.snap(), counters: cntView() });
  // 本轮预算分配（v7.222）：与 `?vt=<host>` 分支里的 plan 同一口径，省得为了看预算先造一个 host
  if (url.searchParams.get("plan") === "1") return json({ plan: planView(S.pool.length, S.alive.size), counters: cntView() });
  if (vtHost) {
    // 只读表：userland TLS 探测已在 7.69 删除（免费计划必然 1102），证据一律来自真实流量与 tfb。
    // 这里曾经还回三个恒空字段（ips / nodes / rows）——它们来自已删除的扫描器，
    // 于是「扫描结果为空」和「根本没有扫描」在响应里长得一模一样（v7.154 删掉）。
    const plan = planView(S.pool.length, S.alive.size);
    const pol = { same: S.polSame, diff: S.polDiff, why: S.polWhy };
    return json({ host: vtHost, table: vAll(), pol, plan, counters: cntView() });
  }
  /* ---------- 站点偏好表：判定表按通道聚合后的「能打通 / 打不通」两栏 ---------- */
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

  /* ---------- 出口测速：Worker 自己到源站有多快（?bench=<url>&bytes=4000000） ---------- */
  // 和「客户端 → CF 边缘」那条腿分开量：这里只测 Worker 出口到源站的吞吐。
  // 两个数一比就知道慢在哪一腿（边缘链路 vs 中继/源站），不用猜。只读前 N 字节、20 秒封顶。
  const benchUrl = String(url.searchParams.get("bench") || "").slice(0, 300);
  if (benchUrl) {
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
// （只验"能不能把这个 SNI 转出去"：probeSni 发完 ClientHello 就等 ServerHello，不完成握手，拿不到应用层状态）
    let probe: Array<{ node: string; cc: string } & SniProbe> | null = null;
    if (url.searchParams.get("probe") === "1") {
      probe = await Promise.all(
        alive.slice(0, 6).map(async (a) => {
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
      if (!v.c.startsWith("r:") || v.state < 2) continue;
      relayBlocked.push({ node: v.c.slice(2) + ":443", state: v.state, src: v.src, left: Math.round((v.at + VT_TTL_MS - Date.now()) / 1000) });
    }
    // &do=1：把 DO 里跨 isolate 的那份判定也拉出来看（否则只能看到本 isolate 学到的）
    let ringBlk: Array<{ node: string; n: number; left: number }> = [];
    if (url.searchParams.get("do") === "1" && env.METER) {
      try {
        // 读的是 blk2 事实（host|relay → { n, at }），不是计量表里那张早已没有生产者的旧封锁表：
        // 那张表从 7.124 起就没有写者了，诊断会一直显示「DO 里没有封锁」，把空表当成了「没被封锁」。
        const rr = await env.METER.get(env.METER.idFromName(id)).fetch("https://meter/vt");
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
    const fx = await flushPx(env, true);
    S.pxFailMem = 0;
    // 钉节点要跟着写 KV 锚点，否则别的 isolate 起来会挑回原来那条（返回 ok 但没落盘就是谎报）
    return json({ ok: true, cur: want, curs: S.curs, anchor: fx.ok ? "ok" : "fail", note: fx.ok ? undefined : fx.err });
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
      return json({ ok: resp.ok, doStatus: resp.status, burn: await resp.json() });
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
      return json({ ok: resp.ok, doStatus: resp.status, stage: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // DO 里 setTimeout 是否触发（根库解析那个 /meter/dbt 端点已随 subtls 一起删除）
  if (url.searchParams.get("tim")) {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const inst = url.searchParams.get("n") || "t" + Date.now();
    try {
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      const resp = await withTimeout(stub.fetch(`https://meter/tim?ms=${Number(url.searchParams.get("tim"))}`), 20000);
      return json({ ok: resp.ok, doStatus: resp.status, out: await resp.json() });
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
      return json({ ok: resp.ok, doStatus: resp.status, iter: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
  // IP 级封锁探测（见 route/tfb.ts）
  if (url.searchParams.get("tfb")) {
    const denyB = await adminOnly(c);
    if (denyB) return denyB;
    return runTfb(c, String(url.searchParams.get("tfb") || ""), Number(url.searchParams.get("n") || 2), String(url.searchParams.get("r") || ""));
  }

  if (url.searchParams.get("tf")) {
    const denyTf = await adminOnly(c);
    if (denyTf) return denyTf;
    const tfHost = String(url.searchParams.get("tf") || "");
    const tfRelay = String(url.searchParams.get("r") || "");
    const stub = c.env.METER.get(c.env.METER.idFromName("tf-probe"));
    const r = (await withTimeout(
      stub.fetch(`https://meter/tf?h=${encodeURIComponent(tfHost)}&r=${encodeURIComponent(tfRelay)}`),
      20000,
    )) as Response | undefined;
    const body = r ? await withTimeout(r.json(), 5000) : { ok: false, err: "tf-timeout" };
    return Response.json({ host: tfHost, relay: tfRelay, do: body });
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
      return json({ ok: resp.ok, doStatus: resp.status, burn: await resp.json() });
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
      return json({ ok: resp.ok, doStatus: resp.status, crypto: await resp.json() });
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
    let seedOk = false;
    let seedStatus = 0;
    try {
      const stub = env.METER.get(env.METER.idFromName(id));
      const r = await stub.fetch("https://meter/seed", {
        method: "POST",
        body: JSON.stringify({ up: u0, down: d0, conns: c0, first: Date.now() }),
      });
      seedOk = r.ok;
      seedStatus = r.status;
      seeded = await r.json();
      S.meterCache.set(id, { v: seeded, t: Date.now() });
    } catch (e) {
      return json({ ok: false, error: String(errMsg(e)) });
    }
    return json({ ok: seedOk, doStatus: seedStatus, seeded });
  }

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
      let pk: Promise<Socket> | null = null;
      try {
        // `connect()` 返回的是 Socket（连接在 `.opened` 上），包成 Promise 才能 race
        pk = Promise.resolve(connect({ hostname: expandV6(out.aaaa), port: 443 }));
        const s6 = await withTimeout(pk, CONNECT_MS);
        out.v6Connect = "ok";
        try {
          s6.close();
        } catch (e) {}
      } catch (e) {
        // 超时只是「先返回」，socket 可能随后才连上：到手就关，否则它长期占一个名额
        const late = pk;
        if (late) void late.then((s) => { try { s.close(); } catch { /* 已经关了 */ } }).catch(() => { /* 本来就没连上 */ });
        out.v6Connect = "ERR " + errMsg(e);
      }
    }
  }
  return json(out);
}
