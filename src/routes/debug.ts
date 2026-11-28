import { METER_CLIENT } from "../store/meter-client";
import { SELECTION_MEMORY } from "../px/selection-memory";
import { KV_WRITES } from "../store/kv";
import { POLICY } from "../route/policy";
import { POOL_MEMORY } from "../px/pool-memory";
import { NODE_MEMORY } from "../core/node-memory";
import { vtAck, vtDelta, vtLoad, vtNack } from "../route/verdictsync";
import { doFetch, PEND, restoreUsage } from "../store/index";
import { DebugNets } from "./debug-nets";
import type { RouteCtx } from "../edge/types";
import { cntView } from "../core/counter";
import { json } from "../edge/respond";
import { BLK } from "../route/blkfacts";
import { planView } from "../route/budget";
import { BLK_TTL } from "../route/commitfact";
import { DEAD } from "../route/deadfacts";
import { EG } from "../route/egfacts";
import { FactsStore } from "../route/factsstore";
import { Prefs } from "../route/prefs";
import { PS } from "../route/psfacts";
import { HEALTH } from "../route/relay-health";
import { REL_SAMPLE_TTL, RELPERF } from "../route/relperf";
import { VT, VT_SYNC } from "../route/verdict";
import { errMsg, withTimeout } from "../core/util";
import { adminOnly } from "../edge/auth";
import { NodeStatsTable } from "../nodes/score";
import { commitPool, flushPx, pxSet } from "../px/pool";
import { EXTRA_HOSTS, refillPool } from "../px/probe";

// ---- 并入自 debug-tables.ts ----

/** 诊断路由的上下文：`/<uuid>/debug` 挂在用户前缀下，所以一定带着 `id` */
type DebugCtx = RouteCtx & { id: string };

