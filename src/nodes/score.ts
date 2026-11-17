import { SC } from "../core/const";
import { S } from "../core/state";
import { availOf, effView, TEN_MB, ZERO_STAT, pFailFast, pFailOf, pStallOf, STATS } from "./stat";
import type { EffView } from "./stat";
import { pcts } from "../core/hist";

// ---- 并入自 score-health.ts ----
/* 节点健康度：冷却黑名单、回滚冻结、空关闭可疑、可用性。
   这里原本是 `Scorer` 类上的六个方法，但类里一个字段都没有 —— 状态全在 `S.nstat`，
   类只是一层命名空间。按 AGENTS.md 的约定（只有独占跨请求可变状态才配类），
   把判断还原成自由函数：谁读哪些表，一眼可见。 */

/**
 * 功能：判断节点是否处于冷却期（`nsFail` 罚过之后 `blackUntil` 未到）。
 * @param k 节点键 host:port
 * @returns 在冷却期返回 true
 */
export function isBlack(k: string): boolean {
  const s = S.nstat.get(k);
  // 冷却截止时间在证据表里，没有记录就当没罚过
  return !!(s && s.blackUntil > Date.now());
}

/**
 * 功能：判断节点是否被「回滚冻结」（`freezeNode` 写下的 `freeUntil` 未到）。
 * @param k 节点键 host:port
 * @returns 被冻结返回 true
 */
export function isFrozen(k: string): boolean {
  const s = S.nstat.get(k);
  return !!(s && s.freeUntil > Date.now());
}

/**
 * 功能：冻结一个刚出问题的节点，并让所有依赖排序的缓存就地失效。
 *
 * 取 `Math.max` 是因为冻结可能被多次触发：短冻结不该把长冻结缩短。
 * @param k 节点键 host:port（空串直接忽略）
 * @returns 无
 */
export function freezeNode(k: string): void {
  if (!k) return;
  const s = STATS.nsGet(k);
  s.freeUntil = Math.max(s.freeUntil || 0, Date.now() + SC.ROLL_FREEZE);
  // 站点排行里不能再推荐它：清缓存 + 打一次失效戳
  S.hostRankCache.clear();
  STATS.invalidateRank();
}

/**
 * 功能：中转后仍然大量空关闭 → 这个节点基本是坏的。
 *
 * 只看「走了中转」的口径：直连空关闭是目标站的问题，不能算到节点头上。
 * 阈值取「至少 5 次尝试且空关闭过半」，样本更少时不下结论（避免一两次抖动把节点判死）。
 * @param s 节点统计对象（可为空）
 * @returns 可疑返回 true
 */
export function suspectOf(s: NodeStats | undefined): boolean {
  if (!s) return false;
  const viaP = s.eCloseP || 0;
  const attempts = (s.trafficOkW || 0) + viaP;
  return attempts >= 5 && viaP / attempts > 0.5;
}

/**
 * 功能：可疑节点的 key 版本（面板与规则共用同一份判定，避免两套阈值分叉）。
 * @param k 节点键 host:port
 * @returns 可疑返回 true
 */
export function emptyCloseSuspect(k: string): boolean {
  return suspectOf(S.nstat.get(k));
}

/**
 * 功能：节点当前是否可用（活着、不在冷却、没被冻结，样本够时还要求可用率）。
 *
 * 全局选路与地区选路必须共用这一份判定 —— 否则 `?rg=xx` 会绕过排除规则，
 * 把全国流量压到一个「连得上但永远传不出数据」的节点上。
 * @param k 节点键 host:port
 * @param now 当前时间戳
 * @returns 可用返回 true
 */
export function usable(k: string, now = Date.now()): boolean {
  if (!S.alive.has(k) || isBlack(k) || isFrozen(k)) return false;
  const s = S.nstat.get(k);
  // 没有任何证据的新节点先当可用：不让人为的乐观把池子锁死
  if (!s) return true;
  const e = effView(s, now);
  const n = e.okW + e.failW;
  // 样本够 8 个才用可用率下结论，否则只信「可疑」这一条
  if (n >= 8 && availOf(s, now, e) < 0.4) return false;
  return !suspectOf(s);
}

