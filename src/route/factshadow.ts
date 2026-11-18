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
import { BIG_WIN, commitFact, factKey, type FactCtx, type FactObs, type FactOut } from "./commitfact";
import type { SampleCount } from "../core/types";
import { relayIpOf } from "../core/relay-addr";

/** 影子统计的一次快照 */
export interface FactShadowSnap {
  /** 观测总数 */
  samples: SampleCount;
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
  const relay = e.node ? relayIpOf(e.node) : "";
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

/** 站点画像观察表：7.369 起从 AppState 下放，大响应只增不减（tiny 判据的尺度） */
export class ShadowTable {
  bigTypical = new Map<string, number>();
}

/** 影子站点画像表的进程内唯一实例 */
export const SHADOW_TABLE = new ShadowTable();

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
  const typ = SHADOW_TABLE.bigTypical.get(o.host) || 0;
  if ((o.down || 0) > typ) SHADOW_TABLE.bigTypical.set(o.host, o.down || 0);
  if (SHADOW_TABLE.bigTypical.size > 512) SHADOW_TABLE.bigTypical.clear();
}

/**
 * 功能：影子上下文 —— 从本 isolate 已有的状态拼出 `commitFact` 需要的上下文。
 * @param {FactObs} o 当前观测
 * @param {number} now 当前时间
 * @param {number} lastWriteAt 该事实键上一次做出裁决的时间（0 = 没有记录，交给 `WRITE_GAP` 判）
 * @returns {FactCtx} 上下文
 */
export function shadowCtx(o: FactObs, now: number, lastWriteAt = 0): FactCtx {
  const ck = chanKey(o);
  const peers: FactObs[] = (S.peers.get(o.host) || [])
    .filter((x) => x.ck !== ck && now - x.at <= BIG_WIN)
    .map((x) => ({
      kind: "relay" as const,
      host: o.host,
      // 键的形态是 `host|relay`（直连是 `host|d`）：按第一个 `|` 切开。
            // 不能按最后一个 `:` —— IPv4 中继名里没有冒号，`lastIndexOf(":")` 返回 -1，
            // 会把整个 `host|ip` 当成中继名（当前只有 `down` 被用到，属于潜伏缺陷）。
            relay: x.ck.slice(x.ck.indexOf("|") + 1),
      at: x.at,
      down: x.down,
      status: 200,
    }));
  // 只带两样：这个站点见过的最大响应（判 tiny 的尺度）与同窗口的其他观测（当对照）。
  // 「批次时钟」与「同站点整页时间」已经不进上下文：前者随「两批 → 写 blk」分支一起删除
  // （那条分支在生产路径上不可达），后者的反向证据检查在 `BLK.note` 里自己做。
  const ctx: FactCtx = {
    now,
    bigTypical: SHADOW_TABLE.bigTypical.get(o.host) || 0,
    peers,
  };
  // 节流时钟：`commitFact` 用 `factKey` 查（中继腿是 `站点|中继`，直连腿是 `d`），
  // 这里就按同一个键填一行。不填它 `R_THROTTLED` 永远命中不了 —— 那意味着
  // `WRITE_GAP`（同一个键 60 秒内只写一条事实）在整条生产链路上从未生效过。
  if (lastWriteAt > 0) ctx.lastWrite = { [factKey(o)]: lastWriteAt };
  return ctx;
}

/**
 * 功能：写入决策器的影子统计器。记录「如果现在切到 v8，这些流量会写出什么」。
 *
 * 只增不减的计数器（每个 isolate 一份，随 isolate 消失）：它的用途是判断
 * 「v8 的写入规则在真实流量下的形状」，而不是精确账目。
 */
export class FactShadow {
  private samples = 0;
  private would = new Map<string, number>();
  private why = new Map<string, number>();
  /**
   * 每个事实键上一次「做出裁决」（写入事实，或确认一批）的时间。
   *
   * 为什么需要它：`commitFact` 的第 0 条规则是节流 —— 同一个键 60 秒内只写一条事实
   * （`WRITE_GAP`）。这条规则要靠 `ctx.lastWrite` 才成立，而之前没有任何调用方填过它，
   * 于是 `R_THROTTLED` 在生产路径上永远命中不了：一次突发里每条 tiny 响应都会给
   * `ps` 记一个负样本（`PsFacts.note` 自己没有节流），45 分钟内把该通道的成功率压到
   * 下界、代价乘以 2。事实是「事实」，不是日志 —— 一条通道一分钟内的二十次失败
   * 说的是同一件事。
   */
  private wrote = new Map<string, number>();

  /**
   * 功能：对一条观测做出**唯一一次**裁决（生产与影子共用这一个结果），并顺带推进两个时钟。
   *
   * 为什么必须只算一次：以前是「影子先算一次、生产再用 `ctxFor` 算一次」，而影子在算完后
   * 会推进批次时钟 —— 生产读到的 `prevBatch` 已经是「刚刚」，于是同一个观测在两侧得到
   * 不同结论：密集 tiny 流里生产侧永远是 `R_SINGLE_BATCH`（两批确认不可达），
   * `cfDiff` 每一条都在涨。一份输入只能有一个结论，这是「同一件事只有一份状态」的最小要求。
   * @param {TrafficEvt} e 连接收尾事件
   * @param {number} now 事件时间
   * @returns {FactOut} 裁决（写什么 / 为什么什么都不写）
   */
  decide(e: TrafficEvt, now = Date.now()): FactOut {
    const o = shadowObs(e, now);
    const r = commitFact(o, shadowCtx(o, now, this.wrote.get(factKey(o)) || 0));
    // 统计（「如果切到 v8 会写出什么」的分布，`/health` 上的 `would`/`why` 就是它）
    this.samples += 1;
    const kind = r.write ? r.write.kind : "none";
    this.would.set(kind, (this.would.get(kind) || 0) + 1);
    this.why.set(r.reason, (this.why.get(r.reason) || 0) + 1);
    cnt("cfObs");
    // 时钟二：节流。真的落了库（`ps`）或裁决为「该写 blk / 该记负样本」才算做过一次裁决；
    // 只有 `R_THROTTLED` 本身不推进，否则一条被节流的观测会把下一个 60 秒也锁上。
    if (r.write || r.reason === "ok" || r.reason === "R_TINY_PEER") {
      this.wrote.set(factKey(o), now);
      if (this.wrote.size > 2048) this.wrote.clear();
    }
    notePeer(o, now);
    return r;
  }

  /**
   * 功能：观察一条连接收尾事件，只返回裁决理由码（单测与 `/health` 的旧入口）。
   * @param {TrafficEvt} e 连接收尾事件
   * @param {number} now 当前时间（默认取系统时间）
   * @returns {string} 决策理由码（`ok` 表示会写）
   */
  observe(e: TrafficEvt, now = Date.now()): string {
    return this.decide(e, now).reason;
  }

  /**
   * 功能：导出快照（给 `/health` 与单测）。
   * @returns {FactShadowSnap} 观测数 + 两类分布
   */
  snap(): FactShadowSnap {
    return { samples: this.samples, would: mapToObj(this.would), why: mapToObj(this.why) };
  }

  /** 功能：清零（单测用）。@returns {void} */
  clear(): void {
    this.samples = 0;
    this.would.clear();
    this.why.clear();
    this.wrote.clear();
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
