import { S } from "../core/state";
import { cntDelta, cntUnsend } from "../core/counter";
import { eachLimit } from "../core/util";
import { spdSnapshot } from "../core/node-snapshot";

/* PEND 缓冲：连接侧只记增量，30 秒一批推给 Meter DO */

export const PEND_FLUSH_BYTES = 16 * 1024 * 1024; // 大文件传输时别频繁打 DO：DO 调用会吃这条连接的 CPU

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