// ---- 并入自 score-cost.ts ----
/* 节点代价函数：把一条候选压成一个毫秒当量。排序（选路）与面板（`?dd`/`?pss`）读同一份分解，
   避免「面板一套公式、选路另一套」。纯计算：除了只读 S.nstat / S.alive，不改任何状态。 */

/** 一次评分的完整分解（面板分项与选路排序共用） */
export interface ScoreParts {
  mode: Mode; score: number; latencyMs: number; e10Ms: number;
  pFailRisk: number; pStall: number; capBps: number; confB: number;
  nEff: number; latN: number; sampleAgeMs: number; xferMs: number;
  samples: number; jitMs: number; failMs: number; gate: string;
}

/** 延迟项：真实首字节与抖动（`jitMs` 是 MAD×1.4826 折出的 σ） */
export interface LatencyTerm {
  latencyMs: number; jitMs: number;
}

/** 吞吐项：容量证据与两种「传完目标流量」的毫秒数（`xferMs` 只在延迟模式有意义） */
export interface ThroughputTerm {
  capBps: number; nEff: number; sampleAgeMs: number; confB: number; xferMs: number; e10Ms: number;
}

/** 风险项：失败综合概率、卡顿占比与样本量 */
export interface RiskTerm {
  pFailRisk: number; pStall: number; samples: number;
}

/**
 * 功能：一次评分的过程对象 —— 「读哪三张表」与「四项各自怎么算」各成一处。
 *
 * 为什么成类：八个量只依赖「这次评分」（键、模式、时间戳、目标流量、闸门开关与三项派生读数），
 * 而四项判据互相独立 —— 散在一条 75 行函数里时，改一项必须先读另外三项（「失败代价」正是用
 * 延迟与吞吐的合成值）。对象只活一次评分、不跨请求，没有需要清理的状态。
 */
export class ScoreModel {
  /** 节点键 host:port */
  private readonly nodeKey: string;
  /** 已归一的模式（`tput` / `lat`） */
  private readonly scoringMode: Mode;
  /** 这次评分的时间戳 */
  private readonly evaluatedAt: number;
  /** 是否计入准入闸门（未探活的惩罚） */
  private readonly gateEnabled: boolean;
  /** 这次的目标流量（0 表示按模式取缺省） */
  private readonly targetBytes: number;
  /** 节点统计条目（没有记录时用零值，省掉后面每处判空） */
  private readonly stats: NodeStats;
  /** 存活条目（可能没有：节点刚被裁掉） */
  private readonly aliveEntry: NodeEntry | undefined;
  /** 窗口当量视图（原始计数按半衰期折过） */
  private readonly window: EffView;

  /**
   * 功能：取好三条派生读数，让后面四项只读这三个字段。
   * @param k 节点键 host:port
   * @param mode lat 速率优先 / tput 吞吐优先
   * @param now 当前时间戳
   * @param withGate 是否计入准入闸门
   * @param bytes 本次目标流量
   */
  constructor(k: string, mode: Mode, now: number, withGate: boolean, bytes: number) {
    // 模式归一成两个取值：未知字串一律按延迟优先，免得调用方传错时静默走吞吐公式
    this.scoringMode = mode === "tput" ? "tput" : "lat";
    this.nodeKey = k;
    this.evaluatedAt = now;
    this.gateEnabled = withGate;
    this.targetBytes = bytes;
    this.stats = S.nstat.get(k) || ZERO_STAT;
    this.aliveEntry = S.alive.get(k);
    this.window = effView(this.stats, now);
  }

