import { S } from "../core/state";
import { RTT_MAX } from "../core/const";
import { eachLimit } from "../core/util";
import { kvGet, kvSet } from "./kv";
import { meterGet } from "./metering";

/* 快照：用量灾备（KV）+ 合成快照 */

export const USAGE_SNAP_KEY = "usage:snap";
export const FLUSH_MIN_MS = 3600000; // 1 小时（且累计 ≥2MB 才写）
export const FLUSH_DIRTY = 2 * 1024 * 1024; // 脏字节门槛
export const FLUSH_MAX_MS = 7200000; // 最迟 2 小时必落一次
export const FLUSH_GAP = 2700000; // 全局闸门：45 分钟内已有别的 isolate 写过就不再写
export const SNAP_TTL = 300000;

export async function usageSnapGet(env: Env) {
  try {
    return (await kvGet<UsageSnap>(env, USAGE_SNAP_KEY)) || null;
  } catch (e) {
    return null;
  }
}

export async function usageSnapWrite(env: Env, users?: UserRec[]) {
  if (!env.STATS || !env.METER) return;
  const prev = (await usageSnapGet(env)) || ({ users: {}, ts: 0 } as UsageSnap);
  // 灾备快照，2 小时一次足够（cron 是 30 分钟一轮，别每轮都写一遍）
  if (Date.now() - (prev.ts || 0) < 2 * 3600e3) return;
  const list = users || [];
  const out: UsageSnap = { ts: Date.now(), users: {} };
  // 同一个 num 不要每个用户重新建一次闭包
  const num = (x: unknown) => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const today = new Date().toISOString().slice(0, 10);
  await eachLimit(list, 8, async (u) => {
    const v = await meterGet(env, u.id);
    const old = (prev.users || {})[u.id];
    // 只增不减：DO 被重置（重建脚本）时不能把历史快照写回 0。
    // 这里绝不能用 `|0`：用量经常超过 2^31，位运算会溢出成负数，
    // 灾备快照会被写成 0（重建 DO 后历史用量就是这么丢的）。
    const up = Math.max(num(v && v.up), num(old && old.up));
    const down = Math.max(num(v && v.down), num(old && old.down));
    const conns = Math.max(num(v && v.conns), num(old && old.conns));
    // 当日字段只合并"同一天"的：昨天 23:59 的 dU 不能算进今天
    const vDay = v && v.d === today ? v : null;
    const oldDay = old && old.d === today ? old : null;
    const dU = Math.max(num(vDay && vDay.dU), num(oldDay && oldDay.dU));
    const dD = Math.max(num(vDay && vDay.dD), num(oldDay && oldDay.dD));
    if (up || down || conns) {
      out.users[u.id] = {
        up,
        down,
        conns,
        first: (v && v.first) || (old && old.first) || 0,
        d: today,
        dU,
        dD,
      };
    }
  });
  if (!Object.keys(out.users).length) return;
  try {
    await kvSet(env, USAGE_SNAP_KEY, out, { expirationTtl: 86400 * 90 });
  } catch (e) {
    /* 额度耗尽：下次再写 */
  }
}

export async function restoreUsage(env: Env, id: string, snap?: UsageSnap) {
  if (!env || !env.METER) return null;
  const s = snap || (await usageSnapGet(env));
  const u = s && s.users && s.users[id];
  if (!u) return null;
  try {
    const stub = env.METER.get(env.METER.idFromName(id));
    const r = await stub.fetch("https://meter/set", { method: "POST", body: JSON.stringify(u) });
    if (!r.ok) return null;
    const v = await r.json();
    S.meterCache.set(id, { v, t: Date.now() });
    return v;
  } catch (e) {
    return null;
  }
}

export async function flushSnap(env: Env, force?: boolean): Promise<void> {
  const kv = env.STATS;
  if (!kv) return;
  const hasData = S.stats.size > 0 || S.rtt.size > 0 || S.errs.length > 0;
  if (!hasData) return;

  const now = Date.now();
  const since = now - (S.snapWritten || 0);
  // 关键：按"时间"节流，而不是按"脏字节"。
  // 以前 snapBytes >= 2MB 就写 —— 一天 12 GB 流量 = 6000 次写，直接把
  // 免费额度（1000/天）打爆。
  const due = !!force || (S.snapBytes >= FLUSH_DIRTY && since >= FLUSH_MIN_MS) || since >= FLUSH_MAX_MS;
  if (!due) return;
  // 全局闸门失败/跳过时不能每条连接都再去读一次 KV：5 分钟内只检查一次
  if (now - S.snapChecked < 5 * 60000) return;
  S.snapChecked = now;
  // 同一 isolate 只允许一个落盘在飞：连接收尾会并发调 flushSnap，
  // 没有这个闩时 50 条连接同时关闭就可能各写一次 KV（写额度 1000/天）。
  if (S.snapBusy) return;
  S.snapBusy = true;
  try {
    await writeSnap(env, now);
  } finally {
    S.snapBusy = false;
  }
}

