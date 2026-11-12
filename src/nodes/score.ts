import { HIST_BASE, HIST_N, SC } from "../core/const";
import { pcts } from "../core/hist";
export { capOf, p90Of, pctOf, p90Local, pcts } from "../core/hist";
import { S } from "../core/state";

/* 代理节点：统计与评分（纯计算） */
/* 热点文件：为守住单文件 560 行门禁，保留紧凑排版；扩展时优先拆函数。 */
/**
 * 取节点统计对象（不存在则初始化）。
 * @param {string} k "host:port"
 * @returns {object} 统计对象
 */
export function nsGet(k: string): NodeStats {
  let s: NodeStats | undefined = S.nstat.get(k);
  if (!s) {
    s = {
      ok: 0, fail: 0, at: 0, msLocal: 0,
      streak: 0, blackUntil: 0, freeUntil: 0, lastTry: 0,
      tcp: 0, tls: 0, okW: 0, failW: 0, stallMs: 0, runMs: 0,
      pN: 0, pSum: 0, pSumSq: 0, pF: 0,        // 探活样本（只用于延迟）
      tS: 0, tF: 0,                            // 真实流量（只用于可用性）
      eCloseP: 0, eCloseD: 0,                  // 空关闭：中转后 / 直连
      bytesDown: 0, hist: new Array(HIST_N).fill(0),
      sumW: 0, sumW2: 0, recentBytesW: 0, lastSampleAt: 0,
      seedBps: 0, seedN: 0, seedFail: 0, seedAt: 0, counted: 0,
      winAt: 0, winOk: 0, winFail: 0,
    };
    S.nstat.set(k, s);
  }
  return s;
}

/**
 * 指数衰减：半衰期 SC.HL。更新前与读分前都要过一遍。
 * @param {object} s 统计对象
 * @param {number} now 当前时间戳
 * @returns {void}
 */
export function nsDecay(s: NodeStats, now: number) {
  if (!s) return;
  if (!s.at) { s.at = now; return; }
  const k = Math.pow(0.5, (now - s.at) / SC.HL);
  if (k >= 0.9999) return;
  s.okW *= k; s.failW *= k; s.stallMs *= k; s.runMs *= k;
  s.pN *= k; s.pSum *= k; s.pSumSq *= k; s.pF *= k; s.tS *= k; s.tF *= k;
  // 空关闭计数必须一起衰减：tS 衰减而它不衰减，比值会单调涨，
  // 最终把曾经抽风过一次的节点永久踢出候选表。
  s.eCloseP *= k; s.eCloseD *= k;
  s.sumW *= k; s.sumW2 *= k * k; s.recentBytesW *= k;
  if (s.hist) for (let i = 0; i < HIST_N; i++) s.hist[i] *= k;
  s.at = now;
}

/** 时间衰减因子：2^(-age/HL)。读到旧样本时用它折算，不改存储状态。 */
const LN2 = Math.LN2;
export function ageFactor(ms: number): number {
  if (!(ms > 0)) return 1;
  return Math.exp((-ms / SC.HL) * LN2);
}

/**
 * 读时有效视图（纯函数）。
 * 存储里的权重是"上次写入时刻"的值；隔了多久就按半衰期折算多少。
 */
export function effView(s: NodeStats, now = Date.now()) {
  const k = ageFactor(now - (s.at || now));
  return {
    k,
    okW: s.okW * k,
    failW: s.failW * k,
    stallMs: s.stallMs * k,
    runMs: s.runMs * k,
    sumW: s.sumW * k,
    sumW2: s.sumW2 * k * k,
    recentBytesW: s.recentBytesW * k,
    pN: s.pN * k,
    // 延迟观测数：探活 + 成功连接（两者都提供握手耗时）
    latN: (s.pN + s.okW) * k,
  };
}

/**
 * 记一次空关闭（连接建立后 0 字节结束）。viaP=true 表示已经过了中转。
 */
export function nsEmptyClose(k: string, viaP: boolean) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  if (viaP) s.eCloseP = (s.eCloseP || 0) + 1;
  else s.eCloseD = (s.eCloseD || 0) + 1;
  // 跨过可疑门槛时，候选/站点排行缓存不能继续推荐它
  if (viaP && s.eCloseP >= 5) { S.hostRankCache.clear(); invalidateRank(); }
  s.at = now;
}

