import { errMsg } from "../core/util";
import { S } from "../core/state";
import { json } from "../edge/respond";
import { adminOnly } from "../edge/auth";
import { STATS } from "../nodes/score";
import { commitPool, flushPx, pxSet } from "../px/pool";
import { EXTRA_HOSTS, refillPool } from "../px/probe";
import { restoreUsage } from "../store/index";
import { doFetch } from "../store/index";

import type { RouteCtx } from "../edge/types";

/** 诊断路由的上下文：`/debug` 挂在用户前缀下，所以一定带着 `id` */
type DebugCtx = RouteCtx & { id: string };

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
      kvLastWrite: S.kvStat,
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
    const stat = STATS.nsGet(want);
    stat.blackUntil = 0;
    stat.freeUntil = 0;
    stat.streak = 0;
    const fx = await flushPx(c.env, true);
    S.pxFailMem = 0;
    // 钉节点要跟着写 KV 锚点，否则别的 isolate 起来会挑回原来那条（返回 ok 但没落盘就是谎报）
    return json({
      ok: true,
      cur: want,
      curs: S.curs,
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
      S.meterCache.set(id, { v: seeded, t: Date.now() });
    } catch (e) {
      return json({ ok: false, error: String(errMsg(e)) });
    }
    return json({ ok: seedOk, doStatus: seedStatus, seeded });
  }
}

/** 会改状态的诊断操作单例 */
export const ACTIONS = new DebugActions();
