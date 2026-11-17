import { errMsg, shadowRate } from "../core/util";

import { SC } from "../core/const";
import { S } from "../core/state";
import { json } from "../edge/respond";
import { HOSTS, logErr } from "../nodes/metrics";
import { costOf, scoreParts, STATS } from "../nodes/score";
import { nodeSnapGet } from "../store/index";
import { cronScan, nsOf, pxGet } from "../px/pool";
import { POOL_SOURCES, SOURCES } from "../px/probe";
import { SEL } from "../px/selector";
import { cnt, cntView } from "../core/counter";
import { CRONLOCK } from "../core/lock";
import { spdSnapshot } from "../core/obs";
import { regionListAsync } from "../px/regions";
import { PEND } from "../store/index";
import { adminOnly } from "../edge/auth";

import type { RouteCtx } from "../edge/types";

type UserCtx = RouteCtx & { id: string };

/**
 * 功能：/<uuid>/proxyip 的视图对象 —— 两个只读报表（用量、源健康）、两个管理员动作（清空、刷新）
 *   与默认的池子快照各占一个方法。
 * 为什么是一个类而不是一个 227 行的函数：这五个分支的前置条件完全不同（前两个只读、
 *   后两个要管理员并会改内存、最后一个要等 `pxGet` 与 DO 快照），挤在一个函数体里时
 *   「哪一行会拨号 / 会清表」只能靠通读全文才知道。
 */
export class ProxyipView {
  /** 路由上下文（`env`/`url`/`id` 都从它取） */
  private readonly c: UserCtx;
  /** 绑定与配置 */
  private readonly env: RouteCtx["env"];
  /** 本次请求的查询串 */
  private readonly url: URL;
  /** 用户 id（用于取该用户的用量快照与 PEND 账本名） */
  private readonly id: string;

  /**
   * 功能：保存一次请求的上下文（成员全只读，实例只服务一次请求）。
   * @param {UserCtx} c 路由上下文
   */
  constructor(c: UserCtx) {
    this.c = c;
    this.env = c.env;
    this.url = c.url;
    this.id = c.id;
  }

  /**
   * 功能：按查询参数分派到具体分支；都不匹配时给出池子快照。
   * @returns {Promise<Response>} JSON 响应
   */
  async run(): Promise<Response> {
    // 顺序与原来的 if 链一致：只读的两个在前，管理员动作在后，最后是默认视图
    if (this.url.searchParams.get("day") === "1") return this.dayReport();
    if (this.url.searchParams.get("src") === "1") return this.sourceReport();
    if (this.url.searchParams.get("reset") === "1") return this.resetPool();
    if (this.url.searchParams.get("refresh") === "1") {
      const deny = await this.refreshPool();
      if (deny) return deny;
    }
    return this.poolReport();
  }