// 快速失败窗口用指数衰减，而不是"10 分钟内计数、到点清零"：
// 旧写法里 9 分钟前的 4 次成功会把刚刚的 4 次失败稀释成 50%，
// 而第 10 分钟一到，同一批失败又整段消失，风险曲线是断崖。
function bumpWin(s: NodeStats, now: number, ok: boolean) {
  const k = s.winAt ? Math.pow(0.5, Math.max(0, now - s.winAt) / SC.WIN_HL) : 0;
  s.winOk *= k;
  s.winFail *= k;
  s.winAt = now;
  if (ok) s.winOk += 1;
  else s.winFail += 1;
}

/**
 * 近期失败率（3 分钟半衰期的指数窗口）。
 * 权重淡到不足 3 次就返回 0（交给慢通道），**不要用 +1/+10 平滑**：
 * 平滑常数在 n→0 时会把"很久没有流量"算成 9% 失败率，
 * 而空闲节点恰恰是每一个非游标节点 —— 等于给所有候选固定加 750ms，
 * 游标一旦坐稳就再也换不下来（仿真里 20 个节点全被这条压住）。
 */
export function pFailFast(s: NodeStats, now = Date.now()): number {
  if (!s || !s.winAt) return 0;
  const k = Math.pow(0.5, Math.max(0, now - s.winAt) / SC.WIN_HL);
  const bad = (s.winFail || 0) * k;
  const n = bad + (s.winOk || 0) * k;
  if (n < 2.5) return 0; // 3 次有效样本才发言（浮点衰减后 3.0 会略小于 3）
  return Math.min(0.9, bad / n);
}

/** 记一次成功（同时更新握手耗时 EWMA）。 */
export function nsOk(k: string, tcp: number, tls: number) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  bumpWin(s, now, true);
  s.okW += 1; s.ok += 1; s.tS = (s.tS || 0) + 1;
  s.streak = 0; s.blackUntil = 0; s.freeUntil = 0;   // 真流量成功：黑名单和冻结都解除
  s.at = now;
  if (tcp > 0) s.tcp = s.tcp ? s.tcp * (1 - SC.A) + tcp * SC.A : tcp;
  if (tls > 0) s.tls = s.tls ? s.tls * (1 - SC.A) + tls * SC.A : tls;
}

/**
 * 记一次探活结果：只进延迟样本，不参与可用性、也不解除熔断。
 * @param {string} k "host:port"
 * @param {number} ms 握手总耗时
 * @param {number} tcp 建连耗时
 * @param {number} tls TLS 往返
 * @returns {void}
 */
export function nsProbe(k: string, ms: number, tcp: number, tls: number) {
  if (!k || !(ms > 0)) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  s.pN += 1; s.pSum += ms; s.pSumSq += ms * ms;
  s.pF *= 0.5;
  // 探活只进延迟样本：不要动 s.ok，否则面板成功率会被探测次数灌水
  if (tcp > 0) s.tcp = s.tcp ? s.tcp * (1 - SC.A) + tcp * SC.A : tcp;
  if (tls > 0) s.tls = s.tls ? s.tls * (1 - SC.A) + tls * SC.A : tls;
  s.at = now;
}

/**
 * 探活失败：连续两次才拉黑 10 分钟（单次超时很常见，不能误杀）。
 * @param {string} k "host:port"
 * @returns {void}
 */
export function nsProbeFail(k: string) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  s.pF += 1;
  if (s.pF >= 2) {
    s.blackUntil = Math.max(s.blackUntil || 0, now + 10 * 60000);
    // 探活也能拉黑节点：排行缓存里可能还留着它，下次 pick 不能继续推荐
    S.hostRankCache.clear();
    invalidateRank();
  }
  s.at = now;
}

/**
 * 记一次失败，并按指数退避设置冷却。
 * @param {string} k "host:port"
 * @returns {void}
 */
export function nsFail(k: string) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  bumpWin(s, now, false);
  s.failW += 1; s.fail += 1; s.tF = (s.tF || 0) + 1;
  s.streak = (s.streak || 0) + 1;
  // 小池子一次失败就 60 秒没有候选（直接回落直连），首档缩到 10 秒；
  // 最后一档 20 分钟，而不是 1 小时 —— 恢复的节点不该被关这么久。
  const ladder = [S.alive.size < 5 ? 10000 : 60000, 300000, 900000, 1200000];
  s.blackUntil = Math.max(s.blackUntil || 0, now + ladder[Math.min(s.streak, 4) - 1]);
  if (s.streak >= 4) s.streak = 0;     // 给第五次机会
  // 抖动：10 分钟内成败参半（≥4 次）→ 冷却 5 分钟，而不是等"连续"失败
  const wn = s.winOk + s.winFail;
  if (wn >= 4 && s.winFail / wn >= 0.5) {
    s.blackUntil = Math.max(s.blackUntil || 0, now + 5 * 60000);
  }
  s.at = now;
  S.hostRankCache.clear();             // 冷却中的节点不该继续被站点排行推荐
  invalidateRank();                    // 失败改变了排序前提
}

