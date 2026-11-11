import { S } from "../core/state";
import { primaryId, pendAdd } from "./pend";
import { getSnap, usageSnapGet } from "./snapshot";
import { meterGet } from "./meter-client";

/* 用量视图：Meter DO 读取 / 本地缓存 / 面板口径 */

/**
 * 取 Meter DO 里的节点快照（跨 isolate）。
 * 面板跑在哪个 isolate 全看运气，只看本地 nstat 会永远显示"未用"。
 */
export async function nodeSnapGet(env: Env, id: string): Promise<Record<string, NodeSnap>> {
  if (!env || !env.METER || !id) return {};
  const hit = S.nodeSnapCache;
  if (hit.t && Date.now() - hit.t < 60000) return hit.v;
  try {
    // 快照只写在主 uuid 的 DO 上：用别人的 id 去读永远是空的
    const stub = env.METER.get(env.METER.idFromName(primaryId(env) || id));
    const r = await stub.fetch("https://meter/cnt");
    if (!r.ok) throw new Error("do " + r.status);
    const j = await r.json();
    const v = (j && j.s && typeof j.s === "object" ? j.s : {}) as Record<string, NodeSnap>;
    S.nodeSnapCache = { t: Date.now(), v };
    return v;
  } catch (e) {
    // 失败也记时间：DO 挂掉时不要每个面板请求都重试一次
    S.nodeSnapCache = { t: Date.now(), v: hit.v || {} };
    return S.nodeSnapCache.v;
  }
}

export function statBump(id: string, up: number, down: number, isNewConn?: boolean) {
  if (!id) return;
  pendAdd(id, up, down, isNewConn); // 全局帐本（DO）
  let s = S.stats.get(id);
  if (!s) {
    s = { up: 0, down: 0, conns: 0, first: Date.now(), last: Date.now() };
    S.stats.set(id, s);
  }
  s.up += up || 0;
  s.down += down || 0;
  S.snapBytes += (up || 0) + (down || 0);
  if (isNewConn) s.conns += 1;
  s.last = Date.now();
}

export async function readStatsCached(env: Env, id: string) {
  const hit = S.statCache.get(id);
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  const v = await readStats(env, id);
  S.statCache.set(id, { v, t: Date.now() });
  if (S.statCache.size > 200) S.statCache.clear();
  return v;
}

export async function readStats(env: Env, id: string) {
  const local = S.stats.get(id) || { up: 0, down: 0, conns: 0, first: 0, last: 0 };
  const p = S.pend.get(id) || { up: 0, down: 0, conns: 0 };

  // 首选：Meter DO（全网络唯一帐本，不存在丢更新）
  let doTotal = await meterGet(env, id);

  // DO 被重置过（重建脚本会把命名空间一起删掉）→ 用 KV 快照回填一次
  if (doTotal && !(doTotal.up || doTotal.down || doTotal.conns)) {
    const snap = await usageSnapGet(env);
    const s = snap && snap.users && snap.users[id];
    if (s) {
      try {
        const stub = env.METER.get(env.METER.idFromName(id));
        const r = await stub.fetch("https://meter/seed", { method: "POST", body: JSON.stringify(s) });
        if (r.ok) {
          doTotal = await r.json();
          S.meterCache.set(id, { v: doTotal, t: Date.now() });
        }
      } catch (e) {}
    }
  }

  if (doTotal) {
    // "今日"必须真的按今天算：当天没有任何流量时，DO 里的 d 还停在昨天，
    // dU/dD 也是昨天的数；直接展示会让面板把昨天当今天。
    const day = new Date().toISOString().slice(0, 10);
    const sameDay = !doTotal.d || doTotal.d === day; // 老数据没有 d 字段，按当天处理
    return {
      id,
      up: (doTotal.up || 0) + p.up,
      down: (doTotal.down || 0) + p.down,
      conns: (doTotal.conns || 0) + p.conns,
      // 当日量 = DO 里的当日累计 + 还没推上去的增量
      todayUp: (sameDay ? doTotal.dU || 0 : 0) + p.up,
      todayDown: (sameDay ? doTotal.dD || 0 : 0) + p.down,
      firstSeen: doTotal.first || local.first || null,
      lastSeen: Math.max(doTotal.ts || 0, local.last) || null,
      isolateLocal: { up: local.up, down: local.down, conns: local.conns },
      backend: "do",
      persisted: true,
    };
  }

  // 回退：KV 快照（没绑 METER 时）
  let stored = null;
  if (env.STATS) {
    try {
      const snap = await getSnap(env);
      stored = (snap.stats && snap.stats[id]) || null;
    } catch (e) {
      stored = null;
    }
  }
  const base = stored || { up: 0, down: 0, conns: 0, first: 0, last: 0 };
  return {
    id,
    up: (base.up || 0) + local.up,
    down: (base.down || 0) + local.down,
    conns: (base.conns || 0) + local.conns,
    // 没绑 DO 时，快照本身就是"当日"口径（flushSnap 跨天会重置）
    todayUp: (base.up || 0) + local.up,
    todayDown: (base.down || 0) + local.down,
    firstSeen: base.first || local.first || null,
    lastSeen: Math.max(base.last || 0, local.last) || null,
    isolateLocal: { up: local.up, down: local.down, conns: local.conns },
    backend: "kv",
    persisted: !!stored,
  };
}
