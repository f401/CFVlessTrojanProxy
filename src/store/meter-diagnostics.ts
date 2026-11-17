import { probeTf } from "../core/transport";

/**
 * 功能：计量 DO 里那些「只为诊断存在」的端点。
 *
 * 为什么要有这个类：它们跑在 DO 里（请求路径只有 10ms CPU，DO 有独立且大得多的预算），
 * 此前全部挤在 `Meter.handle` 的 if 链里 —— 十来个端点、每个都带自己的夹取范围与注释，
 * 把真正管账目的那段埋掉了。搬到一处之后 `Meter` 只剩分派，而这里每个端点一个方法，
 * 方法名就是它的用途（`timerProbe` / `cpuBurnProbe` / `relayBatchProbe`…）。
 *
 * 纪律：这些端点**不落盘**（`stagedSnapshot` 只读），除 `/stage` 外不碰 storage；
 * 结论由调用方并入既有批次，不额外产生 KV 写与 DO 往返。
 */
export class MeterDiagnostics {
  /**
   * 功能：按端点名分派；不是诊断端点就返回 null，让调用方继续走账目分支。
   * @param {string} pathname 请求路径（形如 `https://meter/tim`）
   * @param {URL} url 完整 URL（取查询参数）
   * @param {DurableObjectState} state DO 状态对象（只有 `/stage` 用得到）
   * @returns {Promise<Response | null>} 诊断响应；不属于本类时返回 null
   */
  async run(pathname: string, url: URL, state: DurableObjectState): Promise<Response | null> {
    if (pathname.endsWith("/stage")) return this.stagedSnapshot(state);
    if (pathname.endsWith("/tim")) return this.timerProbe(url);
    if (pathname.endsWith("/iter")) return this.iterationProbe(url);
    if (pathname.endsWith("/burn")) return this.cryptoBurnProbe(url);
    if (pathname.endsWith("/burnjs")) return this.jsBurnProbe(url);
    if (pathname.endsWith("/crypto")) return this.cryptoApiProbe();
    if (pathname.endsWith("/tfb")) return this.relayBatchProbe(url);
    if (pathname.endsWith("/tf")) return this.relayProbe(url);
    return null;
  }

  /**
   * 功能：读上一次探测写下的阶段标记（只读，不落盘）。
   * @param {DurableObjectState} state DO 状态对象
   * @returns {Promise<Response>} `{ stage }`；没写过时为 null
   */
  private async stagedSnapshot(state: DurableObjectState): Promise<Response> {
    const stage = await state.storage.get("pstage");
    return Response.json({ stage: stage || null });
  }

