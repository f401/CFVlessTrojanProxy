import { eachLimit, errMsg } from "../core/util";

import { logErr } from "../nodes/metrics";
import { S } from "../core/state";
import { cronScan, flushPx } from "../px/pool";
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

async function cronOnce(env: Env): Promise<void> {
  try {
    await cronScan(env);
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
