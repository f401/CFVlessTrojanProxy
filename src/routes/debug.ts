import { errMsg, shadowRate } from "../core/util";
import { connect } from "cloudflare:sockets";

import { SC } from "../core/const";
import { S } from "../core/state";
import { dial } from "../proxy/dial";

import { json, text } from "../edge/respond";
import { diagVerdict, hostKey, hostRank, logErr } from "../nodes/metrics";
import { ZERO_STAT, capOf, costOf, scoreParts, nsGet, p90Of, pFailOf, pStallOf, pctOf } from "../nodes/score";
import { nodeSnapGet } from "../store/index";
import { checkTarget, dohQuery, expandV6, resolveAAAA } from "../proxy/dial";
import { aliveList, commitPool, cronScan, flushPx, nsOf, pxGet, pxSet } from "../px/pool";
import { cnt, cntView } from "../core/counter";
import { spdSnapshot } from "../core/node-snapshot";
import { EXTRA_HOSTS, probeProxy, probeSni, refillPool, regionListAsync } from "../px/probe";
import { restoreUsage, primaryId } from "../store/index";
import { adminOnly } from "../edge/auth";

import type { RouteCtx } from "../edge/types";

type UserCtx = RouteCtx & { id: string };

/** /<uuid>/debug：站点诊断（?diag=<host>&probe=1 做一次 SNI 探测） */
export async function debug(c: UserCtx): Promise<Response> {
  const { env, url, host, id, first, ctx } = c;

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