  /**
   * 功能：算延迟项与抖动。
   *
   * 真实首字节是主信号（每条连接一个样本，权重 ≤ `REAL_W`），探活只留 `PROBE_W` 底仓；
   * 单条坏连接不该定生死，所以超过「探活 + 1.5 秒」的部分截断。
   * @returns 首字节当量与抖动
   */
  private latencyTerm(): LatencyTerm {
    const s = this.stats;
    const a = this.aliveEntry;
    const e = this.window;
    // 探活腿：tcp 缺省用存活表毫秒数，再退到固定先验
    const tcp = s.tcp || (a && a.ms) || SC.P_TCP;
    const tls = s.tls || SC.P_TLS;
    // 丢失惩罚：tls 明显大于 2×tcp + 余量时，说明握手在丢包
    const probeL = tcp + tls * SC.TLS_G + Math.max(0, tls - 2 * tcp - SC.LOSS_SLACK) * SC.LOSS_G;
    // 真实首字节（`pSum` 是矩的均值，`msLocal` 是更早写法）
    const realL = s.pSum || s.msLocal || 0;
    const realC = realL > 0 ? Math.min(realL, probeL + 1500) : 0;
    const realW = realC > 0 ? Math.min(SC.REAL_W, e.okW) : 0;
    const Lobs = realW > 0 ? (probeL * SC.PROBE_W + realC * realW) / (SC.PROBE_W + realW) : probeL;
    // 先验取存活表的实测毫秒数（同 isolate 的探活样本），没有就用固定先验
    const Lprior = (a && a.ms) || SC.P_TCP + SC.P_TLS * SC.TLS_G;
    const confL = 1 - Math.exp(-e.latN / 4);
    // 有真实样本就直接用（Lobs 里已带 PROBE_W 底仓），否则按「探活 + 先验」的置信度混合
    const latencyMs = realW > 0 ? Lobs : confL * probeL + (1 - confL) * Lprior;
    // 抖动：对单个离群点平方级敏感，这里按 MAD 再稳一次（样本已 winsorize）
    const jitMs = realL > 0 ? s.pSumSq * 1.4826 : 0;
    return { latencyMs, jitMs };
  }

  /**
   * 功能：算吞吐项（容量、置信度、两种「传完目标流量」的毫秒数）。
   *
   * 吞吐模式用落盘的 p90 容量（分位对等比衰减免疫）；延迟模式用 `capBps`，并让「比先验快」
   * 的证据按新鲜度贬值 —— 慢证据原样保留，否则一次限速会被永久记住。
   * @returns 吞吐项
   */
  private throughputTerm(): ThroughputTerm {
    const s = this.stats;
    const e = this.window;
    // 容量：tput 模式取 p90，lat 模式取当前容量估计
    const capBps = this.scoringMode === "tput" ? pcts(s).cap || 0 : s.capBps || 0;
    // 目标流量可覆盖（交互 64KB / 流媒体 1MB / 批量 16MB）
    const sz = this.targetBytes > 0 ? this.targetBytes : this.scoringMode === "tput" ? TEN_MB : SC.LAT_BYTES;
    // 有效样本数按权重平方和折：重复取样不会假装样本很多
    const nEff = e.sumW2 > 0 ? (e.sumW * e.sumW) / e.sumW2 : 0;
    const sampleAge = s.lastSampleAt ? this.evaluatedAt - s.lastSampleAt : Infinity;
    // 四条同时满足才算「真测过吞吐」：样本数、近期字节、新鲜度、非零容量
    let confB = 0;
    if (nEff >= SC.N_EFF_MIN && e.recentBytesW >= SC.RECENT_MIN && sampleAge <= SC.SAMPLE_TTL && capBps > 0) {
      confB = Math.min(1, e.recentBytesW / SC.RECENT_MIN) * (1 - Math.exp(-nEff / 4));
    }
    // 无本地吞吐样本时按固定先验（2MB/s）；不接受别的 isolate 的速率
    const e10Prior = (sz / SC.PRIOR_BPS) * 1000;
    // 「比先验快」的权重：越接近样本寿命末端越接近 0（实测与先验的混合比例）
    const bwW = this.scoringMode === "lat" && capBps > 0 && s.lastSampleAt ? Math.max(0, 1 - (this.evaluatedAt - s.lastSampleAt) / SC.SAMPLE_TTL) : 0;
    const xferPrior = (sz / SC.PRIOR_BPS) * 1000;
    const xferMeas = capBps > 0 ? (sz / Math.max(8 * 1024, capBps)) * 1000 : 0;
    // 快证据按新鲜度贬值、慢证据原样保留（非对称衰减的原因见 7.x 的仿真对比）
    const xferMs = this.scoringMode !== "lat" ? 0
      : !capBps ? xferPrior : xferMeas <= xferPrior ? bwW * xferMeas + (1 - bwW) * xferPrior : xferMeas;
    const e10Local = (sz / Math.max(capBps, 8 * 1024)) * 1000;
    const e10Ms = confB * e10Local + (1 - confB) * e10Prior;
    return { capBps, nEff, sampleAgeMs: Number.isFinite(sampleAge) ? (sampleAge as number) : -1, confB, xferMs, e10Ms };
  }

