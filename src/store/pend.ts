import { S } from "../core/state";
import { HOOK } from "../core/hook";
import { cntDelta, cntUnsend } from "../core/counter";
import { eachLimit } from "../core/util";
import { spdSnapshot } from "../core/node-snapshot";

/* PEND 缓冲：连接侧只记增量，30 秒一批推给 Meter DO */

export const PEND_FLUSH_BYTES = 16 * 1024 * 1024; // 大文件传输时别频繁打 DO：DO 调用会吃这条连接的 CPU

/**
 * 功能：待上报账本（用户 → 未提交的字节/连接数）与上报节流器。
 *
 * 为什么要攒：每次上报都是一次 DO 调用，逐包上报会把连接的 CPU 烧光；
 * 攒到 16 MB 或有定时器到期再一次性推。失败必须回滚，否则字节账会凭空消失。
 */
export class PendingLedger {
  /**
   * 功能：取主用户 id（env.uuid/uuids 的第一个，去空白）。
   * @param env 环境变量
   * @returns 用户 id；没有时返回空串
   */
  id(env: Env): string {
    return String((env && (env.uuid || env.uuids)) || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
  }

  /**
   * 功能：把一段流量记进待上报账本。
   * @param id 用户 id
   * @param up 上行字节
   * @param down 下行字节
   * @param isNew 是否新连接（用于 conns 计数）
   * @returns 无
   */
  add(id: string, up: number, down: number, isNew?: boolean): void {
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

  /**
   * 功能：安排一次上报。已有定时器时，大流量触发的 delay=0 不能被之前的 30 秒定时器压住。
   * @param env 环境变量
   * @param delay 延迟毫秒，0 表示尽快
   * @returns 无
   */
  schedule(env: Env, delay?: number): void {
    if (S.tflush) {
      // 大流量触发 delay=0 时，不能被之前排好的 30 秒定时器压住
      if (delay !== 0) return;
      clearTimeout(S.tflush);
      S.tflush = null;
    }
    const d = delay === undefined ? S.pendMs : delay;
    S.tflush = setTimeout(() => {
      S.tflush = null;
      this.flush(env, true).catch(() => {});
    }, d);
  }

  /**
   * 功能：只有计数、没有字节时账本是空的，塞一个空批次把计数顶出去。
   * @param env 环境变量
   * @param id 用户 id
   * @returns 无
   */
  kick(env: Env, id: string | null): void {
    if (!env || !id || !env.METER) return;
    if (!S.pend.has(id)) S.pend.set(id, { up: 0, down: 0, conns: 0 });
    this.schedule(env, 0);
  }

  /**
   * 功能：把待上报账本 POST 给 DO。成功才 ack（否则 nack 以便重算），失败回滚流量。
   * @param env 环境变量
   * @param force 忽略节流
   * @returns 无
   */
  async flush(env: Env, force?: boolean): Promise<void> {
    if (!env || !env.METER || !S.pend.size) return;
    if (!force && Date.now() - S.pendAt < S.pendMs) return;
    S.pendAt = Date.now();
    const batch = [...S.pend.entries()];
    S.pend.clear();
    S.pendBytes = 0;
    let bad = 0;
    // 快照固定挂在主 uuid 的对象上：挂到"批次第一个"会挂到另一个用户，
    // 结果面板（读主 uuid）永远看不到更新。
    const primary = this.id(env);
    // 日计数只搭主 uuid 的车：主 uuid 这批没有流量时不要先 cntDelta（会推进基线），
    // 否则计数会永久丢；等主 uuid 下次有批次再一起发。
    const hasPrimary = !primary || batch.some(([bid]) => String(bid).toLowerCase() === primary);
    const cd = hasPrimary ? cntDelta() : {};
    const today = new Date().toISOString().slice(0, 10);
    let attached = false;
    let carried = false; // 这一批是否挂了 vt/hl/cl 增量
    let carriedCl = false;
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
          if (HOOK.vtDelta) {
            const vt = HOOK.vtDelta();
            if (vt.length) body.vt = vt;
            const hl = HOOK.healthDelta ? HOOK.healthDelta() : [];
            if (hl.length) body.hl = hl;
          }
          // 出口族事实（v8 §3 的 eg）搭同一趟车：只登记，等 DO 回 200 才 ack
          if (HOOK.egDelta) {
            const eg = HOOK.egDelta();
            if (eg.length) body.eg = eg;
          }
          const cl = this.clSnap(40);
          if (cl.length) body.cl = cl; // 连接观测（按节点聚合）：同理，离线可标定
          // 三样增量都只是「登记进请求体」，真正的提交要等 DO 回 200：
          // 这里以前顺手 S.cagg.clear()，一旦 POST 失败这 40 条观测就永久蒸发。
          carried = true;
          carriedCl = cl.length > 0;
        }
        const r = await stub.fetch("https://meter/add", {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error("do " + r.status);
        // 确认送达：判定/中继增量正式生效，连接观测这时才清
        if (carried && HOOK.syncAck) HOOK.syncAck();
        if (carriedCl) S.cagg.clear();
        S.doCalls += 1;
        S.meterCache.delete(id); // 刚推过增量，缓存立即失效，避免读数倒退
      } catch (e) {
        bad += 1;
        const cur = S.pend.get(id) || { up: 0, down: 0, conns: 0 };
        S.pend.set(id, { up: cur.up + d.up, down: cur.down + d.down, conns: cur.conns + d.conns });
        S.pendBytes += (d.up || 0) + (d.down || 0); // 回滚失败批次：健康页与立即刷新的判断要准
        if (mine) cntUnsend(cd); // 日计数搭车主批次失败 → 基线退回，下轮重发
        if (carried && HOOK.syncNack) HOOK.syncNack(); // 判定/中继增量退回，下轮重发
      }
    });
    // 自适应退避：失败了就把间隔翻倍（最多 60s），成功了慢慢降回 30s
    if (bad) S.pendMs = Math.min(S.pendMs * 2, 60000);
    else S.pendMs = Math.max(30000, Math.round(S.pendMs / 2));
  }

