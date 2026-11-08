import { S } from "../core/state";
import { cntDelta, spdSnapshot } from "../px/pool";
import { Meter } from "./meter";
import { flushSnap, getSnap, usageSnapGet } from "./snapshot";

/* 计量：PEND 缓冲 + Meter DO 读写 + 用量视图 */

export const PEND_FLUSH_BYTES = 16 * 1024 * 1024;  // 大文件传输时别频繁打 DO：DO 调用会吃这条连接的 CPU

export const METER_TTL = 15000;

export function pendAdd(id: string, up: number, down: number, isNew?: boolean) {
  if (!id) return;
  const p = S.pend.get(id) || { up: 0, down: 0, conns: 0 };
  p.up += up || 0;
  p.down += down || 0;
  S.pendBytes += (up || 0) + (down || 0);
  if (isNew) p.conns += 1;
  if (S.pend.size > 500) S.pend.clear();
  S.pend.set(id, p);
}

export function scheduleFlush(env: Env, delay?: number) {
  if (S.tflush) return;
  const d = delay === undefined ? S.pendMs : delay;
  S.tflush = setTimeout(() => {
    S.tflush = null;
    pendFlush(env, true).catch(() => {});
  }, d);
}

export async function pendFlush(env: Env, force?: boolean): Promise<void> {
  if (!env || !env.METER || !S.pend.size) return;
  if (!force && Date.now() - S.pendAt < S.pendMs) return;
  S.pendAt = Date.now();
  const batch = [...S.pend.entries()];
  S.pend.clear();
  S.pendBytes = 0;
  let bad = 0;
  const cd = cntDelta();
  const today = new Date().toISOString().slice(0, 10);
  let attached = false;
  // 快照固定挂在主 uuid 的对象上：挂到"批次第一个"会挂到另一个用户，
  // 结果面板（读主 uuid）永远看不到更新。
  const primary = String(env.uuid || "").trim().toLowerCase();
  await Promise.all(
    batch.map(async ([id, d]) => {
      try {
        const stub = env.METER.get(env.METER.idFromName(id));
        const body: Record<string, unknown> = { ...d };
        const mine = !primary || String(id).toLowerCase() === primary;
        if (!attached && mine) {
          attached = true;
          body.c = { ...cd, d: today };        // 只挂一次，避免重复计
          body.spd = spdSnapshot();            // 节点快照：跨 isolate 可见
          body.e = S.errs.slice(-8);             // 错误也带上去：/logs 才能跨 isolate
        }
        const r = await stub.fetch("https://meter/add", {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error("do " + r.status);
        S.doCalls += 1;
        S.meterCache.delete(id);      // 刚推过增量，缓存立即失效，避免读数倒退
      } catch (e) {
        bad += 1;
        const cur = S.pend.get(id) || { up: 0, down: 0, conns: 0 };
        S.pend.set(id, { up: cur.up + d.up, down: cur.down + d.down, conns: cur.conns + d.conns });
      }
    })
  );
  // 自适应退避：失败了就把间隔翻倍（最多 60s），成功了慢慢降回 30s
  if (bad) S.pendMs = Math.min(S.pendMs * 2, 60000);
  else S.pendMs = Math.max(30000, Math.round(S.pendMs / 2));
}

export async function meterGet(env: Env, id: string) {
  if (!env || !env.METER || !id) return null;
  const hit = S.meterCache.get(id);
  if (hit && Date.now() - hit.t < METER_TTL) return hit.v;

  for (let i = 0; i < 2; i++) {
    try {
      const stub = env.METER.get(env.METER.idFromName(id));
      const r = await stub.fetch("https://meter/get");
      if (!r.ok) throw new Error("do " + r.status);
      const v = await r.json();
      if (S.meterCache.size > 500) S.meterCache.clear();
      S.meterCache.set(id, { v, t: Date.now() });
      return v;
    } catch (e) {
      if (i === 0) await new Promise((res) => setTimeout(res, 120));
    }
  }
  return hit ? hit.v : null;
}

export function statBump(id: string, up: number, down: number, isNewConn?: boolean) {
  if (!id) return;
  pendAdd(id, up, down, isNewConn);   // 全局帐本（DO）
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
    return {
      id,
      up: (doTotal.up || 0) + p.up,
      down: (doTotal.down || 0) + p.down,
      conns: (doTotal.conns || 0) + p.conns,
      // 当日量 = DO 里的当日累计 + 还没推上去的增量
      todayUp: (doTotal.dU || 0) + p.up,
      todayDown: (doTotal.dD || 0) + p.down,
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