  /**
   * 功能：算风险项（失败综合概率、卡顿占比、样本数）。
   *
   * 两种失败概率取大：慢失败（长窗口均值）与快失败（连续失败）任一成立都不该被选中。
   * @returns 风险项
   */
  private riskTerm(): RiskTerm {
    const e = this.window;
    const pFailRisk = Math.max(pFailOf(this.stats, this.evaluatedAt, e), pFailFast(this.stats, this.evaluatedAt));
    const pStall = pStallOf(this.stats, this.evaluatedAt, e);
    return { pFailRisk, pStall, samples: e.okW + e.failW };
  }

  /**
   * 功能：算准入闸门标签（只在诊断里需要）。
   * @returns 空串表示不计闸门；否则 `not-alive` / `black` / `frozen` / `low-avail` / `ok`
   */
  private gateOf(): string {
    // 不计闸门时返回空串：调用方只在 `?dd` 这类诊断里要这段说明
    if (!this.gateEnabled) return "";
    if (!S.alive.has(this.nodeKey)) return "not-alive";
    if (isBlack(this.nodeKey)) return "black";
    if (isFrozen(this.nodeKey)) return "frozen";
    const e = this.window;
    return e.okW + e.failW >= 8 && availOf(this.stats, this.evaluatedAt, e) < 0.4 ? "low-avail" : "ok";
  }

  /**
   * 功能：合成总分与完整分解。
   * @returns 代价分解对象（含 score、各项分量与置信度）
   */
  parts(): ScoreParts {
    // 四项各自算完再合成：某一项变大时能直接看出是哪一项
    const lat = this.latencyTerm();
    const tp = this.throughputTerm();
    const risk = this.riskTerm();
    // 一次失败的代价 ≈ 重试一次（重连 + 重传），按本次目标流量定价：交互 64KB 失败只丢一个 RTT，
    // 按 5000ms 计会把「快但偶尔失败」的节点永久判死；批量 16MB 要重传，价格自然接近 20s。
    const baseMs = lat.latencyMs + (this.scoringMode === "tput" ? tp.e10Ms : tp.xferMs);
    const failMs = SC.FAIL_SCALE > 0 ? Math.min(20000, Math.max(400, SC.FAIL_SCALE * baseMs)) : SC.FAIL;
    // 吞吐模式只看传输 + 半个首字节；延迟模式还要加抖动
    let score = this.scoringMode === "tput"
      ? tp.e10Ms + 0.5 * lat.latencyMs + failMs * risk.pFailRisk + SC.STALL * risk.pStall
      : lat.latencyMs + tp.xferMs + SC.JIT_W * lat.jitMs + failMs * risk.pFailRisk + SC.STALL * risk.pStall;
    // 低速惩罚只在「确实测出来」时才加，避免对无数据节点重复处罚
    if (this.scoringMode === "tput" && tp.confB > 0.25 && tp.capBps > 0 && tp.capBps < 8 * 1024) score += 400;
    if (risk.pStall > 0.25 && risk.samples >= 5) score += 400;
    return {
      mode: this.scoringMode, score, latencyMs: lat.latencyMs, e10Ms: tp.e10Ms, pFailRisk: risk.pFailRisk,
      pStall: risk.pStall, capBps: tp.capBps, confB: tp.confB, nEff: tp.nEff, latN: this.window.latN,
      sampleAgeMs: tp.sampleAgeMs, xferMs: tp.xferMs, samples: risk.samples, jitMs: lat.jitMs, failMs,
      gate: this.gateOf(),
    };
  }
}

