/**
 * route 层的读模型：把「写在哪里」与「怎么摊给前端」分开。
 *
 * 两块内容各对应一个路由文件：
 * - 地区面板（`routes/region-panel.ts`）：池子 + 存活表 + 质量/覆盖/连接观测 + 六张事实表 → 展示行；
 * - 调试端点（`routes/debug.ts`）：判定表、事实表、健康度、连接记录 → 可直接序列化的对象。
 *
 * 放在 route 层而不是 routes 层是为了解耦：路由只负责 HTTP 形状（分页、JSON、表单、鉴权），
 * 装配口径（谁进表、哪几列、缓存多久）只在这里；新增一张事实表时改这一个文件即可。
 * 缓存与读模型同生共死——它缓存的正是在这里算出来的行，放回 routes 会造成 route → routes 反向依赖。
 */

import { cntView } from "../core/counter";
import { IpFamily, IpKind } from "../core/enums";
import { NODE_MEMORY } from "../core/node-memory";
import { relayIpOf, splitRelay } from "../core/relay-addr";
import { ISOLATE } from "../core/state";
import { BLK } from "../facts/blkfacts";
import { BLK_TTL } from "../facts/commitfact";
import { DEAD } from "../facts/deadfacts";
import { DNS } from "../facts/dnsfacts";
import { EG } from "../facts/egfacts";
import { FactsStore } from "../facts/factsstore";
import { Prefs } from "../facts/prefs";
import { PS } from "../facts/psfacts";
import { HEALTH } from "../facts/relay-health";
import { REL_SAMPLE_TTL, RELPERF } from "../facts/relperf";
import { VT } from "../facts/verdict";
import { AliveBoard } from "../px/pool";
import { POOL_MEMORY } from "../px/pool-memory";
import { QUALITY, COVERAGE, CONN_OBS } from "../px/regions";
import { SEED_STORE } from "../px/seed";
import { doFetch, PEND } from "../store/index";
import type { RegionNodeRow } from "../views/regions";
import { planView } from "./budget";
import { POLICY } from "./policy";

/** 一个可直接 `json()` 的响应体（route 层不认识 edge 的响应封装） */
type Payload = Record<string, unknown>;
/** 地区页面单槽类型化缓存；行与 JSON 分开，均允许 30 秒展示陈旧。 */
export class RegionPageCache {
  /** 节点行缓存（30 秒）：站点相关列在渲染前才补算 */
  rows: { t: number; rows: RegionNodeRow[] } | null = null;
  /** JSON 文本缓存（5 秒）：同一份结果不重复序列化 */
  json: { t: number; key: string; text: string } | null = null;
  /** 功能：在寿命内返回基础行，站点投影由调用方复制。@param now 当前时间。@returns 行或 null */
  freshRows(now: number): RegionNodeRow[] | null {
    return this.rows && now - this.rows.t < 30000 ? this.rows.rows : null;
  }
  /** 功能：按目标与条数命中序列化缓存。@param key 请求键。@param now 当前时间。@returns JSON 或 null */
  freshJson(key: string, now: number): string | null {
    return this.json && this.json.key === key && now - this.json.t < 30000 ? this.json.text : null;
  }
}
/** 地区展示缓存所有者，不保存用户上下文或口令。 */
export const REGION_CACHE = new RegionPageCache();

/**
 * 功能：把 host 归到地址族（字面量 IPv6 带冒号，其余按 v4）。
 * @param h 主机（IP 字面量或域名）
 * @returns 地址族枚举
 */
export function familyOf(h: string): IpFamily {
  return h.includes(":") ? IpFamily.IPv6 : IpFamily.IPv4;
}

/**
 * 功能：把 seed 的 byColo 分桶摊平成 `key → 国家码` 的映射（跨 isolate 的已知节点）。
 * @returns key 到 cc 的表
 */
function seedNodes(): Map<string, string> {
  const out = new Map<string, string>();
  const byColo = (SEED_STORE.document && SEED_STORE.document.byColo) || {};
  for (const [cc, bucket] of Object.entries(byColo)) {
    for (const n of bucket?.nodes || []) {
      const k = n.k || `${n.h}:${n.p}`;
      if (!out.has(k)) out.set(k, String(n.cc || cc).toUpperCase());
    }
  }
  return out;
}

/**
 * 功能：拼出全部节点行（alive ∪ seed），按「质量等级 → 国家码 → key」稳定排序。
 * @param target 目标站点（空 = 不算 RTT）
 * @returns 展示行数组
 */
