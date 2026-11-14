import { eachLimit, errMsg } from "../core/util";

import { logErr } from "../nodes/metrics";
import { S } from "../core/state";
import { cnt } from "../core/counter";
import { cronScan, flushPx } from "../px/pool";
import { planRound } from "../route/budget";
import { runRound } from "../route/round";
import { edgeScan } from "../route/edge";
import { runTfb } from "../route/tfb";
import { SEL } from "../px/selector";
import { flushSnap, pendFlush, restoreUsage, usageSnapGet, usageSnapWrite } from "../store/index";
import { loadUsers } from "../proxy/protocol";

/**
 * 定时任务（每 30 分钟）：探活候选池 → 推计量 → 落 seed → 续回并写用量快照。
 * 每轮每类最多写一次 KV，避免额度被定时任务吃掉。
 * cronBusy：Cron Triggers 偶发重投递（同事件 30 分钟内可能来两次），或者手动
 * refresh=1 和 cron 撞车；两轮 cronScan 同时跑会双写 seed、双跑探活。
 */
export async function runCron(env: Env, ctx: ExecutionContext): Promise<void> {
  // 闸门检查在 waitUntil 之前：忙时连任务都不排，而不是排一个立即返回的空任务。
  // 同一 isolate 内 JS 单线程，check + set 之间不会被打断。
  if (S.cronBusy) return;
  S.cronBusy = true;
  ctx.waitUntil(
    (async () => {
      try {
        await cronOnce(env);
      } finally {
        S.cronBusy = false;
      }
    })(),
  );
}

/** 站点 → 上次 IP 级探测时间（每站点 10 分钟最多一次）。 */
const TFB_AT: Map<string, number> = new Map();

/** 站点 → 已轮换批次；30 分钟后重置，最多 3 批（≈6 条通道）。 */
const TFB_N: Map<string, number> = new Map();

/** 每轮最多挑一个「最近被怀疑」的站点做 2 条中继的实测（1 DO 请求 + 2 子请求）。 */
const TFB_V: Map<string, string> = new Map();
/**
 * 功能：每轮挑一个待验站点跑一批 tfb（每站点 30 分钟最多 3 批，不写 KV）。
 * @param env 环境变量
 * @returns 无
 */
async function tfbRound(env: Env): Promise<void> {
  const now0 = Date.now();
  // 站点过期就三张表一起清，避免 TFB_AT/TFB_N 只增不减
  for (const [h, t] of S.needPx) if (t <= now0) { S.needPx.delete(h); TFB_AT.delete(h); TFB_N.delete(h); TFB_V.delete(h); }
  const now = Date.now();
  for (const [host, until] of S.needPx) {
    if (until <= now) continue;
    if (now - (TFB_AT.get(host) || 0) < 600000) continue;
    if (now - (TFB_AT.get(host) || 0) > 1800000) TFB_N.set(host, 0);
    if ((TFB_N.get(host) || 0) >= 3) continue;
    TFB_N.set(host, (TFB_N.get(host) || 0) + 1);
    TFB_AT.set(host, now);
    cnt("tfb");
    await runTfb({ env } as unknown as Parameters<typeof runTfb>[0], host, 2);
    return;
  }
}

/**
 * 功能：cron 主流程：算预算 → 准入复测 → 站点探测 → 入口扫描 → 快照。
 * @param env 环境变量
 * @returns 无
 */
async function cronOnce(env: Env): Promise<void> {
  try {
    // 一轮 cron 的子请求预算先算清：准入（池子）、判定（目标 x 通道）、入口（客户端→边缘）
    const plan = planRound(S.pool.length, S.alive.size);
    await cronScan(env, plan.adm);
    await runRound(plan);
    await edgeScan(env, plan.edge);
    await tfbRound(env);
    SEL.afterScan(env);
  } catch (e) {
    logErr(`cron: ${errMsg(e)}`);
  }
  // 定时持久化的唯一入口：每轮 cron 最多各写 1 次
  try {
    await pendFlush(env, true);
  } catch (e) {}
  // cronScan 内部已经落过一次 seed（且自带 55 分钟节流），这里只补写脏数据
  try {
    if (S.seedDirty) await flushPx(env);
  } catch (e) {}
  try {
    // 先把快照续回 DO（重建脚本后不会从 0 开始），再写新快照。
    // 用户一多时 50 个 /set 同时飞出去会把 cron 的 CPU 拉满，限 8 并发。
    const snap = await usageSnapGet(env);
    if (snap && snap.users) {
      await eachLimit(Object.keys(snap.users), 8, (id) => restoreUsage(env, id, snap).then(() => undefined));
    }
    const users = await loadUsers(env);
    // 读 KV 失败且没有完整缓存时 list 可能缺托管用户：此时写快照会把
    // 这些用户的历史用量整份抹掉，宁可这一轮不写
    if (users.ok !== false) await usageSnapWrite(env, users.list);
  } catch (e) {}
  // 不传 force：让 flushSnap 走「1h/2h + 全局 45 分钟闸门」的节奏
  try {
    await flushSnap(env);
  } catch (e) {}
}