/**
 * 功能：算某节点在某模式下的代价分解（延迟项、失败风险、卡顿、吞吐），是选路的唯一评分入口。
 *
 * 分项（排序与面板共用这一份）：
 *   延迟 L = confL × Lobs + (1-confL) × Lprior
 *   吞吐 E10 = confB × (10MiB/cap) + (1-confB) × (10MiB/prior)
 *   score = 目标项 + FAIL×pFailRisk + STALL×pStall
 * @param k 节点键 host:port
 * @param mode lat 速率优先 / tput 吞吐优先
 * @param now 当前时间戳
 * @param withGate 是否计入准入闸门（未探活的惩罚）
 * @param bytes 本次目标流量，用于按流量折算代价
 * @returns 代价分解对象（含 score、各项分量与置信度）
 */
export function scoreParts(k: string, mode: Mode, now = Date.now(), withGate = false, bytes = 0): ScoreParts {
  return new ScoreModel(k, mode, now, withGate, bytes).parts();
}

/**
 * 功能：只要总分（毫秒当量，越小越好）。
 * @param k 节点键 host:port
 * @param mode lat 速率优先 / tput 吞吐优先
 * @param now 当前时间戳
 * @returns 评分（越小越好）
 */
export function costOf(k: string, mode: Mode, now = Date.now()): number {
  return scoreParts(k, mode, now).score;
}

// ---- 候选表（CandidateBoard） ----
/* 候选表：把「谁能进候选、按什么顺序」这一件事收成一个对象。
   排行缓存只冻结排序，不冻结「能不能用」——这一条是 7.37 用 22 条失败单测换来的：
   曾经把 `usable()` 的结果一起缓存，节点被判死后缓存还在把它推荐出去。

   为什么是类而不是四个模块函数：`ranked`/`list`/`next`/`best` 共用同一份排行缓存与
   同一份分片游标（大池一次算不完，靠每次挑选顺带推进一片），这两样东西没有第二个
   消费者，也不该躺在 `S` 里当第七十一个全局变量。
   作废走 `S.rankGen` 代际号：统计表改了节点状态就 +1，本对象下次排行时发现代际变了
   就地自清——这样 `nodes/stat.ts` 不必反过来 import 本文件（那是文件级循环）。 */

/** 排行缓存：`gen` 是写入时的代际号，与 `S.rankGen` 不等即时间戳作废 */
interface RankCache {
  gen: number;
  at: Partial<Record<Mode, number>>;
  v: Partial<Record<Mode, RankRow[]>>;
  step: Partial<Record<Mode, RankCursor>>;
}

/** 分片重建的游标：大池一次算不完，用每次挑选顺带推进一片 */
interface RankCursor {
  keys: string[];
  pos: number;
  top: RankRow[];
  extra: RankRow[];
  ok: number;
}

/**
 * 功能：候选表 —— 排行、过滤、挑下一个、取最优，缓存与分片进度由自己持有。
 */
export class CandidateBoard {
  /** 排行缓存寿命（按模式各记各的时间） */
  private static readonly TTL = 20000;
  /** 候选少的时候不必缓存（重算也就几十 µs） */
  private static readonly CACHE_MIN = 24;
  /** 排行榜只留前 N 名（抽样只看前 64 + 64 个样本不足的） */
  private static readonly KEEP = 224;
  /** 额外兜一批样本不足的节点，否则新节点永远进不了抽样池 */
  private static readonly EXTRA = 64;
  /** 分片重建：每次最多给多少个节点打分（2000 候选一次算完要 4 ms） */
  private static readonly SLICE = 128;
  /** 池子大于这个数才分片：800 个候选整算 1.6 ms 还吃得下，2000 个就要 4 ms */
  private static readonly SLICE_MIN = 1200;