/**
 * 只读诊断表：把内存里的判定、事实、健康度直接摊开。
 *
 * 为什么单独成类：这十一个分支全是「读一张表、包成 JSON」，不写任何状态，
 * 唯一的例外是 `&do=1` 时把 DO 环形缓冲也取回来（`doFetch` 会记一次子请求计数）。
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
  async read(c: DebugCtx, url: URL): Promise<Response | null> {
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
    const heal = await this.healthRows(c, q);
    if (heal) return heal;
    const prefs = this.prefsRows(q);
    if (prefs) return prefs;
    return this.connRows(c, q);
  }

  /**
   * 功能：`?dd=1` —— 被判死的节点（30 分钟后自动复活）。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private deadRows(q: URLSearchParams): Response | null {
    // 判死的会挪到队尾，30 分钟复活
    if (!q.get("dd")) return null;
    return json({ rows: DEAD.snap() });
  }

  /**
   * 功能：`?pss=<host>` —— 站点 × 中继的成功率事实（本 isolate）。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private siteFacts(q: URLSearchParams): Response | null {
    const raw = q.get("pss");
    if (!raw) return null;
    const host = String(raw).slice(0, 80);
    return json({ host, rows: PS.snap(host) });
  }

  /**
   * 功能：`?eg=1` —— 出口地址族事实表。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private egRows(q: URLSearchParams): Response | null {
    if (!q.get("eg")) return null;
    return json({ rows: EG.snap() });
  }

  /**
   * 功能：`?rt=<host>` —— 站点 × 中继的实测样本（含存活表规模与 TTL）。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private relayRows(q: URLSearchParams): Response | null {
    if (!q.get("rt")) return null;
    // 站点名是客户端可控的，截断到 80 字符再进表，避免拿它当无界键
    const host = String(q.get("rt") || "").slice(0, 80);
    return json({ host, rows: RELPERF.snap(host), alive: NODE_MEMORY.alive.size, ttl: REL_SAMPLE_TTL });
  }

  /**
   * 功能：`?blk=<host>` —— 站点 × 中继的封锁行（只读内存表）。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private blockRows(q: URLSearchParams): Response | null {
    if (!q.get("blk")) return null;
    // 文档里从 v8 起就写着 `?blk=<host>`；只读内存表，要看别处 isolate 回传的行得配 `?do=1`
    const host = String(q.get("blk") || "").slice(0, 80);
    const rows = BLK.snap().filter((r) => r.k === host || r.k.startsWith(host + "|"));
    return json({ host, muted: BLK.muted(host), rows: rows.slice(0, 60), ttl: BLK_TTL });
  }

  /**
   * 功能：`?facts=1` —— 事实层五张表的容量与条数一次看全。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private factsAll(q: URLSearchParams): Response | null {
    if (q.get("facts") !== "1") return null;
    return json({ tables: FactsStore.snap(), counters: cntView() });
  }

  /**
   * 功能：`?plan=1` —— 本轮预算分配（与 `?vt=<host>` 分支同一口径）。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private planRows(q: URLSearchParams): Response | null {
    if (q.get("plan") !== "1") return null;
    return json({ plan: planView(POOL_MEMORY.rows.length, NODE_MEMORY.alive.size), counters: cntView() });
  }

  /**
   * 功能：`?vt=<host>` —— 判定表全文 + 策略命中原因 + 预算。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private verdictRows(q: URLSearchParams): Response | null {
    const host = String(q.get("vt") || "").slice(0, 80);
    if (!host) return null;
    // 这里曾经还回三个恒空字段（ips / nodes / rows），它们来自已删除的扫描器，
    // 于是「扫描结果为空」和「根本没有扫描」在响应里长得一模一样（v7.154 删掉）
    const plan = planView(POOL_MEMORY.rows.length, NODE_MEMORY.alive.size);
    const pol = { same: POLICY.same, diff: POLICY.different, why: POLICY.reasons };
    return json({ host, table: VT.all(), pol, plan, counters: cntView() });
  }

  /**
   * 功能：`?hl=1` —— 拼路健康度（本地表 + 可选 DO 环形缓冲）。
   * @param c 路由上下文（要 `env`）
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private async healthRows(c: DebugCtx, q: URLSearchParams): Promise<Response | null> {
    if (q.get("hl") !== "1") return null;
    // 环形缓冲要跨 isolate 才有意义，所以只有显式 `&do=1` 才多花一次子请求
    let ring: unknown = [];
    if (q.get("do") === "1") {
      try {
        const raw = String(c.env.uuid || c.env.uuids).split(",")[0].trim().toLowerCase();
        const rr = await doFetch(c.env, raw, "https://meter/hl");
        ring = ((await rr.json()) as { hl?: unknown }).hl || [];
      } catch {
        // 读不到就是空环：不把这一维的失败当整轮失败（与 /logs 同口径）
        ring = [];
      }
    }
    return json({ local: HEALTH.json(20), sizes: HEALTH.counts(), ring });
  }

  /**
   * 功能：`?prefs=1` —— 站点偏好表与策略命中原因。
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private prefsRows(q: URLSearchParams): Response | null {
    if (q.get("prefs") !== "1") return null;
    return json({ prefs: Prefs.json(60), pol: { same: POLICY.same, diff: POLICY.different, why: POLICY.reasons } });
  }

  /**
   * 功能：`?cl=1` —— 连接观测（本地快照 + 可选 DO 环形缓冲）。
   * @param c 路由上下文（要 `env` 与 `id`）
   * @param q 查询参数
   * @returns 命中时的响应，否则 `null`
   */
  private async connRows(c: DebugCtx, q: URLSearchParams): Promise<Response | null> {
    if (q.get("cl") !== "1") return null;
    const { env, id } = c;
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
    return json({ local, ring, now: Date.now() });
  }
}

/** 只读诊断表的单例（无状态，但保持与其它诊断组件一致的调用形状） */
// ---- 并入自 debug-actions.ts ----

/**
 * 会改服务端状态的诊断操作：抓源、钉当前节点、回填用量。
 *
 * 为什么单独成类：这四个分支都必须先过 `adminOnly`，而且都在写 KV / DO。
 * 与只读表分支放在一起时，「哪些参数会真的改状态」只能靠逐行读 `await` 才知道；
 * 分成一个类之后，`DebugActions` 的方法列表本身就是「这台机器上能被改的东西」清单。
 */
