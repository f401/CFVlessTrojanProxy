import { S } from "../core/state";
import { RTT_MAX, SC } from "../core/const";
import { eachLimit } from "../core/util";
import { cnt } from "../core/counter";
import { kvGet, kvGetStrict, kvSet } from "./kv";
import { meterGet } from "./meter-client";

/* 快照：用量灾备（KV）+ 合成快照 */

export const USAGE_SNAP_KEY = "usage:snap";
export const FLUSH_MIN_MS = 3600000; // 1 小时（且累计 ≥2MB 才写）
export const FLUSH_DIRTY = 2 * 1024 * 1024; // 脏字节门槛
export const FLUSH_MAX_MS = 7200000; // 最迟 2 小时必落一次
export const FLUSH_GAP = 2700000; // 全局闸门：45 分钟内已有别的 isolate 写过就不再写
export const SNAP_TTL = 300000;

/**
 * 功能：读用量快照（KV 里的 USAGE_SNAP_KEY）。
 * @param env 环境变量（STATS 为 KV）
 * @returns 快照对象；不存在或读失败返回 null
 */
export async function usageSnapGet(env: Env) {
  try {
    return (await kvGet<UsageSnap>(env, USAGE_SNAP_KEY)) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 功能：写用量快照。读失败时直接跳过——拿空表覆盖会把别的用户的历史用量抹掉。
 * @param env 环境变量
 * @param users 用户表（必须传：本地没有"全部用户"的表，不传等于什么都不写 —— v7.142 删掉
 *   门面方法就是因为 `usageSnapWrite(env)` 这个形态永远写不出东西，这里如实写清）
 * @returns 无
 */
export async function usageSnapWrite(env: Env, users?: UserRec[]) {
  if (!env.STATS || !env.METER) return;
  // 读失败就跳过：拿空表继续写会把别的用户的历史用量覆盖掉
  let prev: UsageSnap;
  try {
    prev = (await kvGetStrict<UsageSnap>(env, USAGE_SNAP_KEY)) || ({ users: {}, ts: 0 } as UsageSnap);
  } catch (e) {
    return;
  }
  // 灾备快照，2 小时一次足够（cron 是 30 分钟一轮，别每轮都写一遍）
  if (Date.now() - (prev.ts || 0) < 2 * 3600e3) return;
  const list = users || [];
  // 读一个用户就是一次 DO 子请求，而一次调用总共只有 50 个（cron 还要花在 refill / restore 上）。
  // 超出的那批不读，但**必须把上一次快照里的数值原样搬过来** —— 直接跳过会让它们从灾备
  // 快照里消失，DO 重建之后再也恢复不回来（v7.174 之前就是这样：用户一多，尾部的
  // meterGet 全部失败，那些人的历史用量永远停在某一天，且没有任何计数）。
  const head = list.slice(0, SC.SNAP_MAX);
  const tail = list.slice(SC.SNAP_MAX);
  if (tail.length) cnt("snapSkip", tail.length);
  const out: UsageSnap = { ts: Date.now(), users: {} };
  // 同一个 num 不要每个用户重新建一次闭包
  const num = (x: unknown) => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const today = new Date().toISOString().slice(0, 10);
  await eachLimit(head, 8, async (u) => {
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
  // 没读的那批只搬旧值：不给它们编新数字（恢复路径读的也是「上次真的读到的」）
  for (const u of tail) {
    const old = (prev.users || {})[u.id];
    if (!old) continue;
    out.users[u.id] = { ...old };
  }
  if (!Object.keys(out.users).length) return;
  try {
    await kvSet(env, USAGE_SNAP_KEY, out, { expirationTtl: 86400 * 90 });
  } catch (e) {
    /* 额度耗尽：下次再写 */
  }
}

/** 每轮 cron 最多恢复的用户数：每次恢复 = 1 个 DO 子请求，一次调用总共只有 50 个（还要留给 refill/tfb/DoH） */
export const RESTORE_MAX = 12;

/**
 * 功能：从快照用户里挑出本轮要恢复的那一批 —— 超过上限时按小时窗口轮转，避免「前 12 个永远恢复、后面的永远不恢复」。
 * @param {string[]} ids 快照里的用户 id 列表
 * @param {number} max 本轮上限（默认 RESTORE_MAX）
 * @param {number} now 当前时间（默认 Date.now，便于测试注入）
 * @returns {string[]} 要恢复的 id 列表（长度 ≤ max，无重复）
 */
export function restorePick(ids: string[], max = RESTORE_MAX, now = Date.now()): string[] {
  if (!Array.isArray(ids) || ids.length <= max) return Array.isArray(ids) ? ids.slice() : [];
  // 起点按小时平移：否则用户数一多，排在后面的用户永远拿不到恢复机会
  const start = Math.floor(now / 3600000) % ids.length;
  const out: string[] = [];
  for (let k = 0; k < max; k++) out.push(ids[(start + k) % ids.length]);
  return out;
}

/**
 * 功能：把某用户已上报的用量恢复进本地状态（换 isolate 后不让客户端看到「用量归零」）。
 * @param env 环境变量
 * @param id 用户 id
 * @param snap 预读的快照（可选，避免重复读 KV）
 * @returns 恢复后的用量记录；无快照返回 null
 */
export async function restoreUsage(env: Env, id: string, snap?: UsageSnap) {
  if (!env || !env.METER) return null;
  // 允许调用方把已读到的快照传进来，避免同一请求里二次读 KV
  const s = snap || (await usageSnapGet(env));
  const u = s && s.users && s.users[id];
  if (!u) return null;
  try {
    // 把历史用量推回 DO：DO 可能被回收过，内存计数已经丢了；
    // 推失败就返回 null（调用方按「无记录」处理），绝不能编造用量
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

/**
 * 功能：合并写快照的总入口。带两道节流：全局闸门 + 最小间隔，避免每个 isolate 各写各的把写次数写爆。
 * @param env 环境变量
 * @param force 跳过节流立即写
 * @returns 无
 */
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
  // 全局闸门失败/跳过时不能每条连接都再去读一次 KV：5 分钟内只检查一次。
  // force 必须绕过它，否则 force 就是个死开关（v7.201：强制落盘连续调两次，第二次被
  // 这句静默吃掉，调用方以为已经写进 KV）。
  if (!force && now - S.snapChecked < 5 * 60000) return;
  S.snapChecked = now;
  // 同一 isolate 只允许一个落盘在飞：连接收尾会并发调 flushSnap，
  // 没有这个闩时 50 条连接同时关闭就可能各写一次 KV（写额度 1000/天）。
  if (S.snapBusy) return;
  S.snapBusy = true;
  try {
    await writeSnap(env, now, !!force);
  } finally {
    S.snapBusy = false;
  }
}

/**
 * 功能：真正合并并写入快照（把 DO 与本地读数合并后落 KV）。
 * @param env 环境变量
 * @param now 当前时间戳
 * @param force 跳过 45 分钟全局闸门（强制落盘时用）
 * @returns 无
 */
async function writeSnap(env: Env, now: number, force = false): Promise<void> {
  // 第二个闸门是"全局"的：每个 isolate 各写各的会让写次数随实例数线性增长
  // （实测 8 个 isolate × 24 次/天 = 192 次）。快照本身就是合并写入，
  // 45 分钟内别人写过就跳过，自己的增量留在内存里下一轮合并，一条不丢。
  // 这里必须 fresh：缓存里的 ts 可能已经过时 5 分钟，会误判"该写了"。
  // 这里必须 fresh + 严格：读失败时不能当空快照继续写，否则会把别的
  // isolate 的当日统计/错误整份覆盖掉。
  let prev: SnapDoc;
  try {
    prev = (await kvGetStrict<SnapDoc>(env, "snap")) || { v: 1, ts: 0, date: "", stats: {}, rtt: {}, errs: [] };
  } catch (e) {
    return;
  }
  // force 同样要绕开全局闸门：这是"现在就要写"的意思，被挡掉等于没写（调用方拿不到任何反馈）
  if (!force && now - (prev.ts || 0) < FLUSH_GAP) {
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

/**
 * 功能：取快照（带 TTL 缓存，fresh 可强制刷新）。
 *
 * 读失败必须**抛错**，不能返回空快照：`SNAP_TTL` 是 5 分钟，一旦把「KV 抖动」
 * 当成「还没有快照」，`/<uuid>/logs` 的错误列表、`readStats` 的 KV 回退、
 * `loadRtt` 的延迟学习会在 5 分钟里一致地骗人（`loadRtt` 还会顺带把 `S.rttMiss`
 * 压上 10 分钟，KV 恢复了也读不到）。三个调用方本来就都有 try/catch，抛出去各自降级。
 * @param env 环境变量
 * @param fresh 忽略缓存
 * @returns 快照对象；键不存在时是空表，**读失败会抛错**（不进缓存）
 */
export async function getSnap(env: Env, fresh?: boolean) {
  if (!fresh && S.snapCache.v && Date.now() - S.snapCache.t < SNAP_TTL) return S.snapCache.v;
  // 严格读：抛错路径不碰 S.snapCache，下一次调用会重新打 KV
  const v = await kvGetStrict<SnapDoc>(env, "snap");
  const out: SnapDoc = v || { v: 1, ts: 0, date: "", stats: {}, rtt: {}, errs: [] };
  S.snapCache = { v: out, t: Date.now() };
  return out;
}