  /** 排行缓存与分片游标（对象身份不变，测试与调用点可以直接看） */
  readonly cache: RankCache = { gen: 0, at: {}, v: {}, step: {} };

  /** 功能：清空缓存与分片进度（分片中途换池子、测试之间复位用）。 */
  reset(): void {
    const c = this.cache;
    c.gen = S.rankGen;
    c.at = {};
    c.v = {};
    c.step = {};
  }

  /**
   * 功能：候选排行（按代价升序）。大池分片重建：每次调用只给 128 个节点打分，
   * 边算边维护有界的前 224 名（不做事后排序），2000 候选不再有 4 ms 的重建尖峰。
   * @param mode 模式
   * @returns 按代价升序的候选行（分片中途返回的是半程结果或上一轮缓存）
   */
  ranked(mode: Mode): RankRow[] {
    const m: Mode = mode === "tput" ? "tput" : "lat";
    this.sync();
    const now = Date.now();
    const c = this.cache;
    // 小池不进缓存：测试与冷启动都要看到当前真实列表
    const cached = S.alive.size >= CandidateBoard.CACHE_MIN ? c.v[m] : undefined;
    if (cached && now - (c.at[m] || 0) < CandidateBoard.TTL) return cached;
    if (S.alive.size < CandidateBoard.CACHE_MIN || S.alive.size < CandidateBoard.SLICE_MIN) {
      return this.build(m, now);
    }
    let st = c.step[m];
    if (!st) {
      st = { keys: [...S.alive.keys()], pos: 0, top: [], extra: [], ok: 0 };
      c.step[m] = st;
    }
    const end = Math.min(st.keys.length, st.pos + CandidateBoard.SLICE);
    for (let i = st.pos; i < end; i++) {
      const k = st.keys[i];
      if (!usable(k)) continue;
      st.ok++;
      const v = costOf(k, m);
      if (st.top.length < CandidateBoard.KEEP || v < st.top[st.top.length - 1].v) {
        this.insert(st.top, { k, v });
      } else if (st.extra.length < CandidateBoard.EXTRA) {
        const s = S.nstat.get(k);
        if (!(s && s.okW + s.failW >= SC.N_EFF_MIN)) st.extra.push({ k, v });
      }
    }
    st.pos = end;
    // 只有整轮扫完才写 S.candN：切片中途的 st.ok 只是「扫过这一段」里的可用数，
    // 被抽样器当成池子大小会让抽样宽度与 β 在同一个池子里来回跳（7.211）
    if (st.pos >= st.keys.length) S.candN = st.ok;
    if (st.pos < st.keys.length) {
      // 半程不重发表格（省掉每次挑选一次 concat）；只有冷启动时才把半程结果先用起来
      if (cached) return cached;
      c.v[m] = st.top;
      return st.top;
    }
    const rows = st.extra.length ? st.top.concat(st.extra) : st.top;
    delete c.step[m];
    this.stamp(m, now);
    c.v[m] = rows;
    return rows;
  }

  /**
   * 功能：候选列表（已按黑名单/冻结过滤，按代价升序）。
   *
   * 缓存只冻结排序、不冻结「能不能用」：每一行都在这里重新过一遍 `alive`/`isBlack`/`isFrozen`。
   * @param mode 模式
   * @returns 过滤后的候选行
   */
  list(mode: Mode): RankRow[] {
    const out: RankRow[] = [];
    for (const r of this.ranked(mode)) {
      if (S.alive.has(r.k) && !isBlack(r.k) && !isFrozen(r.k)) out.push(r);
    }
    return out;
  }

  /**
   * 功能：下一个候选（可跳过 `avoid`，可限定国家码）。
   * @param mode 模式
   * @param avoid 要跳过的节点键（通常是刚失败的那条）
   * @param cc 限定国家码（大小写不敏感，空值表示不限定）
   * @returns 节点键，没有可用候选时返回空串
   */
  next(mode: Mode, avoid: string, cc?: string | null): string {
    const want = String(cc || "").toUpperCase();
    for (const x of this.list(mode)) {
      if (x.k === avoid) continue;
      if (want) {
        const a = S.alive.get(x.k);
        if (!a || String(a.cc || "").toUpperCase() !== want) continue;
      }
      return x.k;
    }
    return "";
  }

