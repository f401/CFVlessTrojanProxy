import { S } from "../core/state";
import { cntDelta, cntUnsend } from "../core/counter";
import { eachLimit } from "../core/util";
import { spdSnapshot } from "../core/node-snapshot";
import { Meter } from "./meter";
import { flushSnap, getSnap, usageSnapGet } from "./snapshot";

/* 计量：PEND 缓冲 + Meter DO 读写 + 用量视图 */

export const PEND_FLUSH_BYTES = 16 * 1024 * 1024; // 大文件传输时别频繁打 DO：DO 调用会吃这条连接的 CPU

export const METER_TTL = 15000;

/** 主 UUID：计数器/节点快照只挂在这个 DO 上（uuid 可能是逗号列表，取第一个） */
export function primaryId(env: Env): string {
  return String((env && (env.uuid || env.uuids)) || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
}

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

export function pendAdd(id: string, up: number, down: number, isNew?: boolean) {
  if (!id) return;
  const p = S.pend.get(id) || { up: 0, down: 0, conns: 0 };
  p.up += up || 0;
  p.down += down || 0;
  S.pendBytes += (up || 0) + (down || 0);
  if (isNew) p.conns += 1;
  // 以前超过 500 个用户就整体 clear()，一次丢掉所有未推送的字节账。
  // 用户数由用户表决定，内存有界，保留比丢账安全。
  S.pend.set(id, p);
}

export function scheduleFlush(env: Env, delay?: number) {
  if (S.tflush) {
    // 大流量触发 delay=0 时，不能被之前排好的 30 秒定时器压住
    if (delay !== 0) return;
    clearTimeout(S.tflush);
    S.tflush = null;
  }
  const d = delay === undefined ? S.pendMs : delay;
  S.tflush = setTimeout(() => {
    S.tflush = null;
    pendFlush(env, true).catch(() => {});
  }, d);
}

/** 只有计数、没有字节时 PEND 是空的：塞一个空批次把计数顶出去 */
export function kickFlush(env: Env, id: string | null) {
  if (!env || !id || !env.METER) return;
  if (!S.pend.has(id)) S.pend.set(id, { up: 0, down: 0, conns: 0 });
  scheduleFlush(env, 0);
}

export async function pendFlush(env: Env, force?: boolean): Promise<void> {
  if (!env || !env.METER || !S.pend.size) return;
  if (!force && Date.now() - S.pendAt < S.pendMs) return;
  S.pendAt = Date.now();
  const batch = [...S.pend.entries()];
  S.pend.clear();
  S.pendBytes = 0;
  let bad = 0;
  // 快照固定挂在主 uuid 的对象上：挂到"批次第一个"会挂到另一个用户，
  // 结果面板（读主 uuid）永远看不到更新。
  const primary = primaryId(env);
  // 日计数只搭主 uuid 的车：主 uuid 这批没有流量时不要先 cntDelta（会推进基线），
  // 否则计数会永久丢；等主 uuid 下次有批次再一起发。
  const hasPrimary = !primary || batch.some(([bid]) => String(bid).toLowerCase() === primary);
  const cd = hasPrimary ? cntDelta() : {};
  const today = new Date().toISOString().slice(0, 10);
  let attached = false;
  await eachLimit(batch, 8, async ([id, d]) => {
    const mine = !primary || String(id).toLowerCase() === primary;
    try {
      const stub = env.METER.get(env.METER.idFromName(id));
      const body: Record<string, unknown> = { ...d };
      if (!attached && mine) {
        attached = true;
        body.c = { ...cd, d: today }; // 只挂一次，避免重复计
        body.spd = spdSnapshot(); // 节点快照：跨 isolate 可见
        body.e = S.errs.slice(-8); // 错误也带上去：/logs 才能跨 isolate
      }
      const r = await stub.fetch("https://meter/add", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("do " + r.status);
      S.doCalls += 1;
      S.meterCache.delete(id); // 刚推过增量，缓存立即失效，避免读数倒退
    } catch (e) {
      bad += 1;
      const cur = S.pend.get(id) || { up: 0, down: 0, conns: 0 };
      S.pend.set(id, { up: cur.up + d.up, down: cur.down + d.down, conns: cur.conns + d.conns });
      S.pendBytes += (d.up || 0) + (d.down || 0); // 回滚失败批次：健康页与立即刷新的判断要准
      if (mine) cntUnsend(cd); // 日计数搭车主批次失败 → 基线退回，下轮重发
    }
  });
  // 自适应退避：失败了就把间隔翻倍（最多 60s），成功了慢慢降回 30s
  if (bad) S.pendMs = Math.min(S.pendMs * 2, 60000);
  else S.pendMs = Math.max(30000, Math.round(S.pendMs / 2));
}

export async function meterGet(env: Env, id: string) {
  if (!env || !env.METER || !id) return null;
  const hit = S.meterCache.get(id);
  if (hit) {
    // 成功缓存 15 秒；失败（v=null）只缓存 10 秒，避免 DO 抖动时每次翻页都等两次超时
    if (Date.now() - hit.t < (hit.v ? METER_TTL : 10000)) return hit.v;
  }

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
  if (S.meterCache.size > 500) S.meterCache.clear();
  S.meterCache.set(id, { v: hit ? hit.v : null, t: Date.now() });
  return hit ? hit.v : null;
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