export class DebugActions {
  /**
   * 重新抓一遍池子源并（默认）提交。
   * @param c 路由上下文
   * @param url 请求 URL（`?refill=1&dry=1&force=1`）
   * @returns 命中时返回抓取/提交结果，否则 `null`
   */
  async refill(c: DebugCtx, url: URL): Promise<Response | null> {
    if (url.searchParams.get("refill") !== "1") return null;
    const deny = await adminOnly(c);
    if (deny) return deny;
    // 和 cron 共用同一套抓取/去重/2MB 截断，别再维护第二份
    const refill = await refillPool(c.env);
    const merged = refill.pool;
    // 默认提交（debug 端点已有 UUID 鉴权）；&dry=1 只看不写，&force=1 无视线池 60% 守卫
    let commit: Record<string, unknown> = { ok: true, skipped: true };
    if (merged.length && url.searchParams.get("dry") !== "1") {
      commit = await commitPool(c.env, merged, url.searchParams.get("force") === "1");
    }
    return json({
      sources: refill.sources,
      merged: merged.length,
      pool: merged.length,
      committed: !!commit.ok && !commit.skipped,
      gen: commit.gen || 0,
      reason: commit.reason || "",
      kvLastWrite: KV_WRITES.status,
      extra: EXTRA_HOSTS,
    });
  }

  /**
   * 手动指定当前节点：`?cur=1.2.3.4:443`（用于对比不同节点的真实速度）。
   * @param c 路由上下文
   * @param url 请求 URL
   * @returns 命中时返回钉住结果（含写 KV 锚点是否成功），否则 `null`
   */
  async pinCurrent(c: DebugCtx, url: URL): Promise<Response | null> {
    if (!url.searchParams.get("cur")) return null;
    const deny = await adminOnly(c);
    if (deny) return deny;
    const want = String(url.searchParams.get("cur")).trim();
    if (!/^[0-9a-zA-Z.\-]+:\d+$/.test(want)) return json({ ok: false, error: "格式应为 host:port" });
    await pxSet(c.env, { cur: want });
    // 把这条节点的惩罚清掉：手动指定的语义就是「我就要用这条，别拿历史失败拦我」
    const stat = NodeStatsTable.nsGet(want);
    stat.blackUntil = 0;
    stat.freeUntil = 0;
    stat.streak = 0;
    const fx = await flushPx(c.env, true);
    SELECTION_MEMORY.failCount = 0;
    // 钉节点要跟着写 KV 锚点，否则别的 isolate 起来会挑回原来那条（返回 ok 但没落盘就是谎报）
    return json({
      ok: true,
      cur: want,
      curs: SELECTION_MEMORY.current,
      anchor: fx.ok ? "ok" : "fail",
      note: fx.ok ? undefined : fx.err,
    });
  }

  /**
   * 从 KV 快照回填用量：只在 DO 累计仍为 0 时生效，重建脚本后靠它恢复历史数字。
   * @param c 路由上下文
   * @param url 请求 URL（`?restore=1`）
   * @param id 用户标识（DO 实例名）
   * @returns 命中时返回回填结果，否则 `null`
   */
  async restore(c: DebugCtx, url: URL, id: string): Promise<Response | null> {
    if (url.searchParams.get("restore") !== "1") return null;
    const deny = await adminOnly(c);
    if (deny) return deny;
    const v = await restoreUsage(c.env, id);
    return json({ ok: !!v, restored: v || null });
  }

  /**
   * 手动回填用量（仅在 DO 累计为 0 时生效）。
   * @param c 路由上下文
   * @param url 请求 URL（`?seed=<up>,<down>,<conns>`）
   * @param id 用户标识（DO 实例名）
   * @returns 命中时返回 DO 的原始应答，否则 `null`
   */
  async seed(c: DebugCtx, url: URL, id: string): Promise<Response | null> {
    if (!url.searchParams.get("seed")) return null;
    const deny = await adminOnly(c);
    if (deny) return deny;
    // 三个数缺省为 0：只回填他关心的那一维（例如只想补 down）
    const [up0, down0, conns0] = String(url.searchParams.get("seed"))
      .split(",")
      .map((x) => Number(x) || 0);
    // 分别记 HTTP 状态与解析结果：DO 回 500 时 `seeded` 里通常是 `{ ok: false }`，
    // 而网络层失败会走 catch —— 两种失败要让调用方一眼分开
    let seeded = null;
    let seedOk = false;
    let seedStatus = 0;
    try {
      const r = await doFetch(c.env, id, "https://meter/seed", {
        method: "POST",
        body: JSON.stringify({ up: up0, down: down0, conns: conns0, first: Date.now() }),
      });
      seedOk = r.ok;
      seedStatus = r.status;
      seeded = await r.json();
      // 回填成功后立刻刷新本地缓存：否则下一次 `/` 仍读到回填前的 0
      METER_CLIENT.cache.set(id, { v: seeded, t: Date.now() });
    } catch (e) {
      return json({ ok: false, error: String(errMsg(e)) });
    }
    return json({ ok: seedOk, doStatus: seedStatus, seeded });
  }
}

