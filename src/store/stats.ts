import { S } from "../core/state";
import { PEND, pendAdd } from "./pend";
import { getSnap, usageSnapGet } from "./snapshot";
import { cnt } from "../core/counter";
import { doFetch, meterGet } from "./meter-client";

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
    const r = await doFetch(env, PEND.id(env) || id, "https://meter/cnt");
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

/**
 * 功能：记流量：先记进全局待上报账本，再落到本地统计。
 * @param id 用户 id
 * @param up 上行字节
 * @param down 下行字节
 * @param isNewConn 是否新连接
 * @returns 无
 */
export function statBump(id: string, up: number, down: number, isNewConn?: boolean) {
  if (!id) return;
  // 先记账本：本地 S.stats 只是面板用的即时视图，真正计费在 DO 侧，
  // 顺序反了会出现「面板有量、账单没有」
  pendAdd(id, up, down, isNewConn); // 全局帐本（DO）
  let s = S.stats.get(id);
  if (!s) {
    s = { up: 0, down: 0, conns: 0, first: Date.now(), last: Date.now() };
    S.stats.set(id, s);
  }
  s.up += up || 0;
  s.down += down || 0;
  // snapBytes 是「自上次快照以来」的增量，落盘后清零，用来判断何时该写快照
  S.snapBytes += (up || 0) + (down || 0);
  if (isNewConn) s.conns += 1;
  s.last = Date.now();
}

/**
 * 功能：读用量：合并持久值 + 本地增量 + 待上报增量。
 *
 * 三层优先级：Meter DO（全网络唯一账本）→ KV 快照（没绑 METER 时）→ 本地即时视图。
 * 只有 DO 那一层会额外做一次「DO 被重置就从 KV 回填」，回填结果要原样报给面板
 * （`persisted`/`seed`），否则「回填失败」与「这个人真没用过流量」长得一模一样。
 * @param env 环境变量
 * @param id 用户 id
 * @returns {up, down, conns, todayUp, todayDown, firstSeen, lastSeen, backend, persisted, seed}
 */
export async function readStats(env: Env, id: string) {
  const local = S.stats.get(id) || { up: 0, down: 0, conns: 0, first: 0, last: 0 };
  const pend = S.pend.get(id) || { up: 0, down: 0, conns: 0 };
  const total = await meterGet(env, id);
  if (!total) return kvView(env, id, local);
  const seed = await seedFromSnap(env, id, total);
  return doView(id, seed.total, pend, local, seed.seed);
}

/**
 * 功能：DO 被重置过（重建脚本会把命名空间一起删掉）时，用 KV 快照回填一次。
 *
 * 判据是「DO 里是空的、KV 快照里却有这个人的历史用量」—— 只在这一个状态上回填。
 * 回填失败必须留痕（`statsSeedFail` + `seed: "fail"`），否则面板把 999 显示成 0，
 * 而且和「这个用户真的没用过流量」完全同形（7.243/7.244 是同一族）。
 * @param env 环境变量
 * @param id 用户 id
 * @param total 当前 DO 读数（只有空账本才会回填）
 * @returns 回填后的 DO 读数，以及回填结果（`ok` 成功 / `fail` 失败 / `none` 不需要回填）
 */
async function seedFromSnap(
  env: Env,
  id: string,
  total: NonNullable<Awaited<ReturnType<typeof meterGet>>>,
): Promise<{ total: NonNullable<Awaited<ReturnType<typeof meterGet>>>; seed: "ok" | "fail" | "none" }> {
  if (total.up || total.down || total.conns) return { total, seed: "none" };
  const snap = await usageSnapGet(env);
  const row = snap && snap.users && snap.users[id];
  if (!row) return { total, seed: "none" };
  try {
    const r = await doFetch(env, id, "https://meter/seed", { method: "POST", body: JSON.stringify(row) });
    if (!r.ok) {
      cnt("statsSeedFail");
      return { total, seed: "fail" };
    }
    // 回填成功：DO 现在返回的是「历史 + 0」，顺手把缓存刷成同一个值
    const next = await r.json();
    S.meterCache.set(id, { v: next, t: Date.now() });
    return { total: next, seed: "ok" };
  } catch (e) {
    cnt("statsSeedFail");
    return { total, seed: "fail" };
  }
}

/**
 * 功能：把 DO 的总账、待上报增量与本 isolate 的即时增量合成一份用量视图。
 *
 * "今日"必须真的按今天算：当天没有任何流量时 DO 里的 `d` 还停在昨天，`dU`/`dD`
 * 也是昨天的数，直接展示会让面板把昨天当今天。
 * @param id 用户 id
 * @param total DO 里的总量
 * @param pend 待上报增量（还没进 DO 的那部分）
 * @param local 本 isolate 的即时增量
 * @param seed 回填结果（`fail` 时 `persisted` 为 false）
 * @returns 面板/订阅用的一份用量
 */
function doView(
  id: string,
  total: NonNullable<Awaited<ReturnType<typeof meterGet>>>,
  pend: { up: number; down: number; conns: number },
  local: { up: number; down: number; conns: number; first: number; last: number },
  seed: "ok" | "fail" | "none",
) {
  const day = new Date().toISOString().slice(0, 10);
  const sameDay = !total.d || total.d === day; // 老数据没有 d 字段，按当天处理
  return {
    id,
    up: (total.up || 0) + pend.up,
    down: (total.down || 0) + pend.down,
    conns: (total.conns || 0) + pend.conns,
    // 当日量 = DO 里的当日累计 + 还没推上去的增量
    todayUp: (sameDay ? total.dU || 0 : 0) + pend.up,
    todayDown: (sameDay ? total.dD || 0 : 0) + pend.down,
    firstSeen: total.first || local.first || null,
    lastSeen: Math.max(total.ts || 0, local.last) || null,
    isolateLocal: { up: local.up, down: local.down, conns: local.conns },
    backend: "do",
    persisted: seed !== "fail",
    seed,
  };
}

/**
 * 功能：没绑 METER 时的回退视图 —— KV 快照 + 本 isolate 的即时增量。
 *
 * 快照本身就是「当日」口径（`flushSnap` 跨天会重置），所以今日量就是总量。
 * @param env 环境变量
 * @param id 用户 id
 * @param local 本 isolate 的即时增量
 * @returns 面板/订阅用的一份用量
 */
async function kvView(env: Env, id: string, local: { up: number; down: number; conns: number; first: number; last: number }) {
  // 读失败与「没有这条记录」在面板上是同一个 0，但 `persisted` 必须如实反映
  // （这里读不到就报 false，让调用方知道这是回退值而不是账本值）
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
    // 没绑 DO 时，快照本身就是「当日」口径（flushSnap 跨天会重置）
    todayUp: (base.up || 0) + local.up,
    todayDown: (base.down || 0) + local.down,
    firstSeen: base.first || local.first || null,
    lastSeen: Math.max(base.last || 0, local.last) || null,
    isolateLocal: { up: local.up, down: local.down, conns: local.conns },
    backend: "kv",
    persisted: !!stored,
    seed: "none" as const,
  };
}