  /**
   * 功能：连接观测快照：把本 isolate 的按节点聚合转成可上报的行。
   * @param max 最多返回几行
   * @returns 按样本数降序的观测行（p50/p95 由最近 64 条首字节算）
   */
  clSnap(max = 40): ClRec[] {
    const out: ClRec[] = [];
    for (const [k, g] of S.cagg) {
      if (!g.n) continue;
      const v = g.v.slice().sort((a, b) => a - b);
      // 分位用「上取整」索引：样本少时也要给出一个真实观测值，而不是 0
      const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0);
      out.push({ k, n: g.n, ok: g.ok, p50: q(0.5), p95: q(0.95), dn: g.dn });
    }
    out.sort((a, b) => b.n - a.n);
    return out.slice(0, max);
  }
}

/** 进程内单例：待上报账本（每个 isolate 各自维护） */
export const PEND = new PendingLedger();

/**
 * 功能：取主用户 id（薄包装，委托 PEND.id）。
 * @param env 环境变量
 * @returns 用户 id；没有时返回空串
 */
export function primaryId(env: Env): string {
  return PEND.id(env);
}

/**
 * 功能：把一段流量记进待上报账本（薄包装，委托 PEND.add）。
 * @param id 用户 id
 * @param up 上行字节
 * @param down 下行字节
 * @param isNew 是否新连接
 * @returns 无
 */
export function pendAdd(id: string, up: number, down: number, isNew?: boolean): void {
  PEND.add(id, up, down, isNew);
}

/**
 * 功能：安排一次上报（薄包装，委托 PEND.schedule）。
 * @param env 环境变量
 * @param delay 延迟毫秒，0 表示尽快
 * @returns 无
 */
export function scheduleFlush(env: Env, delay?: number): void {
  PEND.schedule(env, delay);
}

/**
 * 功能：塞一个空批次把计数顶出去（薄包装，委托 PEND.kick）。
 * @param env 环境变量
 * @param id 用户 id
 * @returns 无
 */
export function kickFlush(env: Env, id: string | null): void {
  PEND.kick(env, id);
}

/**
 * 功能：把待上报账本 POST 给 DO（薄包装，委托 PEND.flush）。
 * @param env 环境变量
 * @param force 忽略节流
 * @returns 无
 */
export async function pendFlush(env: Env, force?: boolean): Promise<void> {
  await PEND.flush(env, force);
}

/**
 * 功能：连接观测快照（薄包装，委托 PEND.clSnap）。
 * @param max 最多返回几行
 * @returns 观测行列表
 */
export function clSnapshot(max = 40): ClRec[] {
  return PEND.clSnap(max);
}

