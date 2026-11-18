// 候选池的对外门面：KV 快照、游标、面板明细与落盘节流。
// 「谁能用」（存活表 / 探活冷却）搬去 ./alive，一轮维护搬去 ./scan —— 这个文件只剩读写口。

import { commitPool, ensurePool } from "./poolgen";

import { SEED_WRITE_GAP } from "../core/const";
import { capOf, p90Of, pFailOf, pStallOf, pctOf, scoreParts } from "../nodes/score";
import { SeedStore } from "./seed";
import { S } from "../core/state";
import { pxGet } from "./alive";

// 池子的代际读写搬去 ./poolgen（提交规则较长，混在本文件会顶到 560 行上限）；
// 存活表与探活冷却搬去 ./alive；一轮维护搬去 ./scan。这里全部原样再导出，
// 让 `../px/pool` 依旧是候选池的唯一入口（调用点与单测零改动）。
export { commitPool, ensurePool };
export { ALIVE_MAX, AliveBoard, ProbeCooldown, SEED_COLD_N, aliveList, bumpProbeBad, noteProbe, pxGet } from "./alive";
export { PoolScan, cronScan } from "./scan";

/* 代理节点：状态 / 信誉分桶 / 选择 / cron */

/**
 * 按需生成节点面板明细（只算传入的节点，避免为整张 nstat 白算分）。
 * @param {Iterable<string>} keys "host:port" 列表
 * @param {number} [limit] 最多算多少条（默认 64；整页节点列表要传实际条数）
 * @returns {object} "host:port" → 统计明细
 */
export function nsOf(keys: string[], limit = 64) {
  const m: Record<string, Record<string, number | string>> = {};
  let i = 0;
  for (const k of keys) {
    if (++i > limit) break;
    const s = S.nstat.get(k);
    if (!s) continue;
    // 有效样本数用衰减后的权重和，不是原始计数——面板上要跟「还有多少信息量」对齐
    const n = (s.okW || 0) + (s.failW || 0);
    // 两种模式各算一次分：面板把「同一节点在延迟/吞吐下分别值多少分」并排摆出来
    const lat = scoreParts(k, "lat"),
      tp = scoreParts(k, "tput");
    m[k] = {
      ok: s.ok || 0,
      fail: s.fail || 0,
      at: s.at || 0,
      // bps 取 p90（乐观上界，抽样剪枝靠它），bpsMed 取中位（人看着更像实际）
      bps: Math.round(p90Of(s) || 0),
      bpsMed: Math.round(pctOf(s, 0.5) || 0),
      bpsCap: Math.round(capOf(s) || 0),
      n: Math.round(n),
      bytes: Math.round(s.bytesDown || 0),
      pFail: Math.round(pFailOf(s) * 1000) / 1000,
      pStall: Math.round(pStallOf(s) * 1000) / 1000,
      lat: Math.round(lat.score),
      tput: Math.round(tp.score),
      e10: Math.round(tp.e10Ms),
      confB: Math.round(tp.confB * 1000) / 1000,
      nEff: Math.round(tp.nEff * 10) / 10,
      latN: Math.round(lat.latN * 10) / 10,
      gate: tp.gate,
    };
  }
  return m;
}

/**
 * 改内存里的当前节点（不落盘）。
 *
 * 曾经还带一个 `alive` 参数、可以把整个 `S.alive` 换掉 —— 全仓唯一调用者是
 * `/<uuid>/debug?cur=`，只传 `cur`，那条分支从来没被走过（7.173 删掉）。
 * 换池子要走 `commitPool`：它管代际号、锚点与缩水守卫，直接替换内存会跟 KV 脱节。
 * @param env Worker 环境
 * @param patch 只认 `cur`
 * @returns 改完之后的状态快照
 */
export async function pxSet(env: Env, patch: { cur?: string | null }) {
  if (!patch) return pxGet(env);
  if (typeof patch.cur === "string") {
    S.curs.tput = patch.cur;
    S.curs.lat = patch.cur;
  }
  return pxGet(env);
}

/**
 * 功能：落盘：只写信誉表（池子走 `commitPool`），cron 每轮一次。
 * @param env Worker 环境
 * @param force 跳过节流立即写
 * @returns 写入结果（`skipped` 表示这次不需要写）
 */
export async function flushPx(env: Env, force?: boolean) {
  if (!env || !env.STATS) return { ok: true, skipped: true };
  if (!force && !S.seedDirty) return { ok: true, skipped: true };
  if (!force) {
    const last = Math.max(S.seed.ts || 0);
    // 两次落盘至少隔 SEED_WRITE_GAP：KV 写额度是硬指标，脏数据可以等下一轮
    if (Date.now() - last < SEED_WRITE_GAP) return { ok: true, skipped: true };
  }
  S.nsWriteAt = Date.now();
  return SeedStore.write(env, S.colo ? undefined : true, !!force);
}