/**
 * 站点侧失败：连上了节点，但目标站 0 字节关闭 / 拒绝。
 * 只轻记全局（0.2 次），不动连续失败阶梯 —— 一个站封了这个 IP，不该毁掉节点在别处的排名。
 */
export function nsSiteFail(k: string) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  s.failW += 0.2;
  s.fail += 0.2;       // 面板成功率与 failW 用同一份权重，别让一个被封的站把节点显示成 50%
  s.tF = (s.tF || 0) + 0.2;
  s.at = now;
  // 这里不再清排行缓存：站点失败对全局分的影响只有 0.2 次，
  // 而清缓存会让下一个请求重算 200 个节点。站点级画像在 hostNodeMark 里精确失效。
}

/**
 * 记录一个吞吐样本：进 log2 直方图（带衰减，所以 p90 反映"近期峰值"）。
 * @param {string} k "host:port"
 * @param {number} bps 字节/秒
 * @param {number} bytes 该样本覆盖的字节数
 * @param {object} _env 保留位（落盘已统一走 store 的调度，这里不再用）
 * @returns {void}
 */
export function nsSpeed(k: string, bps: number, bytes: number, _env: Env, w = 1) {
  if (!k || !(bps > 0)) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  const weight = Math.max(0, Math.min(w, SC.CONN_W_CAP));
  if (!(weight > 0)) return;
  const i = Math.max(0, Math.min(HIST_N - 1, Math.round(Math.log2(Math.max(bps, 1) / HIST_BASE))));
  // 加权直方图：一个 8MB/s 的长连接和一个 200KB/s 的短连接不该等权
  s.hist[i] += weight;
  s.sumW += weight;
  s.sumW2 += weight * weight;
  s.recentBytesW += (bytes || 0) * weight;
  s.lastSampleAt = now;
  // 本地样本够 3 个有效窗口才让导入的先验作废：
  // 第一条 512KB 的短样本（nEff=1）本身不参与 confB，却会把 8MB/s 的 seed
  // 直接抹成 200KB/s 默认先验，节点会被误判成慢节点。
  const nEff = s.sumW2 > 0 ? (s.sumW * s.sumW) / s.sumW2 : 0;
  if (nEff >= SC.N_EFF_MIN) { s.seedBps = 0; s.seedAt = 0; }
  s.bytesDown = (s.bytesDown || 0) + (bytes || 0);
  s.at = now;
  S.seedDirty = true;
}

/** 记录卡顿时长（背压累计） */
export function nsStall(k: string, stallMs: number, runMs: number) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  s.stallMs += stallMs || 0;
  s.runMs += runMs || 0;
  s.at = now;
}

/** 记录本地实测延迟（探活用） */
export function nsLatency(k: string, ms: number) {
  if (!k || !(ms > 0)) return;
  const s = nsGet(k);   // 必须走 nsGet，否则缺 stallMs/runMs 会让 pStall 变 NaN
  s.msLocal = s.msLocal ? Math.round(s.msLocal * 0.6 + ms * 0.4) : Math.round(ms);
}

/**
 * 失败概率。只看真实流量，不看探活。
 * 用"后验上界"而不是点估计：样本越少越往坏的方向估，
 * 否则"一次失败的老节点"会被"从没试过的新节点"顶掉 —— 那正是速率跳变的来源之一。
 * @param {object} s 统计对象
 * @returns {number} 0~0.9 的失败概率估计
 */
