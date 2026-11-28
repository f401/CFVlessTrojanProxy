import { METER_CLIENT } from "../store/meter-client";
import { SELECTION_MEMORY } from "../px/selection-memory";
import { KV_WRITES } from "../store/kv";
import { vtAck, vtDelta, vtLoad, vtNack } from "../store/verdictsync";
import { doFetch, restoreUsage } from "../store/index";
import { DebugNets } from "./debug-nets";
import { DebugTables } from "../route/read-models";
import type { RouteCtx } from "../edge/types";
import { json } from "../edge/respond";
import { VT_SYNC } from "../facts/verdict";
import { errMsg, withTimeout } from "../core/util";
import { adminOnly } from "../edge/auth";
import { NodeStatsTable } from "../nodes/score";
import { commitPool, flushPx, pxSet } from "../px/pool";
import { EXTRA_HOSTS, refillPool } from "../px/probe";

// ---- 并入自 debug-tables.ts ----

/** 诊断路由的上下文：`/<uuid>/debug` 挂在用户前缀下，所以一定带着 `id` */
type DebugCtx = RouteCtx & { id: string };


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
  /** 只读表：判定、事实层、健康度、连接记录（读模型在 `route/debug-rows.ts`） */
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
  const table = await DEBUG.tables.read(env, id, url);
  if (table) return json(table);

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