async function writeSnap(env: Env, now: number): Promise<void> {
  // 第二个闸门是"全局"的：每个 isolate 各写各的会让写次数随实例数线性增长
  // （实测 8 个 isolate × 24 次/天 = 192 次）。快照本身就是合并写入，
  // 45 分钟内别人写过就跳过，自己的增量留在内存里下一轮合并，一条不丢。
  // 这里必须 fresh：缓存里的 ts 可能已经过时 5 分钟，会误判"该写了"。
  const prev = await getSnap(env, true);
  if (now - (prev.ts || 0) < FLUSH_GAP) {
    // 别人刚写过：把本地基线推进到那一次，并把下一次检查推到闸门结束，
    // 避免下一批连接反复走 getSnap 再跳过。
    S.snapWritten = Math.max(S.snapWritten || 0, prev.ts || 0);
    S.snapChecked = Math.max(S.snapChecked || 0, (prev.ts || 0) + FLUSH_GAP);
    return;
  }

  const day = new Date().toISOString().slice(0, 10);
  const next: SnapDoc = {
    v: 1,
    ts: now,
    date: day,
    stats: prev.date === day ? { ...(prev.stats || {}) } : {}, // 跨天重置
    rtt: { ...(prev.rtt || {}) },
    errs: (prev.errs || []).slice(-50),
  };

  for (const [id, s] of S.stats) {
    const p = next.stats[id] || { up: 0, down: 0, conns: 0, first: s.first, last: s.last };
    next.stats[id] = {
      up: (p.up || 0) + (s.up || 0),
      down: (p.down || 0) + (s.down || 0),
      conns: (p.conns || 0) + (s.conns || 0),
      first: Math.min(p.first || s.first || now, s.first || now),
      last: Math.max(p.last || 0, s.last || 0),
    };
  }

  for (const [id, bucket] of S.rtt) {
    // 不能直接复用 prev 里的普通对象：tag="__proto__" 时赋值会改原型而不是写键
    const tgt = Object.create(null) as Record<string, RttEntry>;
    const oldTgt = next.rtt[id];
    if (oldTgt) for (const [k, v] of Object.entries(oldTgt)) tgt[k] = v;
    for (const [tag, v] of Object.entries(bucket) as [string, RttEntry][]) {
      const p = tgt[tag];
      tgt[tag] = p
        ? {
            rtt: v.rtt ? Math.round((p.rtt || v.rtt) * 0.7 + v.rtt * 0.3) : p.rtt || 0,
            colo: v.colo || p.colo,
            bw: v.bw || p.bw,
            hits: (p.hits || 0) + (v.hits || 0),
            ok: (p.ok || 0) + (v.ok || 0),
            fail: (p.fail || 0) + (v.fail || 0),
            ts: v.ts || p.ts,
          }
        : { ...v, ok: v.ok || 0, fail: v.fail || 0 };
    }
    next.rtt[id] = tgt;
  }
  // 老快照可能已经攒了很多标签：落盘前统一裁到 RTT_MAX（按最后活跃时间）
  for (const tgt of Object.values(next.rtt)) {
    const keys = Object.keys(tgt);
    if (keys.length <= RTT_MAX) continue;
    keys.sort((a, b) => (tgt[a].ts || 0) - (tgt[b].ts || 0));
    for (let i = 0; i < keys.length - RTT_MAX; i++) delete tgt[keys[i]];
  }

  if (S.errs.length) next.errs = next.errs.concat(S.errs).slice(-50);

  try {
    await kvSet(env, "snap", next, { expirationTtl: 86400 * 30 });
    S.snapCache = { v: next, t: Date.now() };
    S.snapWritten = now;
    S.snapBytes = 0;
    S.stats.clear();
    S.rtt.clear();
    S.errs.length = 0;
  } catch (e) {
    /* 额度耗尽：保持内存，下次再试 */
  }
}

export async function getSnap(env: Env, fresh?: boolean) {
  if (!fresh && S.snapCache.v && Date.now() - S.snapCache.t < SNAP_TTL) return S.snapCache.v;
  let v = null;
  try {
    v = (await kvGet<SnapDoc>(env, "snap")) || null;
  } catch (e) {
    v = null;
  }
  const out: SnapDoc = (v as SnapDoc) || { v: 1, ts: 0, date: "", stats: {}, rtt: {}, errs: [] };
  S.snapCache = { v: out, t: Date.now() };
  return out;
}