export function buildPanelRows(): RegionNodeRow[] {
  // 重建 1600 行 + ICU 排序逼近 10ms CPU（TTL 到期即 1102）；缓存 30 秒、命中只看寿命，后台 probe 改 alive 不重建动失效）。
  const now = Date.now();
  let rows = REGION_CACHE.freshRows(now);
  if (!rows) {
    const alive = new AliveBoard().list();
    const seeds = seedNodes();
    const keys = [...new Set([...alive.map((n) => `${n.h}:${n.p}`), ...seeds.keys(), ...POOL_MEMORY.rows.map((x) => `${x.h}:${x.p}`)])];
    // alive 上限 800，逐 key find() 是 64 万次拼接；Map 压成 O(n)。
    const liveByKey = new Map<string, (typeof alive)[number]>(alive.map((n) => [`${n.h}:${n.p}`, n]));
    rows = keys.map((key) => {
      const [h, p] = splitRelay(key, 443), ip = h, seedCc = seeds.get(key) || "", live = liveByKey.get(key);
      const q = QUALITY.getFor(h, p, now), cov = COVERAGE.rows.get(key), isoCc = QUALITY.getIso(h);
      return {
        key,
        country: String(isoCc || live?.cc || seedCc || "").toUpperCase(),
        family: familyOf(h),
        alive: !!live,
        source: live && seedCc ? "alive+seed" : live ? "alive" : "seed",
        kind: q?.kind ?? IpKind.Unknown,
        level: q?.level ?? "normal",
        proxy: q?.proxy ?? false,
        vpn: q?.vpn ?? false,
        org: q?.org || "",
        reach: 0,
        probed: !!cov || !!q,
        rtt: null,
        egFamily: EG.famOf(ip, now),
        psOk: -1,
        dead: DEAD.isDead(ip, now),
        blkPenalty: 1,
        dnsV6: -1,
      } as RegionNodeRow;
    });
    // 已探测在前，再按质量等级 → 国家 → key 排序。
    const rank: Record<string, number> = { good: 0, normal: 1, risky: 2 };
    rows.sort(
      (a, b) =>
        Number(b.probed) - Number(a.probed) ||
        Number(b.alive) - Number(a.alive) ||
        (rank[a.level] ?? 3) - (rank[b.level] ?? 3) ||
        (a.country < b.country ? -1 : a.country > b.country ? 1 : 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    REGION_CACHE.rows = { t: now, rows };
  }
  return rows;
}

/** 功能：给要渲染的那几行补上站点相关列；@param rows 切片后的行；@param target 站点；@returns 同一批行 */
export function decoratePanelRows(rows: RegionNodeRow[], target: string): RegionNodeRow[] {
  // 只补切片：整表 1600 行 × 5 次查表就是 1102 的来源之一
  const now = Date.now();
  const coloNow = ISOLATE.colo || "??";
  const v6 = target ? DNS.v6Of(target, now) : -1;
  // 基础行由缓存共享；派生站点字段写入新对象，避免本次展示污染下一次请求。
  return rows.map((r) => {
    const ip = relayIpOf(r.key);
    const reachRow = CONN_OBS.get(coloNow, r.key, "@reach", now);
    return { ...r, reach: reachRow ? (reachRow.ok ? 1 : -1) : 0,
      rtt: target ? CONN_OBS.rttOf(coloNow, r.key, target, now) : null,
      psOk: target ? PS.okOf(target, ip, now) : -1,
      blkPenalty: target ? BLK.penOf(target, ip, now) : 1, dnsV6: v6 };
  });
}

/**
 * 只读诊断表：把内存里的判定、事实、健康度直接摊开。
 *
 * 为什么单独成类：这十一个分支全是「读一张表、包成对象」，不写任何状态，
 * 唯一的例外是 &do=1 时把 DO 环形缓冲也取回来（doFetch 会记一次子请求计数）。
 * 和测量类（要拨号）、写操作类（要管理员校验并改 KV）混在一个函数里时，
 * 「这次请求到底会不会改变服务端状态」看不出来。
 */
export class DebugTables {
  /**
   * 依次尝试十一个只读分支。
   * @param c 路由上下文（含 `env` / `id`）
   * @param url 请求 URL
   * @returns 命中的分支响应；没有任何只读参数时返回 `null`，交给后面的测量/写操作分支
   */
  async read(env: Env, id: string, url: URL): Promise<Payload | null> {
    const q = url.searchParams;
    // 前八个分支只读内存表：短路顺序就是响应顺序，与原实现逐行一致
    const hit =
      this.deadRows(q) ??
      this.siteFacts(q) ??
      this.egRows(q) ??
      this.relayRows(q) ??
      this.blockRows(q) ??
      this.factsAll(q) ??
      this.planRows(q) ??
      this.verdictRows(q);
    if (hit) return hit;
    // 下面三个分支里有两个可能打 DO：`&do=1` 才多一次子请求，所以排在纯读分支之后
    const heal = await this.healthRows(env, q);
    if (heal) return heal;
    const prefs = this.prefsRows(q);
    if (prefs) return prefs;
    return this.connRows(env, id, q);
  }

  /**
   * 功能：`?dd=1` —— 被判死的节点（30 分钟后自动复活）。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private deadRows(q: URLSearchParams): Payload | null {
    // 判死的会挪到队尾，30 分钟复活
    if (!q.get("dd")) return null;
    return { rows: DEAD.snap() };
  }

  /**
   * 功能：`?pss=<host>` —— 站点 × 中继的成功率事实（本 isolate）。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private siteFacts(q: URLSearchParams): Payload | null {
    const raw = q.get("pss");
    if (!raw) return null;
    const host = String(raw).slice(0, 80);
    return { host, rows: PS.snap(host) };
  }

  /**
   * 功能：`?eg=1` —— 出口地址族事实表。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private egRows(q: URLSearchParams): Payload | null {
    if (!q.get("eg")) return null;
    return { rows: EG.snap() };
  }

  /**
   * 功能：`?rt=<host>` —— 站点 × 中继的实测样本（含存活表规模与 TTL）。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private relayRows(q: URLSearchParams): Payload | null {
    if (!q.get("rt")) return null;
    // 站点名是客户端可控的，截断到 80 字符再进表，避免拿它当无界键
    const host = String(q.get("rt") || "").slice(0, 80);
    return { host, rows: RELPERF.snap(host), alive: NODE_MEMORY.alive.size, ttl: REL_SAMPLE_TTL };
  }

  /**
   * 功能：`?blk=<host>` —— 站点 × 中继的封锁行（只读内存表）。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private blockRows(q: URLSearchParams): Payload | null {
    if (!q.get("blk")) return null;
    // 文档里从 v8 起就写着 `?blk=<host>`；只读内存表，要看别处 isolate 回传的行得配 `?do=1`
    const host = String(q.get("blk") || "").slice(0, 80);
    const rows = BLK.snap().filter((r) => r.k === host || r.k.startsWith(host + "|"));
    return { host, muted: BLK.muted(host), rows: rows.slice(0, 60), ttl: BLK_TTL };
  }

  /**
   * 功能：`?facts=1` —— 事实层五张表的容量与条数一次看全。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private factsAll(q: URLSearchParams): Payload | null {
    if (q.get("facts") !== "1") return null;
    return { tables: FactsStore.snap(), counters: cntView() };
  }

  /**
   * 功能：`?plan=1` —— 本轮预算分配（与 `?vt=<host>` 分支同一口径）。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private planRows(q: URLSearchParams): Payload | null {
    if (q.get("plan") !== "1") return null;
    return { plan: planView(POOL_MEMORY.rows.length, NODE_MEMORY.alive.size), counters: cntView() };
  }

  /**
   * 功能：`?vt=<host>` —— 判定表全文 + 策略命中原因 + 预算。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private verdictRows(q: URLSearchParams): Payload | null {
    const host = String(q.get("vt") || "").slice(0, 80);
    if (!host) return null;
    // 这里曾经还回三个恒空字段（ips / nodes / rows），它们来自已删除的扫描器，
    // 于是「扫描结果为空」和「根本没有扫描」在响应里长得一模一样（v7.154 删掉）
    const plan = planView(POOL_MEMORY.rows.length, NODE_MEMORY.alive.size);
    const pol = { same: POLICY.same, diff: POLICY.different, why: POLICY.reasons };
    return { host, table: VT.all(), pol, plan, counters: cntView() };
  }

  /**
   * 功能：`?hl=1` —— 拼路健康度（本地表 + 可选 DO 环形缓冲）。
   * @param c 路由上下文（要 `env`）
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private async healthRows(env: Env, q: URLSearchParams): Promise<Payload | null> {
    if (q.get("hl") !== "1") return null;
    // 环形缓冲要跨 isolate 才有意义，所以只有显式 `&do=1` 才多花一次子请求
    let ring: unknown = [];
    if (q.get("do") === "1") {
      try {
        const raw = String(env.uuid || env.uuids).split(",")[0].trim().toLowerCase();
        const rr = await doFetch(env, raw, "https://meter/hl");
        ring = ((await rr.json()) as { hl?: unknown }).hl || [];
      } catch {
        // 读不到就是空环：不把这一维的失败当整轮失败（与 /logs 同口径）
        ring = [];
      }
    }
    return { local: HEALTH.json(20), sizes: HEALTH.counts(), ring };
  }

  /**
   * 功能：`?prefs=1` —— 站点偏好表与策略命中原因。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private prefsRows(q: URLSearchParams): Payload | null {
    if (q.get("prefs") !== "1") return null;
    return { prefs: Prefs.json(60), pol: { same: POLICY.same, diff: POLICY.different, why: POLICY.reasons } };
  }

  /**
   * 功能：`?cl=1` —— 连接观测（本地快照 + 可选 DO 环形缓冲）。
   * @param c 路由上下文（要 `env` 与 `id`）
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private async connRows(env: Env, id: string, q: URLSearchParams): Promise<Payload | null> {
    if (q.get("cl") !== "1") return null;
    const local = PEND.clSnap(40);
    let ring: ClRec[] = [];
    if (q.get("do") === "1" && env.METER) {
      try {
        const r = await doFetch(env, id, "https://meter/cl");
        const j = (await r.json()) as { cl?: ClRec[] };
        if (Array.isArray(j.cl)) ring = j.cl;
      } catch {
        // 同上：DO 读失败只让这一维为空，本地快照照旧返回
        ring = [];
      }
    }
    return { local, ring, now: Date.now() };
  }
}
