// 写入决策器的影子模式（v8 §3.2 的接线第 1 步）：只算「本会写什么」，一个字节都不写。
//
// 为什么先影子：v8 的 `commitFact` 有 19 条表驱动向量证明「规则自洽」，但真实流量的形状
// （`down` 分布、`life` 分布、同窗口对照出现频率）只有线上才有。直接换成 v8 写入路径，
// 一旦某条规则的实际命中率和仿真不同，判定表会在一小时内被写歪，而线上没有对照组可比。
//
// 影子模式的产出：一条连接的「观测 → 决策」分布（`ps/blk/dead/none` + 拒绝理由码）。
// 只要线上 `blk`（`would`）长期为 0，就说明「业务 403 不写封锁」这条在真实流量里站得住。
//
// 本模块同时补上影子成立的前提：v8 需要两样 v7 没有的输入 ——
// · `peers`：同站点 120 秒内**其他通道**的观测（判断「有没有一条通道拿到整页」）；
// · `bigTypical`：本站点见过的最大响应字节数（tiny 的相对判据要用）。
// 两者都只在本 isolate 内存里（跨 isolate 不共享统计，见 AGENTS.md 硬约束 1）。
import { cnt } from "../core/counter";
import { S } from "../core/state";
import type { TrafficEvt } from "../core/hook";
import { BIG_WIN, commitFact, factKey, isTiny, type FactCtx, type FactObs } from "./commitfact";

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
 * · `lastBigAt` 只在 judge 记过整页时才非零，影子自己不会制造它（宁可少判封锁）。
 * 至于 `peers` 与 `bigTypical` 两项输入，已由 `notePeer` 补齐 —— `blk` 规则现在能给出线上可比的结论。
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
 * 功能：通道键 —— 必须与 `commitFact` 的 `factKey` 同构，否则 `prevBatch` 查不到（实测踩过）。
 * 直连腿额外带上站点名，避免不同站点的直连共享同一个批次时钟。
 * @param {FactObs} o 观测
 * @returns {string} 通道键
 */
function chanKey(o: FactObs): string {
  return o.kind === "direct" ? o.host + "|d" : factKey(o);
}

/**
 * 功能：把一条观测压进本站点的对照环形（同通道的旧观测会被覆盖）。
 * @param {FactObs} o 观测
 * @param {number} now 当前时间
 * @returns {void}
 */
export function notePeer(o: FactObs, now: number): void {
  const ck = chanKey(o);
  const cur = S.peers.get(o.host) || [];
  const next = cur.filter((x) => x.ck !== ck && now - x.at <= BIG_WIN);
  next.push({ ck, down: o.down || 0, at: now });
  S.peers.set(o.host, next.slice(-8));
  if (S.peers.size > 512) S.peers.clear();
  // bigTypical：只增不减地记录见过的最大响应（宁可把 tiny 判严，也别冤枉业务页）
  const typ = S.bigTyp.get(o.host) || 0;
  if ((o.down || 0) > typ) S.bigTyp.set(o.host, o.down || 0);
  if (S.bigTyp.size > 512) S.bigTyp.clear();
}

/**
 * 功能：影子上下文 —— 从本 isolate 已有的状态拼出 `commitFact` 需要的上下文。
 * @param {FactObs} o 当前观测
 * @param {number} now 当前时间
 * @param {Record<string, { at: number }>} prev 已确认批次
 * @returns {FactCtx} 上下文
 */
export function shadowCtx(o: FactObs, now: number, prev: Record<string, { at: number }>): FactCtx {
  const ck = chanKey(o);
  const peers: FactObs[] = (S.peers.get(o.host) || [])
    .filter((x) => x.ck !== ck && now - x.at <= BIG_WIN)
    .map((x) => ({
      kind: "relay" as const,
      host: o.host,
      relay: x.ck.slice(x.ck.lastIndexOf(":") + 1),
      at: x.at,
      down: x.down,
      status: 200,
    }));
  const bigAt = S.bigByHost.get(o.host) || 0;
  const ctx: FactCtx = {
    now,
    bigTypical: S.bigTyp.get(o.host) || 0,
    peers,
    lastBigAt: bigAt ? { [o.host]: bigAt } : {},
  };
  if (prev[ck]) ctx.prevBatch = { [ck]: { at: prev[ck].at } };
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
  /** 每个键上一次 tiny 观测的时间：第二批要 ≥60s 才算确认 */
  private prevBlk = new Map<string, number>();

  /**
   * 功能：观察一条连接收尾事件（只统计，不写任何事实）。
   * @param {TrafficEvt} e 连接收尾事件
   * @param {number} now 当前时间（默认取系统时间）
   * @returns {string} 决策理由码（`ok` 表示会写；便于单测直接断言）
   */
  /**
   * 功能：给外部（生产写入点）拼一份与影子完全相同的上下文，保证两边用同一套证据。
   * @param e 连接事件
   * @param now 事件时间
   * @returns 裁决器上下文
   */
  ctxFor(e: TrafficEvt, now = Date.now()): FactCtx {
    const prev = this.prevBlk as unknown as Record<string, { at: number }>;
    const o: FactObs = { kind: e.via === "node" ? "relay" : "direct", host: e.host, relay: e.node ? e.node.slice(0, e.node.lastIndexOf(":")) : "", at: now, down: e.down, status: 0 };
    return shadowCtx(o, now, prev);
  }
  observe(e: TrafficEvt, now = Date.now()): string {
    const o = shadowObs(e, now);
    const ck = chanKey(o);
    const prevAt = this.prevBlk.get(ck) || 0;
    const prev: Record<string, { at: number }> = prevAt ? { [ck]: { at: prevAt } } : {};
    const r = commitFact(o, shadowCtx(o, now, prev));
    this.n += 1;
    const kind = r.write ? r.write.kind : "none";
    this.would.set(kind, (this.would.get(kind) || 0) + 1);
    this.why.set(r.reason, (this.why.get(r.reason) || 0) + 1);
    cnt("cfObs");
    // tiny 观测记一批（无论这次是否凑够对照）：下一次 tiny 才有机会变成「两批确认」
    if (isTiny(o, S.bigTyp.get(o.host) || 0)) this.prevBlk.set(ck, now);
    if (this.prevBlk.size > 2048) this.prevBlk.clear();
    notePeer(o, now);
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
    this.prevBlk.clear();
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
