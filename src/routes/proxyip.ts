import { errMsg, shadowRate } from "../core/util";

import { SC } from "../core/const";
import { S } from "../core/state";
import { json } from "../edge/respond";
import { hostRank, logErr } from "../nodes/metrics";
import { costOf, invalidateRank, scoreParts } from "../nodes/score";
import { nodeSnapGet } from "../store/index";
import { cronScan, nsOf, pxGet } from "../px/pool";
import { POOL_SOURCES, SOURCES } from "../px/probe";
import { SEL } from "../px/selector";
import { cnt, cntView } from "../core/counter";
import { CRONLOCK } from "../core/lock";
import { spdSnapshot } from "../core/node-snapshot";
import { regionListAsync } from "../px/regions";
import { primaryId } from "../store/index";
import { adminOnly } from "../edge/auth";

import type { RouteCtx } from "../edge/types";

type UserCtx = RouteCtx & { id: string };

/** /<uuid>/proxyip：中转池现状（?why=1 带选择原因） */
export async function proxyip(c: UserCtx): Promise<Response> {
  const { env, url, host: _host, id } = c;

  // 全局日计数（从 snap 快照读，最多 1 小时延迟）
  if (url.searchParams.get("day") === "1") {
    let g = null;
    let nodesSnap = {};
    // 读不到与「今天还没用量」在面板上是同一个样子（7.233 的 /logs 修过同一形状），
    // 所以这里必须带一个显式的来源标记：none = 没绑定、ok = 读通了、fail = 读失败。
    let doSrc: "ok" | "fail" | "none" = env.METER ? "ok" : "none";
    if (env.METER) {
      try {
        const stub = env.METER.get(env.METER.idFromName(primaryId(env) || id));
        const r = await stub.fetch("https://meter/cnt");
        // 非 2xx 时 json() 可能照样解析出一份错误体（7.214 的 vtFetch 就是这么把 5xx 当成空表的），
        // 所以先按状态码判失败，别让「DO 报错」伪装成「今天零用量」。
        if (!r.ok) throw new Error("meter cnt " + r.status);
        const j = await r.json();
        g = j && j.g;
        nodesSnap = (j && j.s) || {};
      } catch (e) {
        doSrc = "fail";
        cnt("dayDoFail");
        logErr("day count read failed", "kv");
      }
    }
    return json({
      date: (g && g.d) || "",
      cnt: g || {},
      nodes: nodesSnap,
      doSrc,
      local: cntView(),
      localSpd: spdSnapshot(),
      now: Date.now(),
    });
  }
  // 源健康度：每个源的连续失败次数与冷却截止，以及本轮实际抓取顺序
  if (url.searchParams.get("src") === "1") {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const rank = SOURCES.rank(env);
    return json({
      order: rank.map((x, i) => ({ i, src: x })),
      health: SOURCES.snap(),
      total: POOL_SOURCES.length,
      custom: Boolean(env.poolSrc),
      now: Date.now(),
    });
  }
  // 清空 alive，让下一轮扫描重新挑（用于洗掉早期误判进来的节点）
  if (url.searchParams.get("reset") === "1") {
    const deny = await adminOnly(c);
    if (deny) return deny;
    S.alive = new Map();
    S.nstat = new Map();
    S.curs = { lat: "", tput: "" };
    S.prev = { lat: "", tput: "" };
    S.lastSwitch = { lat: 0, tput: 0 };
    S.switchHits = { lat: [], tput: [] };
    S.lastManual = 0;
    S.funnel = { direct: 0, node: 0, v6: 0 };
    // 站点画像/排行缓存也必须一起清：否则 reset 后 pick 还会推荐已经不存在的节点
    S.hostNode.clear();
    S.hostDirect.clear();
    S.hostRankCache.clear();
    invalidateRank();
    S.candN = 0;
    return json({ ok: true, alive: 0, curs: S.curs });
  }

  if (url.searchParams.get("refresh") === "1") {
    const deny = await adminOnly(c);
    if (deny) return deny;
    const sn = Number(url.searchParams.get("scan"));
    S.scanN = Number.isFinite(sn) && sn > 12 ? sn : 12;
    // 与 cron 互斥：两轮 cronScan 并发会双跑探活、双写 seed、poolIdx 相互覆盖
    // 与 cron 共用同一个闸门（claim 带截止时间：卡死的一轮会被接管，手动 refresh 不再是死路）
    if (Date.now() - S.lastManual <= 5000) {
      // 5 秒节流窗口内不动手：也不必占住闸门
    } else if (!CRONLOCK.claim()) {
      return json({ ok: false, error: "cron in progress", heldMs: CRONLOCK.age() });
    } else {
      S.lastManual = Date.now();
      try {
        await cronScan(env).catch((e) => logErr("cron: " + errMsg(e)));
        SEL.afterScan(env);
      } finally {
        CRONLOCK.release();
      }
    }
  }
  const px = await pxGet(env);
  const alive = px.alive || [];
  const stat: Record<string, unknown> = px.state || {};
  const aliveKeys = (alive || []).map((x) => x.h + ":" + x.p);
  const nsMap = nsOf(aliveKeys, aliveKeys.length);
  // 并上 DO 里的跨 isolate 快照：否则换 isolate 看就是一片 kbps=0
  const snapS = await nodeSnapGet(env, id);
  for (const [k, v] of Object.entries(snapS)) {
    if (!v) continue;
    const cur = nsMap[k] || {};
    nsMap[k] = {
      ...cur,
      bps: Math.max(Number(cur.bps) || 0, v.p90 || 0),
      bpsMed: Math.max(Number(cur.bpsMed) || 0, v.med || 0),
      bpsCap: Math.max(Number(cur.bpsCap) || 0, v.cap || 0),
      n: Math.max(Number(cur.n) || 0, v.n || 0),
    };
  }
  const modeQ = url.searchParams.get("mode") === "lat" ? "lat" : "tput";
  const poolSize = Number(stat.poolN) || 0;
  const blacklist = [...S.nstat.entries()].filter(([, s]) => s.blackUntil > Date.now()).map(([k]) => k);
  const rows = (alive || [])
    .map((x) => {
      const k = x.h + ":" + x.p;
      const ns: Record<string, number> = (nsMap as Record<string, Record<string, number>>)[k] || {};
      return {
        node: k,
        ms: x.ms,
        cc: x.cc || "",
        score: Math.round(costOf(k, "lat") * 10) / 10,
        lat: Math.round(costOf(k, "lat")),
        tput: Math.round(costOf(k, "tput")),
        kbps: ns.bps ? Math.round(ns.bps / 1024) : 0,
        kbpsMed: ns.bpsMed ? Math.round(ns.bpsMed / 1024) : 0,
        n: ns.n || 0,
        bytes: ns.bytes || 0,
        pFail: ns.pFail || 0,
        pStall: ns.pStall || 0,
        ok: ns.ok || 0,
        fail: ns.fail || 0,
        black: blacklist.includes(k),
        cur: S.curs.lat === k || S.curs.tput === k,
      };
    })
    .sort((a, b) => (modeQ === "lat" ? a.lat - b.lat : a.tput - b.tput));

  const out: Record<string, unknown> = {
    mode:
      String(env.proxyip || "")
        .trim()
        .toLowerCase() === "auto"
        ? "auto"
        : "manual",
    colo: stat.colo || "??",
    cnt: cntView(),
    current: S.curs.tput || S.curs.lat || "",
    curs: { ...S.curs },
    failCount: S.pxFailMem,
    probeWhy: S.probeWhy,
    probeColo: S.probeColo,
    reProbeN: S.reProbeN,
    funnel: stat.funnel || { direct: 0, node: 0, v6: 0 },
    rotatePolicy: {
      minDwellSec: Math.round(SC.DWELL / 1000),
      budgetPerHour: SC.BUDGET,
      shadow: shadowRate(env),
    },
    alive: rows,
    regions: await regionListAsync(env),
    blacklist,
    pool: {
      size: poolSize,
      gen: Number(stat.gen) || 0,
      poolKey: stat.poolKey || "",
      builtAt: Number(stat.builtAt) || 0,
      memOnly: true,
    },
    stat: stat || {},
  };

  if (url.searchParams.get("why") === "1") {
    // 站点级偏好：哪些站被钉在了哪个节点上（最多 12 条，按样本数排）
    const hp = [...S.hostNode.entries()]
      .map(([h, m]) => {
        let n = 0,
          ok = 0,
          bad = 0,
          ttfb = 0;
        for (const s of m.values()) {
          n += s.n;
          ok += s.ok;
          bad += s.bad;
          if (s.ttfb && (!ttfb || s.ttfb < ttfb)) ttfb = s.ttfb;
        }
        const rank = hostRank(h, modeQ);
        return {
          host: h,
          nodes: m.size,
          n,
          ok,
          bad,
          bestTtfb: ttfb,
          pick: rank.length ? rank[0].k : "",
          pickV: rank.length ? Math.round(rank[0].v) : 0,
        };
      })
      .sort((a, b) => b.n - a.n)
      .slice(0, 12);
    out.hostPref = hp;
    out.explain = rows.slice(0, 8).map((r) => {
      const sp = scoreParts(r.node, modeQ);
      return {
        k: r.node,
        v: Math.round(sp.score),
        chosen: S.curs[modeQ] === r.node,
        // 与排序用的是同一份分项，不再另写一套诊断公式
        parts: {
          latencyMs: Math.round(sp.latencyMs),
          e10Ms: Math.round(sp.e10Ms),
          pFailRisk: Math.round(sp.pFailRisk * 1000) / 1000,
          pStall: Math.round(sp.pStall * 1000) / 1000,
          capBps: Math.round(sp.capBps),
          confB: Math.round(sp.confB * 1000) / 1000,
          nEff: Math.round(sp.nEff * 10) / 10,
          latN: Math.round(sp.latN * 10) / 10,
          sampleAgeMs: sp.sampleAgeMs < 0 ? -1 : Math.round(sp.sampleAgeMs),
          gate: sp.gate,
        },
        n: r.n,
        bytes: r.bytes,
      };
    });
  }

  return json(out);
}