  /**
   * 功能：?day=1 —— 全局日计数（从 DO 的 snap 快照读，最多 1 小时延迟）。
   * @returns {Promise<Response>} 日计数与本地计数
   */
  private async dayReport(): Promise<Response> {
    let g = null;
    let nodesSnap = {};
    // 读不到与「今天还没用量」在面板上是同一个样子（7.233 的 /logs 修过同一形状），
    // 所以这里必须带一个显式的来源标记：none = 没绑定、ok = 读通了、fail = 读失败。
    let doSrc: "ok" | "fail" | "none" = this.env.METER ? "ok" : "none";
    if (this.env.METER) {
      try {
        const stub = this.env.METER.get(this.env.METER.idFromName(PEND.id(this.env) || this.id));
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

  /**
   * 功能：?src=1 —— 源健康度（每个源的连续失败次数、冷却截止与本轮实际抓取顺序）。
   * @returns {Promise<Response>} 源顺序与健康快照
   */
  private async sourceReport(): Promise<Response> {
    const deny = await adminOnly(this.c);
    if (deny) return deny;
    // 取一次绑定别名：下面的报表里 `env` 出现三次以上，比 `this.env` 更好读
    const env = this.env;
    const rank = SOURCES.rank(env);
    return json({
      order: rank.map((x, i) => ({ i, src: x })),
      health: SOURCES.snap(),
      total: POOL_SOURCES.length,
      custom: Boolean(this.env.poolSrc),
      now: Date.now(),
    });
  }

  /**
   * 功能：?reset=1 —— 清空 alive 与站点画像，让下一轮扫描重新挑（用于洗掉早期误判进来的节点）。
   * @returns {Promise<Response>} 清空后的游标
   */
  private async resetPool(): Promise<Response> {
    const deny = await adminOnly(this.c);
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
    STATS.invalidateRank();
    S.candN = 0;
    return json({ ok: true, alive: 0, curs: S.curs });
  }

  /**
   * 功能：?refresh=1 —— 立刻跑一轮 cronScan（与 cron 互斥、5 秒节流）。
   * @returns {Promise<Response | null>} 被 cron 占用时返回拒绝响应，否则 null 表示继续走默认视图
   */
  private async refreshPool(): Promise<Response | null> {
    const deny = await adminOnly(this.c);
    if (deny) return deny;
    const sn = Number(this.url.searchParams.get("scan"));
    S.scanN = Number.isFinite(sn) && sn > 12 ? sn : 12;
    // 与 cron 互斥：两轮 cronScan 并发会双跑探活、双写 seed、poolIdx 相互覆盖
    // 与 cron 共用同一个闸门（claim 带截止时间：卡死的一轮会被接管，手动 refresh 不再是死路）
    if (Date.now() - S.lastManual <= 5000) {
      // 5 秒节流窗口内不动手：也不必占住闸门
      return null;
    }
    if (!CRONLOCK.claim()) {
      return json({ ok: false, error: "cron in progress", heldMs: CRONLOCK.age() });
    }
    S.lastManual = Date.now();
    try {
      await cronScan(this.env).catch((e) => logErr("cron: " + errMsg(e)));
      SEL.afterScan(this.env);
    } finally {
      CRONLOCK.release();
    }
    return null;
  }

  /**
   * 功能：把内存存活表与 DO 里的跨 isolate 快照并成每一行的视图，并按当前模式排序。
   * @param {Awaited<ReturnType<typeof pxGet>>} px `pxGet` 的返回值（存活表与池子状态）
   * @returns {{ rows: Array<{ node: string; n: number; bytes: number }>; modeQ: "lat" | "tput"; blacklist: string[] }} 排好序的行、模式与当时处在冷却期的键
   */
  private async liveRows(
    px: Awaited<ReturnType<typeof pxGet>>,
  ): Promise<{
    rows: Array<{ node: string; n: number; bytes: number }>;
    modeQ: "lat" | "tput";
    blacklist: string[];
  }> {
    const env = this.env;
    const alive = px.alive || [];
    const aliveKeys = alive.map((x) => x.h + ":" + x.p);
    const nsMap = nsOf(aliveKeys, aliveKeys.length);
    // 并上 DO 里的跨 isolate 快照：否则换一个 isolate 看就是一片 kbps=0
    const snapS = await nodeSnapGet(env, this.id);
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
    const modeQ: "lat" | "tput" = this.url.searchParams.get("mode") === "lat" ? "lat" : "tput";
    const blacklist = [...S.nstat.entries()].filter(([, s]) => s.blackUntil > Date.now()).map(([k]) => k);
    const rows = alive
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
        };
      })
      .sort((a, b) => (modeQ === "lat" ? a.lat - b.lat : a.tput - b.tput))
      .map((r) => ({ ...r, cur: S.curs.lat === r.node || S.curs.tput === r.node }));
    return { rows, modeQ, blacklist };
  }

  /**
   * 功能：?why=1 的解释块 —— 站点级偏好（最多 12 条）与前 8 行的分项。
   *   只在诊断时算：每个站点要做一次画像排序，每条行要重算一次 `scoreParts`。
   * @param {"lat" | "tput"} modeQ 查询模式
   * @param {Array<{ node: string; n: number; bytes: number }>} rows 已排好序的行
   * @returns {Record<string, unknown>} 可直接并进响应的两个字段
   */
  private explain(
    modeQ: "lat" | "tput",
    rows: Array<{ node: string; n: number; bytes: number }>,
  ): Record<string, unknown> {
    // 站点级偏好：哪些站被钉在了哪个节点上（最多 12 条，按样本数排）
    const hostPref = [...S.hostNode.entries()]
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
        const rank = HOSTS.rank(h, modeQ);
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
    const explain = rows.slice(0, 8).map((r) => {
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
    return { hostPref, explain };
  }

  /**
   * 功能：默认视图 —— 中转池现状（每条的代价、吞吐、失败率与是否在冷却），`?why=1` 附带选择原因。
   * @returns {Promise<Response>} 池子快照
   */
  private async poolReport(): Promise<Response> {
    const env = this.env;
    const px = await pxGet(env);
    const stat: Record<string, unknown> = px.state || {};
    const { rows, modeQ, blacklist } = await this.liveRows(px);
    const out: Record<string, unknown> = {
      mode: "manual",
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
        size: Number(stat.poolN) || 0,
        gen: Number(stat.gen) || 0,
        poolKey: stat.poolKey || "",
        builtAt: Number(stat.builtAt) || 0,
        memOnly: true,
      },
      stat: stat || {},
    };
    // 手动/自动的判据只影响面板上的一个标签，放在组装之后算，别打断上面那段纯字段拼接
    if (
      String(env.proxyip || "")
        .trim()
        .toLowerCase() === "auto"
    ) {
      out.mode = "auto";
    }
    if (this.url.searchParams.get("why") === "1") Object.assign(out, this.explain(modeQ, rows));
    return json(out);
  }
}

/**
 * 功能：/<uuid>/proxyip 的入口（视图对象只服务一次请求，创建与执行在这里）。
 * @param {UserCtx} c 路由上下文
 * @returns {Promise<Response>} JSON 响应
 */
export async function proxyip(c: UserCtx): Promise<Response> {
  return new ProxyipView(c).run();
}