  /**
   * 功能：当前最优（候选表第一名的键）。
   * @param mode 模式
   * @returns 节点键，没有候选时返回空串
   */
  best(mode: Mode): string {
    const c = this.list(mode);
    return c.length ? c[0].k : "";
  }

  /** 功能：代际号变了就把时间戳作废（排行与分片进度留着，见 `invalidateRank` 的理由）。 */
  private sync(): void {
    if (this.cache.gen === S.rankGen) return;
    this.cache.gen = S.rankGen;
    this.cache.at = {};
  }

  /**
   * 功能：写一个模式的完成时间戳，并同步代际号。
   * @param m 模式
   * @param now 完成时刻
   */
  private stamp(m: Mode, now: number): void {
    const c = this.cache;
    c.gen = S.rankGen;
    c.at = { ...c.at, [m]: now };
  }

  /**
   * 功能：把一行按代价插进有界的有序表（相等时插在后面：保持 alive 顺序，结果可复现）。
   * @param top 有序表（就地改）
   * @param row 待插入行
   */
  private insert(top: RankRow[], row: RankRow): void {
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (top[mid].v <= row.v) lo = mid + 1;
      else hi = mid;
    }
    top.splice(lo, 0, row);
    if (top.length > CandidateBoard.KEEP) top.pop();
  }

  /**
   * 功能：一次算完的排行（小池与「大池冷启动」走这条路）。
   *
   * 只保留前 224 名 + 最多 64 个样本不足的节点：前者决定「谁最快」，
   * 后者保证新节点也有机会进抽样池（否则它们永远拿不到样本，也就永远进不了排行）。
   * @param m 模式
   * @param now 当前时间戳
   * @returns 按代价升序的候选行
   */
  private build(m: Mode, now: number): RankRow[] {
    const top: RankRow[] = [];
    let usableN = 0;
    for (const k of S.alive.keys()) {
      if (!usable(k)) continue;
      usableN++;
      const v = costOf(k, m);
      if (top.length < CandidateBoard.KEEP || v < top[top.length - 1].v) this.insert(top, { k, v });
    }
    const seen = new Set(top.map((r) => r.k));
    let extra = 0;
    for (const k of S.alive.keys()) {
      if (extra >= CandidateBoard.EXTRA) break;
      if (seen.has(k) || !usable(k)) continue;
      const s = S.nstat.get(k);
      if (s && s.okW + s.failW >= SC.N_EFF_MIN) continue;
      top.push({ k, v: costOf(k, m) });
      seen.add(k);
      extra++;
    }
    S.candN = usableN;
    // 小池不写缓存：否则一次 2 节点的小算例会把后面 30 节点的算例喂成旧表
    if (S.alive.size >= CandidateBoard.CACHE_MIN) {
      this.stamp(m, now);
      this.cache.v[m] = top;
    }
    return top;
  }
}

/** 进程内唯一的候选表 */
export const CANDS = new CandidateBoard();

// ---- 门面（对外导出面保持不变） ----
/* 节点评分门面：按「读哪些表、改哪些表」把原来的 371 行拆成三层，本文件只做再导出，
   所以调用点与单测一字未改（行为由既有 2618 条断言证明）。
   · `score-health.ts` 健康度：冷却黑名单、回滚冻结、空关闭可疑、可用性（只读 S.nstat）
   · `score-cost.ts`   代价函数：把一条候选压成毫秒当量（纯计算，排序与面板共用）
   · `score-cands.ts`  候选表：谁能进候选、按什么顺序（排行缓存与分片重建）
   原来那个 `Scorer` 类一个字段都没有、方法全在读 S，属于「为空壳而 OOP」，7.288 起不再保留。 */

export { capOf, p90Of, pctOf, pcts } from "../core/hist";
export * from "./stat";
