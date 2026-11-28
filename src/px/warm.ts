import { NODE_MEMORY } from "../core/node-memory";
// 冷 isolate 起搏：池子里一条存活中继都没有时，就地探几个候选。
// 与 pool.ts 分开放，是因为 pool.ts 已经贴着单文件 560 行的架构上限。
import { SC } from "../core/const";
import { isCfIp } from "../core/net";
import { NodeStatsTable } from "../nodes/score";
import { chunks, probeProxy } from "./probe";
import { bumpProbeBad, COOLDOWN, ensurePool, noteProbe } from "./pool";

/** 冷启动起搏的节流时钟：7.369 起从 AppState 下放，只有本模块读写 */
export class WarmPacer {
  /** 上次起搏探活的时刻（节流：别把免费计划的名额打光） */
  lastProbeAt = 0;
}

/** 冷启动起搏时钟的进程内唯一实例 */
export const WARM = new WarmPacer();

/**
 * 功能：冷 isolate 的按需起搏 —— 一条存活中继都没有时，就地探几个候选写进 `NODE_MEMORY.alive`。
 *       没有它，新机房（或被回收过的 isolate）要等 30 分钟一轮的 cron 才有中继可用，
 *       而这段时间里对 CF 托管站点的每个请求都只能直连（实测必 403）。
 * @param env 环境绑定
 * @param n 本轮最多探几个（默认 6，等于免费计划的并发上限）
 * @returns 本次探活成功并写进 `NODE_MEMORY.alive` 的条数
 */
export async function seedAlive(env: Env, n = SC.PROBE_CONC): Promise<number> {
  const pool = await ensurePool(env);
  if (!pool.length || NODE_MEMORY.alive.size) return 0;
  const now = Date.now();
  // 节流 5 分钟：冷启动只该付一次代价，不能让每个冷请求都烧 6 条连接。
  if (now - (WARM.lastProbeAt || 0) < 300000) return 0;
  WARM.lastProbeAt = now;
  const cand = pool.filter((c) => !COOLDOWN.skip(c.h + ":" + c.p));
  // 非 CF 网段优先：CF 边缘地址做中继时对 CF 托管站点是 CF→CF，改判不了地址族。
  const nonCf = cand.filter((c) => !isCfIp(c.h));
  const pick = (nonCf.length ? nonCf : cand).slice(0, Math.max(1, n));
  let got = 0;
  for (const seg of chunks(pick, SC.PROBE_CONC)) {
    const part = await Promise.all(seg.map((c) => probeProxy(c.h, c.p).catch(() => null)));
    for (let j = 0; j < seg.length; j++) {
      const x = part[j];
      noteProbe(x);
      const k = seg[j].h + ":" + seg[j].p;
      bumpProbeBad(k, !!(x && !x.bad));
      if (!x || x.bad) continue;
      NODE_MEMORY.alive.set(k, { h: x.h, p: x.p, cc: (x as { cc?: string }).cc || "", ms: x.ms });
      // 不要把探活的 RTT 写进「真实首字节」的两个矩（nsLatency）：它是 ClientHello→ServerHello
      // 到中继的往返，比经中继的 TTFB 小一个数量级。写进去以后，第一条真实请求会被当成
      // 成倍的延迟回归 —— nsLatency 里的 CUSUM 立刻越线，把这个刚起搏出来的中继冻结 60 秒，
      // 而冷启动时它恰恰是唯一能用的那条。排序并不缺这个数：优先延迟读 a.ms（上一行的 ms），
      // tcp/tls 由 nsProbe 记。
      NodeStatsTable.nsProbe(k, x.ms, x.tcp || x.ms, x.tls || 0);
      got++;
    }
  }
  return got;
}