export function pFailOf(s: NodeStats, now = Date.now(), e0?: ReturnType<typeof effView>): number {
  if (!s) return 0.1;
  const e = e0 || effView(s, now);
  const N = e.okW + e.failW;

  // seed 只修正 Beta 先验，不计入本地 N（也不影响可用性门槛）
  let a0 = SC.BETA_A, b0 = SC.BETA_B;
  const seedN = s.seedN || 0;
  const seedAge = s.seedAt ? now - s.seedAt : Infinity;
  if (seedN > 0 && seedAge <= SC.SEED_TTL) {
    // 线性退火：到期权重正好归零。原来用 2^(-age/TTL)，到 TTL 时还剩 0.5，
    // 再往后直接跳成 0，节点分会在过期那一刻突然抖一下。
    const seedW = Math.min(2, 0.25 * seedN) * Math.max(0, 1 - seedAge / SC.SEED_TTL);
    const failRate = Math.min(1, (s.seedFail || 0) / Math.max(seedN, 1));
    a0 += seedW * failRate;
    b0 += seedW * (1 - failRate);
  }

  const a = a0 + e.failW;
  const b = b0 + e.okW;
  const pMean = a / (a + b);
  const varr = (a * b) / ((a + b) * (a + b) * (a + b + 1));
  // 无本地样本时不加不确定性溢价：先验均值就是 0.1，别把"未知"当"坏"
  const premium = 0.5 * Math.sqrt(varr) * (1 - Math.exp(-N / 4));
  return Math.min(0.9, Math.max(0, pMean + premium));
}

/** 可用性（小样本用后验均值，大样本用 Wilson 下界） */
export function availOf(s: NodeStats, now = Date.now(), e0?: ReturnType<typeof effView>): number {
  if (!s) return 0.5;
  const e = e0 || effView(s, now);
  const ok = e.okW, bad = e.failW;
  const n = ok + bad;
  if (n >= 30) {
    const phat = ok / n, z = 1.96;
    const den = 1 + (z * z) / n;
    const mid = phat + (z * z) / (2 * n);
    const adj = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
    return Math.max(0, (mid - adj) / den);
  }
  return (ok + 1) / (n + 2);
}

/** 卡顿占比（无数据 = 0.05） */
export function pStallOf(s: NodeStats, now = Date.now(), e0?: ReturnType<typeof effView>): number {
  if (!s) return 0.05;
  const e = e0 || effView(s, now);
  return (e.stallMs + 50) / (e.runMs + 1000);
}

/**
 * 节点代价（毫秒当量，越小越好）。lat=速率优先，tput=吞吐优先。
 * @param {string} k "host:port"
 * @param {string} mode "lat" | "tput"
 * @returns {number} 代价
 */
export const ZERO_STAT: NodeStats = {
  ok: 0, fail: 0, at: 0, msLocal: 0, streak: 0, blackUntil: 0, freeUntil: 0, lastTry: 0,
  pN: 0, pSum: 0, pSumSq: 0, pF: 0, tcp: 0, tls: 0,
  tS: 0, tF: 0, okW: 0, failW: 0, eCloseP: 0, eCloseD: 0,
  stallMs: 0, runMs: 0, bytesDown: 0, hist: new Array(HIST_N).fill(0),
  sumW: 0, sumW2: 0, recentBytesW: 0, lastSampleAt: 0,
  seedBps: 0, seedN: 0, seedFail: 0, seedAt: 0, counted: 0,
  winAt: 0, winOk: 0, winFail: 0,
};

export const TEN_MB = 10 * 1048576;
export const E10_PRIOR = (TEN_MB / SC.PRIOR_BPS) * 1000;   // 无吞吐样本时的先验代价（≈51 秒）

export interface ScoreParts {
  mode: Mode; score: number; latencyMs: number; e10Ms: number;
  pFailRisk: number; pStall: number; capBps: number; confB: number;
  nEff: number; latN: number; sampleAgeMs: number;
  priorSource: "seed" | "prior"; gate: string;
}

/**
 * 评分明细（v2）：排序与面板共用同一份分项，避免"面板一套公式、选路另一套"。
 *
 *   延迟 L = confL × Lobs + (1-confL) × Lprior
 *   吞吐 E10 = confB × (10MiB/cap) + (1-confB) × (10MiB/prior)
 *   score = 目标项 + FAIL×pFailRisk + STALL×pStall
 */