/** 会改状态的诊断操作单例 */
// ---- 并入自 debug-meter.ts ----
/**
 * 一条「计量 DO 诊断探测」的调用规格。
 * 六个诊断端点的形状完全一样：校验管理员 → 取一个带实例名的 DO → 带上参数 fetch →
 * 把 DO 的响应体塞进 `{ ok, doStatus, <item> }`。差别只有参数名、默认实例名、超时与结果键，
 * 所以它们应该是数据，而不是六个几乎逐字重复的 if 块。
 */
export interface ProbeSpec {
  /** URL 上的开关参数名（`?burn=` 等），值会被当作数字参数带给 DO */
  readonly param: string;
  /** DO 端点的完整地址（`https://meter/<name>`；查询串由 `queryKey` 单独拼） */
  readonly url: string;
  /** DO 查询串里放查询值的参数名（`ms` / `n`），空串表示这个端点不收查询值 */
  readonly queryKey: string;
  /** 没给查询值时用的默认值（数字） */
  readonly queryDefault: number;
  /** 结果在响应 JSON 里的键名 */
  readonly item: string;
  /** 这个调用的上限毫秒数（DO 里有独立预算，但请求本身可能挂住） */
  readonly budgetMs: number;
  /** 实例名的前缀：同一个前缀 + 时间戳，避免上一次被 CPU 墙打断的实例把队列挂在 pending */
  readonly instPrefix: string;
  /** 是否必须带 `&n=<inst>`（读回上一次探测写下的阶段标记时才需要固定实例） */
  readonly needInst: boolean;
}

/**
 * 计量 DO 的诊断探测端点集合。
 *
 * 为什么单独一个类：`src/routes/debug.ts` 原来把六个分支写成一串 if，每块都要自己
 * 「取 stub、拼查询串、包超时、处理 5xx」；四个动作漏一个就是一个只会在线上才发现的坑
 * （7.202 的 `ok: true` 常量、7.187 的裸 `connect`、7.126 的漏 `withTimeout`）。
 * 现在规格集中在 `SPECS` 里，调用路径只有一条，漏掉任何一步都不可能只影响一个端点。
 */
export class DebugMeterProbes {
  /**
   * 六个诊断端点的调用规格（`?burn=` / `?stage=` / `?tim=` / `?iter=` / `?burnjs=` / `?crypto=`）。
   * `stage` 是唯一需要固定实例名的：它读回「上一次探测写下的阶段标记」，换个实例就读不到。
   */
  readonly specs: readonly ProbeSpec[] = [
    { param: "burn", url: "https://meter/burn", queryKey: "ms", queryDefault: 50, item: "burn", budgetMs: 15000, instPrefix: "burn", needInst: false },
    { param: "stage", url: "https://meter/stage", queryKey: "", queryDefault: 0, item: "stage", budgetMs: 8000, instPrefix: "", needInst: true },
    { param: "tim", url: "https://meter/tim", queryKey: "ms", queryDefault: 0, item: "out", budgetMs: 20000, instPrefix: "t", needInst: false },
    { param: "iter", url: "https://meter/iter", queryKey: "n", queryDefault: 1000000, item: "iter", budgetMs: 20000, instPrefix: "it", needInst: false },
    { param: "burnjs", url: "https://meter/burnjs", queryKey: "ms", queryDefault: 20, item: "burn", budgetMs: 20000, instPrefix: "js", needInst: false },
    { param: "crypto", url: "https://meter/crypto", queryKey: "", queryDefault: 0, item: "crypto", budgetMs: 25000, instPrefix: "cr", needInst: false },
  ];

