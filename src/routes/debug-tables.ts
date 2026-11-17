import { S } from "../core/state";
import { cntView } from "../core/counter";
import { json } from "../edge/respond";
import { BLK } from "../route/blkfacts";
import { planView } from "../route/budget";
import { BLK_TTL } from "../route/commitfact";
import { DEAD } from "../route/deadfacts";
import { EG } from "../route/egfacts";
import { FACTS } from "../route/factsstore";
import { prefsJson } from "../route/prefs";
import { psSnap } from "../route/psfacts";
import { HEALTH } from "../route/relay-health";
import { REL_SAMPLE_TTL, relSnap } from "../route/relperf";
import { vAll } from "../route/verdict";
import { clSnapshot, doFetch } from "../store/index";

import type { RouteCtx } from "../edge/types";

/** 诊断路由的上下文：`/debug` 挂在用户前缀下，所以一定带着 `id` */
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
   * 依次尝试每个只读分支。
   * @param c 路由上下文（含 `env` / `id`）
   * @param url 请求 URL
   * @returns 命中的分支响应；没有任何只读参数时返回 `null`，交给后面的测量/写操作分支
   */
  async read(c: DebugCtx, url: URL): Promise<Response | null> {
    const { env, id } = c;
    // 判死的会挪到队尾，30 分钟复活
    if (url.searchParams.get("dd")) return json({ rows: DEAD.snap() });
    // 站点 × 中继的成功率事实（本 isolate）：样本越多越可信，因子越靠近 1
    if (url.searchParams.get("pss")) {
      const host = String(url.searchParams.get("pss"));
      return json({ host, rows: psSnap(host) });
    }
    if (url.searchParams.get("eg")) return json({ rows: EG.snap() });
    if (url.searchParams.get("rt")) {
      const host = String(url.searchParams.get("rt") || "").slice(0, 80);
      return json({ host, rows: relSnap(host), alive: S.alive.size, ttl: REL_SAMPLE_TTL });
    }
    // 站点 × 中继的封锁行（v7.222）：文档里从 v8 起就写着 `?blk=<host>`，代码里一直没有这个分支。
    // 只读内存表，不打 DO：要看别处 isolate 回传的行得配合 `?do=1` 那条链（那里是 /meter/vt）。
    if (url.searchParams.get("blk")) {
      const bh = String(url.searchParams.get("blk") || "").slice(0, 80);
      const rows = BLK.snap().filter((r) => r.k === bh || r.k.startsWith(bh + "|"));
      return json({ host: bh, muted: BLK.muted(bh), rows: rows.slice(0, 60), ttl: BLK_TTL });
    }
    // 事实层五张表一次看全（v7.222）：eg / ps / dead / blk2 / dns，容量与条数都能直接看出来
    if (url.searchParams.get("facts") === "1") {
      return json({ tables: FACTS.snap(), counters: cntView() });
    }
    // 本轮预算分配（v7.222）：与 `?vt=<host>` 分支里的 plan 同一口径，省得为了看预算先造一个 host
    if (url.searchParams.get("plan") === "1") {
      return json({ plan: planView(S.pool.length, S.alive.size), counters: cntView() });
    }
    const vtHost = String(url.searchParams.get("vt") || "").slice(0, 80);
    if (vtHost) {
      // 只读表：userland TLS 探测已在 7.69 删除（免费计划必然 1102），证据一律来自真实流量与 tfb。
      // 这里曾经还回三个恒空字段（ips / nodes / rows）——它们来自已删除的扫描器，
      // 于是「扫描结果为空」和「根本没有扫描」在响应里长得一模一样（v7.154 删掉）。
      const plan = planView(S.pool.length, S.alive.size);
      const pol = { same: S.polSame, diff: S.polDiff, why: S.polWhy };
      return json({ host: vtHost, table: vAll(), pol, plan, counters: cntView() });
    }
    // 站点偏好表：判定表按通道聚合后的「能打通 / 打不通」两栏
    if (url.searchParams.get("hl") === "1") {
      let ring: unknown = [];
      if (url.searchParams.get("do") === "1") {
        try {
          const raw = String(c.env.uuid || c.env.uuids).split(",")[0].trim().toLowerCase();
          const rr = await doFetch(c.env, raw, "https://meter/hl");
          ring = ((await rr.json()) as { hl?: unknown }).hl || [];
        } catch {
          ring = [];
        }
      }
      return json({ local: HEALTH.json(20), sizes: HEALTH.counts(), ring });
    }
    if (url.searchParams.get("prefs") === "1") {
      return json({ prefs: prefsJson(60), pol: { same: S.polSame, diff: S.polDiff, why: S.polWhy } });
    }
    if (url.searchParams.get("cl") === "1") {
      const local = clSnapshot(40);
      let ring: ClRec[] = [];
      if (url.searchParams.get("do") === "1" && env.METER) {
        try {
          const r = await doFetch(env, id, "https://meter/cl");
          const j = (await r.json()) as { cl?: ClRec[] };
          if (Array.isArray(j.cl)) ring = j.cl;
        } catch {
          ring = [];
        }
      }
      return json({ local, ring, now: Date.now() });
    }
    return null;
  }
}

/** 只读诊断表的单例（无状态，但保持与其它诊断组件一致的调用形状） */
export const TABLES = new DebugTables();