export function scoreParts(k: string, mode: Mode, now = Date.now(), withGate = false): ScoreParts {
  const m: Mode = mode === "tput" ? "tput" : "lat";
  const s = S.nstat.get(k) || ZERO_STAT;
  const a = S.alive.get(k);
  const e = effView(s, now);

  // —— 延迟 ——
  const tcp = s.tcp || (a && a.ms) || SC.P_TCP;
  const tls = s.tls || SC.P_TLS;
  const probeL = tcp + tls * SC.TLS_G + Math.max(0, tls - 2 * tcp - SC.LOSS_SLACK) * SC.LOSS_G;
  // 探活只能证明"连得上"，真实首字节才代表转发能力：差距过大时以真实值为准，
  // 否则"探活 25ms、实际 350ms"的节点会永久霸榜（仿真里它吃掉 100% 流量）。
  const realL = s.msLocal || 0;
  // 只有"真实首字节比探活估计慢一倍以上"才算撒谎：正常波动不参与
  const liar = realL > probeL * 2 + 150 ? Math.min(realL, probeL + 1500) : 0;
  const Lobs = liar || probeL;
  // 先验也要被真实值兜底：否则 confL=0 时只看探活 ms，撒谎节点照样排第一
  const Lprior = Math.max((a && a.ms) || SC.P_TCP + SC.P_TLS * SC.TLS_G, liar);
  // 真实连接也提供了握手观测，和探活样本一起算延迟置信度
  const confL = 1 - Math.exp(-e.latN / 4);
  const latencyMs = confL * Lobs + (1 - confL) * Lprior;

  // —— 吞吐（只有 tput 才需要扫直方图）——
  const q = m === "tput" ? pcts(s) : { p50: 0, p90: 0, cap: 0 };
  const capBps = q.cap || 0;
  const nEff = e.sumW2 > 0 ? (e.sumW * e.sumW) / e.sumW2 : 0;
  const sampleAge = s.lastSampleAt ? now - s.lastSampleAt : Infinity;
  let confB = 0;
  if (nEff >= SC.N_EFF_MIN && e.recentBytesW >= SC.RECENT_MIN && sampleAge <= SC.SAMPLE_TTL && capBps > 0) {
    confB = Math.min(1, e.recentBytesW / SC.RECENT_MIN) * (1 - Math.exp(-nEff / 4));
  }
  const seedAge = s.seedAt ? now - s.seedAt : Infinity;
  const seedLeft = Math.max(0, Math.min(1, 1 - seedAge / SC.SEED_TTL));
  const cSeed = !s.seedBps ? 0 : SC.SEED_CONF * seedLeft;
  const priorBps = cSeed > 0 ? cSeed * s.seedBps + (1 - cSeed) * SC.PRIOR_BPS : SC.PRIOR_BPS;
  const e10Prior = (TEN_MB / priorBps) * 1000;
  const e10Local = (TEN_MB / Math.max(capBps, 8 * 1024)) * 1000;
  const e10Ms = confB * e10Local + (1 - confB) * e10Prior;

  // —— 风险 ——
  const pFailRisk = Math.max(pFailOf(s, now, e), pFailFast(s, now));
  const pStall = pStallOf(s, now, e);
  const N = e.okW + e.failW;

  let score = m === "tput"
    ? e10Ms + 0.5 * latencyMs + SC.FAIL * pFailRisk + SC.STALL * pStall
    : latencyMs + SC.FAIL * pFailRisk + SC.STALL * pStall;

  // 低速惩罚只在"确实测出来"时才加，避免对无数据节点重复处罚
  if (m === "tput" && confB > 0.25 && capBps > 0 && capBps < 8 * 1024) score += 400;
  if (pStall > 0.25 && N >= 5) score += 400;

  let gate = "";
  if (withGate) {
    gate = !S.alive.has(k) ? "not-alive" : isBlack(k) ? "black" : isFrozen(k) ? "frozen"
      : (N >= 8 && availOf(s, now, e) < 0.4) ? "low-avail" : "ok";
  }

  return {
    mode: m, score, latencyMs, e10Ms, pFailRisk, pStall, capBps, confB,
    nEff, latN: e.latN, sampleAgeMs: Number.isFinite(sampleAge) ? sampleAge : -1,
    priorSource: cSeed > 0 ? "seed" : "prior", gate,
  };
}

/** 节点代价（毫秒当量，越小越好） */
export function costOf(k: string, mode: Mode, now = Date.now()): number {
  return scoreParts(k, mode, now).score;
}

/** 是否处于冷却期 */
export function isBlack(k: string) {
  const s = S.nstat.get(k);
  return !!(s && s.blackUntil > Date.now());
}
/** 是否被回滚冻结 */
export function isFrozen(k: string) {
  const s = S.nstat.get(k);
  return !!(s && s.freeUntil > Date.now());
}
/** 冻结一个刚出问题的节点 */
export function freezeNode(k: string) {
  if (!k) return;
  const s = nsGet(k);
  s.freeUntil = Math.max(s.freeUntil || 0, Date.now() + SC.ROLL_FREEZE);
  S.hostRankCache.clear();     // 站点排行里不能再推荐它
  invalidateRank();
}

