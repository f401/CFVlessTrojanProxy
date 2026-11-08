import { logErr } from "../nodes/metrics";
import { S } from "../core/state";
import { cronScan, flushPx } from "../px/pool";
import { flushSnap, pendFlush, restoreUsage, usageSnapGet, usageSnapWrite } from "../store/index";

/**
 * 定时任务（每 30 分钟）：探活候选池 → 推计量 → 落 seed → 续回并写用量快照。
 * 每轮每类最多写一次 KV，避免额度被定时任务吃掉。
 */
export async function runCron(env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil((async () => {
    try {
      await cronScan(env);
    } catch (e: any) {
      logErr(`cron: ${e && e.message ? e.message : e}`);
    }
    // 定时持久化的唯一入口：每轮 cron 最多各写 1 次
    try { await pendFlush(env, true); } catch (e: any) {}
    // cronScan 内部已经落过一次 seed（且自带 55 分钟节流），这里只补写脏数据
    try { if (S.seedDirty) await flushPx(env); } catch (e: any) {}
    try {
      // 先把快照续回 DO（重建脚本后不会从 0 开始），再写新快照
      const snap = await usageSnapGet(env);
      if (snap && snap.users) {
        for (const id of Object.keys(snap.users)) await restoreUsage(env, id, snap);
      }
      await usageSnapWrite(env);
    } catch (e: any) {}
    // 不传 force：让 flushSnap 走「1h/2h + 全局 45 分钟闸门」的节奏
    try { await flushSnap(env); } catch (e: any) {}

  })());
}
