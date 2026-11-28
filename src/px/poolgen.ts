import { ISOLATE } from "../core/state";
import { POOL_MEMORY } from "./pool-memory";
import { errMsg } from "../core/util";

import { logErr } from "../nodes/metrics";
import { NodeStatsTable } from "../nodes/score";
import { kvGetStrict, kvSet } from "../store/index";
import { PX_TTL, SEED_KEY } from "./const";
import { POOL_MAX } from "./probe";
import { SEED_STORE } from "./seed";

/* 候选池的代际读写：单独一层，因为提交规则（跨 isolate 单调 + 两阶段锚点）本身就是一段逻辑 */

/**
 * 功能：取候选池 —— 内存 → KV(当前代际键) → 空；空时由 cronScan 触发重建。
 * @param env Worker 环境
 * @returns {Promise<PoolEntry[]>} 候选池（已按 POOL_MAX 截断）
 */
export async function ensurePool(env: Env) {
  // 内存空 → 读种子表拿当前代际号，再按代际键取池子；
  // 代际号是两阶段提交的锚点，读一个键比扫 px:pool:* 前缀便宜得多
  if (POOL_MEMORY.rows.length) return POOL_MEMORY.rows;
  await SEED_STORE.read(env);
  const gen = SEED_STORE.document.poolGen || 0;
  // 没有代际号说明从没成功提交过池子：返回空，交给 cronScan 去拉源重建
  if (!gen) return [];
  try {
    const v = await kvGetStrict<PoolEntry[]>(env, "px:pool:" + gen);
    if (Array.isArray(v) && v.length) {
      // 截断到当前上限：KV 里的池子可能比配置的 POOL_MAX 大（上限被调小过）
      POOL_MEMORY.adopt(v.slice(0, POOL_MAX), gen);
      NodeStatsTable.invalidateRank();
    }
  } catch (e) {
    // 读失败与「还没有池子」在调用方看来都是空池，但前者要留证据：
    // 静默吞掉会让 KV 故障表现为「一直在重建池子」，排查时看不到任何线索。
    // 必须用严格读：普通 kvGet 把 get 抛错吞成 null，那样 try/catch 永远不会进 catch，
    // 这条 logErr 就是一句写在注释里的承诺（v7.192）。
    logErr("pool gen " + gen + " " + String(errMsg(e)).slice(0, 60), "kv");
  }
  return POOL_MEMORY.rows;
}

/**
 * 功能：两阶段提交新候选池 —— 先写新代际键，成功后再把锚点写回 seed。
 * @param env Worker 环境
 * @param fresh 新候选（会在落盘前按 POOL_MAX 截断）
 * @param allowShrink 允许池子变小（手动 refill 时才传 true）
 * @returns {Promise<{ok:boolean,gen?:number,n?:number,anchored?:boolean,reason?:string}>} 结果
 */
export async function commitPool(env: Env, fresh: PoolEntry[], allowShrink = false) {
  // 路由手动 refill 可能把多个源的合并结果直接传进来；落 KV/进内存前统一截断
  fresh = fresh.slice(0, POOL_MAX);
  const newN = fresh.length;
  if (!newN) return { ok: false, reason: "empty" };
  // 代际号是跨 isolate 的锚点，而本地的 POOL_MEMORY.generation 只代表「这台见过的最大的号」，
  // 可能落后半小时：直接 +1 会撞上别的 isolate 已经提交过的号，
  // 结果用自己的（可能更小、更旧的）池子覆盖掉更新的那一代。
  // 所以写之前严格读一次 KV 锚点，号与裁剪判断都以它为准。
  let anchorGen = 0;
  let anchorN = 0;
  try {
    const v = await kvGetStrict<{ poolGen?: number; poolN?: number } | null>(env, SEED_KEY);
    anchorGen = Number(v && v.poolGen) || 0;
    anchorN = Number(v && v.poolN) || 0;
  } catch (e) {
    // 读不到锚点就不提交：盲写一个号可能落在别人的代际上，那比这轮不换池更糟。
    // 池子会由下一轮 cron 重试（调用方本来就按 TTL 反复尝试）。
    logErr("pool anchor read " + String(errMsg(e)).slice(0, 60), "kv");
    return { ok: false, reason: "anchor read" };
  }
  // 池子「缩水 60%」要比所有已知规模里最大的那个：本地 POOL_MEMORY.rows 可能停在好几代以前的
  // 小池子上（内存优先命中时不会跟随代际更新），只比它就会把 300 → 80 这种真缩水当成
  // 正常重建放过去，把别的 isolate 刚提交的大池子覆盖掉。锚点是跨 isolate 的真相。
  const oldN = Math.max(POOL_MEMORY.rows.length, anchorN, Number(SEED_STORE.document.poolN) || 0);
  if (!allowShrink && oldN && newN < oldN * 0.6) {
    return { ok: false, reason: `rejected ${newN} < 60% of ${oldN}` };
  }
  const gen = Math.max(POOL_MEMORY.generation || 0, Number(SEED_STORE.document.poolGen) || 0, anchorGen) + 1;
  try {
    await kvSet(env, "px:pool:" + gen, fresh, { expirationTtl: PX_TTL });
  } catch (e) {
    return { ok: false, reason: "kv " + String(errMsg(e)).slice(0, 60) };
  }
  POOL_MEMORY.adopt(fresh, gen, Date.now());
  NodeStatsTable.invalidateRank();
  SEED_STORE.document.poolGen = gen;
  // 第二阶段：把锚点写回 seed。写失败时新池子只活在本 isolate 里（冷启动会退回旧代际），
  // 所以失败要重试一次，还不成就记进错误环 —— 不能像以前那样返回 ok 就当已落盘。
  let w = await SEED_STORE.write(env, ISOLATE.colo ? undefined : true, true);
  if (!w.ok) {
    w = await SEED_STORE.write(env, ISOLATE.colo ? undefined : true, true);
    if (!w.ok) logErr("pool anchor " + String(w.err || "write").slice(0, 60), "kv");
  }
  return { ok: true, gen, n: newN, anchored: w.ok };
}