/**
 * 中转后仍然大量空关闭 → 这个节点基本是坏的。
 * 只看"走了中转"的口径，直连空关闭是目标站的问题，不能算到节点头上。
 * @param {object} s 统计对象
 * @returns {boolean} 是否可疑
 */
export function suspectOf(s: NodeStats | undefined): boolean {
  if (!s) return false;
  const viaP = s.eCloseP || 0;
  const attempts = (s.tS || 0) + viaP;
  return attempts >= 5 && viaP / attempts > 0.5;
}

/** 可疑节点的 key 版本（面板/规则共用一份判定） */
export function emptyCloseSuspect(k: string) {
  return suspectOf(S.nstat.get(k));
}

/**
 * 候选资格：活着、不在冷却/冻结、可用性够、不是空关闭可疑节点。
 * 全局选路与地区选路必须共用这一份判定 —— 否则 rg=xx 会绕过排除规则，
 * 把全国流量压到一个"连得上但永远传不出数据"的节点上。
 * @param {string} k "host:port"
 * @param {number} now 当前时间
 * @returns {boolean} 是否可用
 */
export function usable(k: string, now = Date.now()): boolean {
  if (!S.alive.has(k) || isBlack(k) || isFrozen(k)) return false;
  const s = S.nstat.get(k);
  if (!s) return true;
  const e = effView(s, now);
  const n = e.okW + e.failW;
  if (n >= 8 && availOf(s, now, e) < 0.4) return false;
  return !suspectOf(s);
}

/** 候选列表（已过滤黑名单/冻结，按代价升序） */
const CAND_TTL = 20000;      // 排行缓存寿命（按模式各记各的时间）
const CAND_CACHE_MIN = 24;   // 候选少的时候不必缓存（重算也就几十 µs）

/** 排行缓存作废：节点状态变了就调它（两处时间戳一起清，避免只清一半） */
export function invalidateRank() {
  S.rankCache = { t: 0, at: {}, v: {} };
}

export function rankedCands(mode: Mode) {
  const m: Mode = mode === "tput" ? "tput" : "lat";
  const useCache = S.alive.size >= CAND_CACHE_MIN;
  const now = Date.now();
  if (useCache) {
    const c = S.rankCache;
    // 按模式各存一个写入时间：共用 t 时，另一种模式的重算会给本条"续命"，
    // lat 的实际有效期能拖到 40 s（失败/冷却要等这么久才反映到排序）。
    if (c.t && now - (c.at[m] || 0) < CAND_TTL && c.v[m]) return c.v[m];
  }
  const out: { k: string; v: number }[] = [];
  for (const k of S.alive.keys()) {
    if (!usable(k)) continue;           // 冷却/冻结/低可用/空关闭可疑：统一在这里挡掉
    out.push({ k, v: costOf(k, m) });
  }
  out.sort((a, b) => a.v - b.v);
  S.candN = out.length;
  if (useCache) S.rankCache = { t: now, at: { ...S.rankCache.at, [m]: now }, v: { ...S.rankCache.v, [m]: out } };
  return out;
}

export function candsFor(mode: Mode) {
  // 缓存只冻结排序，不冻结"能不能用"：黑名单/冻结每次都要重新过滤
  return rankedCands(mode).filter((r) => S.alive.has(r.k) && !isBlack(r.k) && !isFrozen(r.k));
}

/**
 * 换一个节点（排除指定的那个），用于"这个节点断了再试下一个"
 * @param {string} mode "lat" | "tput"
 * @param {string} avoid 要避开的节点
 * @param {string} [cc] 只在这个国家里选（地区硬要求）
 * @returns {string} 节点 key，没有可换的返回 ""
 */
export function nextNode(mode: Mode, avoid: string, cc?: string | null) {
  const want = String(cc || "").toUpperCase();
  for (const x of candsFor(mode)) {
    if (x.k === avoid) continue;
    if (want) {
      const a = S.alive.get(x.k);
      if (!a || String(a.cc || "").toUpperCase() !== want) continue;
    }
    return x.k;
  }
  return "";
}

/** 当前最优 */
export function bestFor(mode: Mode) {
  const c = candsFor(mode);
  return c.length ? c[0].k : "";
}

/* ---- 落盘节流已移到 px/seed.ts，nodes 不再反向依赖 px ---- */

