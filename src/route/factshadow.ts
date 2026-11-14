// 写入决策器的影子模式（v8 §3.2 的接线第 1 步）：只算「本会写什么」，一个字节都不写。
//
// 为什么先影子：v8 的 `commitFact` 有 19 条表驱动向量证明「规则自洽」，但真实流量的形状
// （`down` 分布、`life` 分布、同窗口对照出现频率）只有线上才有。直接换成 v8 写入路径，
// 一旦某条规则的实际命中率和仿真不同，判定表会在一小时内被写歪，而线上没有对照组可比。
//
// 影子模式的产出：一条连接的「观测 → 决策」分布（`ps/blk/dead/none` + 拒绝理由码）。
// 只要线上 `blk`（`would`）长期为 0，就说明「业务 403 不写封锁」这条在真实流量里站得住。
import { cnt } from "../core/counter";
import { S } from "../core/state";
import type { TrafficEvt } from "../core/hook";
import { commitFact, type FactCtx, type FactObs } from "./commitfact";

/** 影子统计的一次快照 */
export interface FactShadowSnap {
  /** 观测总数 */
  n: number;
  /** 「本会写」的分布：eg / dead / blk / ps / none */
  would: Record<string, number>;
  /** 拒绝理由码分布（`ok` 表示会写） */
  why: Record<string, number>;
}

/**
 * 功能：把一条真实连接的收尾事件翻译成 v8 观测（只用于影子统计）。
 *
 * 已知失真（必须在报告里说明，不能当成等价）：
 * · `TrafficEvt` 没有 HTTP 状态码，这里用 `ok` 合成（200 / 0）——所以 `429` 与 4xx 的区分
 *   在影子阶段是缺失的，`R_429_BACKOFF` 永远不会命中；
 * · 没有「同窗口其他通道」的观测缓存，`peers` 恒为空，于是 `blk` 只会命中
 *   `R_NO_BIG_PEER`，不会真的算出「会写封锁」；
 * · `bigTypical` 还没有落盘（`S.bigByHost` 只存时间），这里用 0（只按绝对阈值判 tiny）。
 * 这三条正是下一轮要补齐的事实层输入；补齐后同一条规则才会给出线上可比的结论。
 * @param {TrafficEvt} e 连接收尾事件
 * @param {number} now 当前时间
 * @returns {FactObs} 观测
 */
export function shadowObs(e: TrafficEvt, now: number): FactObs {
  const relay = e.node ? e.node.slice(0, e.node.lastIndexOf(":")) : "";
  return {
    kind: e.via === "node" ? "relay" : "direct",
    host: e.host,
    relay,
    at: now,
    down: e.down > 0 ? e.down : 0,
    // 只有一个布尔：成功当 200，其余当「没有状态行」
    status: e.ok ? 200 : 0,
  };
}

/**
 * 功能：影子上下文 —— 只用 v7 已经有的状态，不新增任何存储。
 * @param {FactObs} o 观测
 * @param {number} now 当前时间
 * @returns {FactCtx} commitFact 需要的上下文
 */
export function shadowCtx(o: FactObs, now: number): FactCtx {
  const key = o.host + "|" + (o.relay || "d");
  const bigAt = S.bigByHost.get(o.host) || 0;
  // 同一通道以前回过小响应 → 当作「已有上一批」，这样 R_SINGLE_BATCH 才有意义
  const seen = (S.smCnt.get(o.kind === "relay" ? o.host + "|r:" + o.relay : o.host + "|d") || 0) > 0;
  const ctx: FactCtx = { now, bigTypical: 0, lastBigAt: bigAt ? { [o.host]: bigAt } : {} };
  if (seen) ctx.prevBatch = { [key]: { at: now - 61000 } };
  return ctx;
}

/**
 * 功能：写入决策器的影子统计器。记录「如果现在切到 v8，这些流量会写出什么」。
 *
 * 只增不减的计数器（每个 isolate 一份，随 isolate 消失）：它的用途是判断
 * 「v8 的写入规则在真实流量下的形状」，而不是精确账目。
 */
export class FactShadow {
  private n = 0;
  private would = new Map<string, number>();
  private why = new Map<string, number>();

  /**
   * 功能：观察一条连接收尾事件（只统计，不写任何事实）。
   * @param {TrafficEvt} e 连接收尾事件
   * @param {number} now 当前时间（默认取系统时间）
   * @returns {string} 决策理由码（`ok` 表示会写；便于单测直接断言）
   */
  observe(e: TrafficEvt, now = Date.now()): string {
    const o = shadowObs(e, now);
    const r = commitFact(o, shadowCtx(o, now));
    this.n += 1;
    const kind = r.write ? r.write.kind : "none";
    this.would.set(kind, (this.would.get(kind) || 0) + 1);
    this.why.set(r.reason, (this.why.get(r.reason) || 0) + 1);
    cnt("cfObs");
    return r.reason;
  }

  /**
   * 功能：导出快照（给 `/health` 与单测）。
   * @returns {FactShadowSnap} 观测数 + 两类分布
   */
  snap(): FactShadowSnap {
    return { n: this.n, would: mapToObj(this.would), why: mapToObj(this.why) };
  }

  /** 功能：清零（单测用）。@returns {void} */
  clear(): void {
    this.n = 0;
    this.would.clear();
    this.why.clear();
  }
}

/**
 * 功能：Map → 普通对象（`/health` 要能 JSON 序列化）。
 * @param {Map<string, number>} m 计数表
 * @returns {Record<string, number>} 普通对象
 */
function mapToObj(m: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}

/** 进程内唯一的影子统计器 */
export const FACT = new FactShadow();