  /**
   * 功能：量 DO 里 `setTimeout` 到底会不会触发。
   * 为什么重要：不触发的话，所有「计时器竞速」的截止时间都失效（只能靠 fetch 侧超时）。
   * @param {URL} url 查询参数 `ms`（默认 200，夹在 10..3000）
   * @returns {Promise<Response>} `{ ok, asked, wall }`
   */
  private async timerProbe(url: URL): Promise<Response> {
    const askedMs = Math.max(10, Math.min(3000, Number(url.searchParams.get("ms") || 200)));
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, askedMs));
    return Response.json({ ok: true, asked: askedMs, wall: Date.now() - startedAt });
  }

  /**
   * 功能：固定迭代次数的纯 CPU 循环，量给定的 `n` 要烧多久。
   * 为什么不看 `Date.now()` 决定停止：Worker 同步段里时间可能冻结，靠它计时会得出「零耗时」。
   * @param {URL} url 查询参数 `n`（默认 1e6，夹在 1..2e8）
   * @returns {Response} `{ ok, n, wall, x }`
   */
  private iterationProbe(url: URL): Response {
    const iterations = Math.max(1, Math.min(200000000, Number(url.searchParams.get("n") || 1000000)));
    const startedAt = Date.now();
    // 乘加混合是为了让每次迭代都依赖上一次结果：避免被优化成常量
    let mix = 7;
    for (let i = 0; i < iterations; i++) mix = (mix * 31 + 7) % 1000003;
    return Response.json({ ok: true, n: iterations, wall: Date.now() - startedAt, x: mix });
  }

  /**
   * 功能：用 `crypto.subtle.digest` 循环烧 CPU，量 DO 的 CPU 预算能跑多少次摘要。
   * @param {URL} url 查询参数 `ms`（默认 50，夹在 1..5000）
   * @returns {Promise<Response>} `{ ok, n, ms }`：n 是完成的摘要次数
   */
  private async cryptoBurnProbe(url: URL): Promise<Response> {
    const budgetMs = Math.max(1, Math.min(5000, Number(url.searchParams.get("ms") || 50)));
    const startedAt = Date.now();
    let rounds = 0;
    const buffer = new Uint8Array(256);
    while (Date.now() - startedAt < budgetMs) {
      await crypto.subtle.digest("SHA-256", buffer);
      rounds++;
    }
    return Response.json({ ok: true, n: rounds, ms: Date.now() - startedAt });
  }

  /**
   * 功能：同步忙等烧 CPU，完全不碰 crypto。
   * 为什么要这一支：用来区分「CPU 预算不够」与「`crypto.subtle` 在这个运行时里根本不返回」。
   * @param {URL} url 查询参数 `ms`（默认 20，夹在 1..5000）
   * @returns {Response} `{ ok, n, ms }`
   */
  private jsBurnProbe(url: URL): Response {
    const budgetMs = Math.max(1, Math.min(5000, Number(url.searchParams.get("ms") || 20)));
    const startedAt = Date.now();
    let mix = 7;
    let rounds = 0;
    while (Date.now() - startedAt < budgetMs) {
      for (let i = 0; i < 1000; i++) mix = (mix * 31 + 7) % 1000003;
      rounds++;
    }
    return Response.json({ ok: true, n: rounds, ms: Date.now() - startedAt });
  }

  /**
   * 功能：逐项量 WebCrypto 各 API 在 DO 里的可用性与耗时。
   * 为什么逐项：任一项挂着就说明该 API 在 DO 里不可用，整条探测链得换实现；
   * 一起测只能得到「整段超时」，分不出是哪一项。
   * @returns {Promise<Response>} 每项一个毫秒数，失败的项是 `"err …"`
   */
  private async cryptoApiProbe(): Promise<Response> {
    const timings: Record<string, number | string> = {};
    let startedAt = Date.now();
    try {
      crypto.getRandomValues(new Uint8Array(32));
      timings.random = Date.now() - startedAt;
    } catch (error) {
      timings.random = "err " + String(error);
    }
    startedAt = Date.now();
    try {
      const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(64));
      timings.digest = Date.now() - startedAt;
      timings.digestLen = digest.byteLength;
    } catch (error) {
      timings.digest = "err " + String(error);
    }
    startedAt = Date.now();
    try {
      const key = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      timings.importKey = Date.now() - startedAt;
      startedAt = Date.now();
      await crypto.subtle.sign("HMAC", key, new Uint8Array(16));
      timings.sign = Date.now() - startedAt;
    } catch (error) {
      timings.sign = "err " + String(error);
    }
    startedAt = Date.now();
    try {
      const first = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      timings.genP256 = Date.now() - startedAt;
      startedAt = Date.now();
      await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      timings.genP256b = Date.now() - startedAt;
      // 第二次生成不为空就说明「能否重复生成」也是通的（有运行时会在第二次失败）
      timings.hasP1 = first ? 1 : 0;
    } catch (error) {
      timings.genP256 = "err " + String(error);
    }
    return Response.json(timings);
  }

  /**
   * 功能：让 DO 自己逐条中继去抓同一个站点（每条一个结论）。
   * @param {URL} url 查询参数 `h` 目标站点、`r` 逗号分隔的中继（最多 3 条）
   * @returns {Promise<Response>} `{ host, rows, ms }`：每行是 `{ relay, ok, status, … }`
   */
  private async relayBatchProbe(url: URL): Promise<Response> {
    const host = url.searchParams.get("h") || "";
    // 最多 3 条：一次批要落在免费计划的子请求额度里，且每条都要真握手
    const relays = (url.searchParams.get("r") || "").split(",").filter(Boolean).slice(0, 3);
    const rows: unknown[] = [];
    for (const relay of relays) rows.push({ relay, ...(await probeTf(host, relay)) });
    return Response.json({ host, rows, ms: Date.now() });
  }

  /**
   * 功能：让 DO 探一次目标（可指定一条中继）。
   * @param {URL} url 查询参数 `h` 目标站点、`r` 中继（空 = 直连）、`p` 路径
   * @returns {Promise<Response>} 探测结论本体
   */
  private async relayProbe(url: URL): Promise<Response> {
    const host = url.searchParams.get("h") || "";
    const relay = url.searchParams.get("r") || "";
    const path = url.searchParams.get("p") || "/";
    return Response.json(await probeTf(host, relay, path));
  }
}

