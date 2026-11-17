import { S } from "../core/state";
import { vtDelta, vtLoad } from "../route/verdictsync";
import { doFetch } from "../store/index";
import { ACTIONS } from "./debug-actions";
import { METER_PROBES } from "./debug-meter";
import { NETS } from "./debug-nets";
import { TABLES } from "./debug-tables";

import type { RouteCtx } from "../edge/types";

/** 诊断路由的上下文：`/<uuid>/debug` 挂在用户前缀下，所以一定带着 `id` */
type DebugCtx = RouteCtx & { id: string };

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
        // 走 `doFetch`：它同时把这次子请求记进 `S.doCalls`，绕过它 `/health` 的计数就少一块
        const userId = String(env.uuid || env.uuids).split(",")[0].trim().toLowerCase();
        await doFetch(env, userId, "https://meter/add", {
          method: "POST",
          body: JSON.stringify({ vt: rows }),
        });
      }
    } catch {
      // 写回失败不影响本次诊断：下面的 vtLoad 会重新尝试读
    }
    S.vtLoaded = false;
    await vtLoad(env);
  }

  // 1) 只读表
  const table = await TABLES.read(c, url);
  if (table) return table;

  // 2) 会对外拨号的测量（顺序敏感：bench 与 diag 都要花真流量）
  const bench = await NETS.bench(url);
  if (bench) return bench;
  const diag = await NETS.diag(c, url);
  if (diag) return diag;
  const probe = await NETS.rawProbe(url);
  if (probe) return probe;

  // 3) 会改状态的写操作
  const refill = await ACTIONS.refill(c, url);
  if (refill) return refill;
  const pin = await ACTIONS.pinCurrent(c, url);
  if (pin) return pin;

  // 4) 明文 HTTP 与计量 DO 诊断（各自一次 DO 或直连往返）
  const http = await NETS.http(c, url);
  if (http) return http;
  // 六个「计量 DO 诊断」端点（?burn= / ?stage= / ?tim= / ?iter= / ?burnjs= / ?crypto=）交给
  // `DebugMeterProbes`：它们的形状完全一样（校验管理员 → 取带实例名的 DO → 带超时 fetch →
  // 包成 { ok, doStatus, <item> }），写成六个 if 块时每一步都可能在某一块里漏掉。
  const meterProbe = await METER_PROBES.run(c, url, id);
  if (meterProbe) return meterProbe;
  const tfb = await NETS.tfb(c, url);
  if (tfb) return tfb;
  const tf = await NETS.tf(c, url);
  if (tf) return tf;

  // 5) 回填类（都要管理员）
  const restore = await ACTIONS.restore(c, url, id);
  if (restore) return restore;
  const seed = await ACTIONS.seed(c, url, id);
  if (seed) return seed;

  // 6) 兜底：两个地址族各查一次，再试一次 v6 建连
  return NETS.host(url);
}
