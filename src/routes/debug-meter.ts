import { adminOnly } from "../edge/auth";
import type { RouteCtx } from "../edge/types";
import { errMsg, withTimeout } from "../core/util";
import { json } from "../edge/respond";

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
export const METER_PROBES = new DebugMeterProbes();