  /**
   * 按 URL 参数派发一次诊断探测（只处理 `specs` 里的六个参数）。
   * @param {RouteCtx & { id: string }} c 请求上下文（已经过 UUID 校验，含 env 与用户 id）
   * @param {URL} url 请求 URL
   * @param {string} id 用户 id：DO 实例名以它开头，避免不同用户的探测互相干扰
   * @returns {Promise<Response | null>} 命中参数时返回响应；六个参数都没有时返回 `null`，交给调用方的其余分支
   */
  async run(c: RouteCtx & { id: string }, url: URL, id: string): Promise<Response | null> {
    const spec = this.specs.find((s) => url.searchParams.get(s.param) !== null);
    // 不是这六个参数中的任何一个：让 `debug()` 继续往下走它自己的分支
    if (!spec) return null;
    const deny = await adminOnly(c);
    if (deny) return deny;
    const env = c.env;
    // 诊断端点全都要一个计量 DO；没绑定时如实报错，而不是抛一个读不懂的 TypeError
    if (!env.METER) return json({ ok: false, error: "no METER" });
    const given = url.searchParams.get("n") || "";
    // 需要固定实例却没说实例名：直接回错，免得读回一条随机实例上的空阶段标记
    if (spec.needInst && !given) return json({ ok: false, error: "need &n=<inst>" });
    // 实例名：显式给的优先；否则「前缀 + 时间戳」，让上一次被 CPU 墙打断的实例不会串到这一次
    const inst = given || spec.instPrefix + Date.now();
    const rawValue = url.searchParams.get(spec.param) || "";
    const value = spec.queryKey ? Number(rawValue || spec.queryDefault) : 0;
    // 查询串：只有收查询值的端点才拼，`/stage` 与 `/crypto` 是空查询；`spec.url` 保持完整字面量，
    // 这样 `tools/check-wire.mjs` 的「有实现必须有调用方」仍然能按字符串找到这条端点
    const query = spec.queryKey ? `?${spec.queryKey}=${value}` : "";
    try {
      const stub = env.METER.get(env.METER.idFromName(id + "::" + inst));
      // 跨 DO 边界的返回值在类型上是 unknown，这里显式收窄成 Response 再读 ok/status/json
      const resp = (await withTimeout(stub.fetch(spec.url + query), spec.budgetMs)) as Response;
      // `ok` 必须是 DO 的真实状态：7.202 之前这里写死 `ok: true`，DO 回 500 也报成功
      return json({ ok: resp.ok, doStatus: resp.status, [spec.item]: await resp.json() });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }
}

/** 单例：探测本身不持有任何状态，安全共享（规格表是只读常量） */
// ---- 组合根：四个组件由同一处持有 ----

/**
 * 功能：调试路由四个组件的持有者 —— 读表、测网、写操作、计量探测。
 *
 * 为什么收成一个：四个组件各自 `export const` 时，调用方要记四个名字、四份 import，
 * 而它们只在 `debug()` 里按固定顺序出场；收进一个对象后「这次调试动用了哪些能力」
 * 在一个地方就能读完（也正是判断「这个参数会不会真的拨号」的入口）。
 */
export class DebugSuite {
  /** 只读表：判定、事实层、健康度、连接记录 */
  readonly tables = new DebugTables();
  /** 会对外拨号的测量：出口测速、站点诊断、原始探活、明文 HTTP、判定批 */
  readonly nets = new DebugNets();
  /** 会改状态的写操作：抓源、钉节点、回填用量（都先过 `adminOnly`） */
  readonly actions = new DebugActions();
  /** 计量 DO 的诊断探测（不持有状态，规格表是只读常量） */
  readonly probes = new DebugMeterProbes();
}

/** 进程内唯一的调试组件组 */
export const DEBUG = new DebugSuite();

// ---- 门面（对外导出面保持不变） ----

/**
 * `/<uuid>/debug`：把所有诊断入口按固定顺序分派给三类组件。
 *
 * - `TABLES`（`debug-tables.ts`）：只读表 —— 判定、事实层、健康度、连接记录；
 * - `NETS`（`debug-nets.ts`）：会对外拨号的测量 —— 出口测速、站点诊断、原始探活、明文 HTTP、判定批；
 * - `ACTIONS`（`debug-actions.ts`）：会改状态的写操作 —— 抓源、钉节点、回填用量（都先过 `adminOnly`）。
 *
 * 顺序是有意义的：只读分支必须排在测量与写操作之前，否则 `?diag=x&refill=1` 这种组合
 * 会先花掉一次抓源再回答一个只读问题。`METER_PROBES` 与 `?tfb=`/`?tf=` 排在最后，
 * 因为它们各自要占一次 DO 往返。
 *
 * @param c 路由上下文（含 `env` / `id` / `url`）
 * @returns 命中的诊断分支响应；一个参数都没有时退化成 `?host=` 的 DNS/v6 可达性检查
 */
export async function debug(c: DebugCtx): Promise<Response> {
  const { env, url, id } = c;
  // &do=1：先把这个 isolate 学的强证据写回 DO，再把 DO 里的合并回来，
  // 这样从任意边缘读都能看到「刚刚在别的 isolate 学到的封锁」。
  if (url.searchParams.get("do") === "1" && env.METER) {
    try {
      const rows = vtDelta();
      if (rows.length) {
        // 走 `doFetch`：它同时把这次子请求记进 `METER_CLIENT.calls`，绕过它 `/health` 的计数就少一块
        const userId = String(env.uuid || env.uuids).split(",")[0].trim().toLowerCase();
        const r = await doFetch(env, userId, "https://meter/add", {
          method: "POST",
          body: JSON.stringify({ vt: rows }),
        });
        // 成功后必须 ack：否则 pending 一直留着，下次 cron flush 会把同一批证据重复上报。
        // 非 2xx 当失败处理（nack），让下一轮重新登记；原来只看「没抛异常」就当成功。
        if (r.ok) vtAck();
        else vtNack();
      }
    } catch {
      // 写回失败不影响本次诊断：nack 让 pending 下轮重发，vtLoad 会重新尝试读
      vtNack();
    }
    VT_SYNC.loaded = false;
    await vtLoad(env);
  }

  // 1) 只读表
  const table = await DEBUG.tables.read(c, url);
  if (table) return table;

  // 2) 会对外拨号的测量（顺序敏感：bench 与 diag 都要花真流量）
  const bench = await DEBUG.nets.bench(url);
  if (bench) return bench;
  const diag = await DEBUG.nets.diag(c, url);
  if (diag) return diag;
  const probe = await DEBUG.nets.rawProbe(url);
  if (probe) return probe;

  // 3) 会改状态的写操作
  const refill = await DEBUG.actions.refill(c, url);
  if (refill) return refill;
  const pin = await DEBUG.actions.pinCurrent(c, url);
  if (pin) return pin;

  // 4) 明文 HTTP 与计量 DO 诊断（各自一次 DO 或直连往返）
  const http = await DEBUG.nets.http(c, url);
  if (http) return http;
  // 六个「计量 DO 诊断」端点（?burn= / ?stage= / ?tim= / ?iter= / ?burnjs= / ?crypto=）交给
  // `DebugMeterProbes`：它们的形状完全一样（校验管理员 → 取带实例名的 DO → 带超时 fetch →
  // 包成 { ok, doStatus, <item> }），写成六个 if 块时每一步都可能在某一块里漏掉。
  const meterProbe = await DEBUG.probes.run(c, url, id);
  if (meterProbe) return meterProbe;
  const tfb = await DEBUG.nets.tfb(c, url);
  if (tfb) return tfb;
  const tf = await DEBUG.nets.tf(c, url);
  if (tf) return tf;

  // 5) 回填类（都要管理员）
  const restore = await DEBUG.actions.restore(c, url, id);
  if (restore) return restore;
  const seed = await DEBUG.actions.seed(c, url, id);
  if (seed) return seed;

  // 6) 兜底：两个地址族各查一次，再试一次 v6 建连
  return DEBUG.nets.host(url, c.budget);
}
