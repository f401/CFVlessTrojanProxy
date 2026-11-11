import { HIST_BASE, HIST_N, SC } from "../core/const";
import { SEED_WRITE_GAP } from "../core/const";
import { SEEDS } from "../px/seed";
import { S } from "../core/state";

/* 代理节点：统计与评分（纯计算） */
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
  if (viaP && s.eCloseP >= 5) { S.hostRankCache.clear(); S.rankCache.t = 0; }
  s.at = now;
}

function bumpWin(s: NodeStats, now: number, ok: boolean) {
  if (!s.winAt || now - s.winAt > SC.WIN_MS) { s.winAt = now; s.winOk = 0; s.winFail = 0; }
  if (ok) s.winOk += 1; else s.winFail += 1;
}

/** 近期（10 分钟）失败率；样本不足返回 0（= 不参与） */
export function pFailFast(s: NodeStats, now = Date.now()): number {
  if (!s || !s.winAt || now - s.winAt > SC.WIN_MS) return 0;
  const n = s.winOk + s.winFail;
  if (n < 2) return 0;
  return (s.winFail + 1) / (n + 10);
}

/** 记一次成功（同时更新握手耗时 EWMA）。 */
export function nsOk(k: string, tcp: number, tls: number) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  bumpWin(s, now, true);
  s.okW += 1; s.ok += 1; s.tS = (s.tS || 0) + 1;
  s.streak = 0; s.blackUntil = 0; s.freeUntil = 0;   // 真流量成功：黑名单和冻结都解除 s.at = now;
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
  s.ok += 1;
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
    S.rankCache.t = 0;
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
  const ladder = [60000, 300000, 900000, 3600000];
  s.blackUntil = Math.max(s.blackUntil || 0, now + ladder[Math.min(s.streak, 4) - 1]);
  if (s.streak >= 4) s.streak = 0;     // 给第五次机会
  // 抖动：10 分钟内成败参半（≥4 次）→ 冷却 5 分钟，而不是等"连续"失败
  const wn = s.winOk + s.winFail;
  if (wn >= 4 && s.winFail / wn >= 0.5) {
    s.blackUntil = Math.max(s.blackUntil || 0, now + 5 * 60000);
  }
  s.at = now;
  S.hostRankCache.clear();             // 冷却中的节点不该继续被站点排行推荐
  S.rankCache.t = 0;                   // 失败改变了排序前提
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
 * @param {object} [env] 用于节流落盘
 * @returns {void}
 */
export function nsSpeed(k: string, bps: number, bytes: number, env: Env, w = 1) {
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
 * 直方图分位（连续插值）。q=0.9 是峰值能力，q=0.5 是中位。
 * 用插值而不是"落到哪个桶就返回哪个桶"，否则分位会在 2 倍档之间来回跳，
 * 排序跟着跳，表现就是"节点速率忽快忽慢"。
 * @param {object} s 统计对象
 * @param {number} q 0~1
 * @returns {number} 字节/秒
 */
export function pctOf(s: NodeStats, q: number) {
  if (!s || !s.hist) return 0;
  let tot = 0;
  for (let i = 0; i < HIST_N; i++) tot += s.hist[i];
  if (!(tot > 0)) return 0;
  const target = tot * q;
  let acc = 0;
  for (let i = 0; i < HIST_N; i++) {
    const prev = acc;
    acc += s.hist[i];
    if (acc >= target) {
      const f = s.hist[i] > 0 ? Math.max(0, Math.min(1, (target - prev) / s.hist[i])) : 1;
      return HIST_BASE * Math.pow(2, i - 0.5 + f);
    }
  }
  return HIST_BASE * Math.pow(2, HIST_N - 0.5);
}

/** 本地直方图的 p90（落盘用；导入值不能再写回去，否则自我强化） */
export function p90Local(s: NodeStats) { return pctOf(s, 0.9); }

/**
 * 一次遍历同时得到 p50 / p90 / cap，避免三次重复扫描直方图
 * @param {object} s 统计对象
 * @returns {{p50:number,p90:number,cap:number}} 分位与能力值
 */
export function pcts(s: NodeStats) {
  if (!s || !s.hist) return { p50: 0, p90: 0, cap: s && s.seedBps ? s.seedBps : 0 };
  let tot = 0;
  for (let i = 0; i < HIST_N; i++) tot += s.hist[i];
  if (!(tot > 0)) return { p50: 0, p90: 0, cap: s.seedBps || 0 };
  let acc = 0, p50 = 0, p90 = 0;
  const at = (i: number, prev: number, target: number) => HIST_BASE * Math.pow(2, i - 0.5 + (s.hist[i] > 0 ? Math.max(0, Math.min(1, (target - prev) / s.hist[i])) : 1));
  for (let i = 0; i < HIST_N; i++) {
    const prev = acc;
    acc += s.hist[i];
    if (!p50 && acc >= tot * 0.5) p50 = at(i, prev, tot * 0.5);
    if (acc >= tot * 0.9) { p90 = at(i, prev, tot * 0.9); break; }
  }
  if (!p90) p90 = HIST_BASE * Math.pow(2, HIST_N - 0.5);
  const cap = p50 > 0 ? Math.min(p90, p50 * 2.5) : p90;
  return { p50, p90, cap };
}

/** 用于排序的"能力值"：p90 与 p50 取折中，单次突发不能定生死 */
export function capOf(s: NodeStats) {
  if (!s) return 0;
  const p90 = pctOf(s, 0.9);
  const p50 = pctOf(s, 0.5);
  if (!(p90 > 0)) return s.seedBps || 0;
  if (!(p50 > 0)) return p90;
  return Math.min(p90, p50 * 2.5);
}

/** 近期吞吐峰值（p90，带衰减的直方图插值） */
export function p90Of(s: NodeStats) { return pctOf(s, 0.9); }

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
  const Lobs = tcp + tls * SC.TLS_G + Math.max(0, tls - 2 * tcp - SC.LOSS_SLACK) * SC.LOSS_G;
  const Lprior = (a && a.ms) || (SC.P_TCP + SC.P_TLS * SC.TLS_G);
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
  S.rankCache.t = 0;
}

/**
 * 中转后仍然大量空关闭 → 这个节点基本是坏的。
 * 只看"走了中转"的口径，直连空关闭是目标站的问题，不能算到节点头上。
 * @param {string} k "host:port"
 * @returns {boolean} 是否可疑
 */
export function emptyCloseSuspect(k: string) {
  const s = S.nstat.get(k);
  if (!s) return false;
  const viaP = s.eCloseP || 0;
  const attempts = (s.tS || 0) + viaP;
  return attempts >= 5 && viaP / attempts > 0.5;
}

/** 候选列表（已过滤黑名单/冻结，按代价升序） */
const CAND_TTL = 20000;      // 排行缓存有效期
const CAND_CACHE_MIN = 24;   // 候选少的时候不必缓存（重算也就几十 µs）

export function candsFor(mode: Mode) {
  const m: Mode = mode === "tput" ? "tput" : "lat";
  const useCache = S.alive.size >= CAND_CACHE_MIN;
  if (useCache) {
    const c = S.rankCache;
    if (c.t && Date.now() - c.t < CAND_TTL && c.v[m]) {
      // 缓存只冻结排序，不冻结"能不能用"：黑名单/冻结每次都要重新过滤
      return c.v[m].filter((r) => S.alive.has(r.k) && !isBlack(r.k) && !isFrozen(r.k));
    }
  }
  const out: { k: string; v: number }[] = [];
  for (const k of S.alive.keys()) {
    if (isBlack(k) || isFrozen(k)) continue;
    const s = (S.nstat.get(k) || ZERO_STAT);
    const e = effView(s);
    const n = e.okW + e.failW;
    // 小样本只做软惩罚（pFailRisk），别让一两次失败直接失去候选资格
    if (n >= 8 && availOf(s) < 0.4) continue;
    if (emptyCloseSuspect(k)) continue;               // 中转后仍大量空关闭
    out.push({ k, v: costOf(k, m) });
  }
  out.sort((a, b) => a.v - b.v);
  S.candN = out.length;
  if (useCache) S.rankCache = { t: Date.now(), v: { ...S.rankCache.v, [m]: out } };
  return out;
}

/**
 * 换一个节点（排除指定的那个），用于"这个节点断了再试下一个"
 * @param {string} mode "lat" | "tput"
 * @param {string} avoid 要避开的节点
 * @returns {string} 节点 key，没有可换的返回 ""
 */
export function nextNode(mode: Mode, avoid: string) {
  const c = candsFor(mode);
  for (const x of c) if (x.k !== avoid) return x.k;
  return "";
}

/** 当前最优 */
export function bestFor(mode: Mode) {
  const c = candsFor(mode);
  return c.length ? c[0].k : "";
}

/* ---- 落盘节流：变化驱动 + 90 分钟地板（SEED_WRITE_GAP 定义在 px.ts） ---- */

export function markSeedDirty(env: Env) {
  if (!env || !env.STATS) return;
  const last = Math.max(S.nsWriteAt, S.seed.ts || 0);
  if (Date.now() - last < SEED_WRITE_GAP) return;
  S.nsWriteAt = Date.now();
  SEEDS.write(env).catch(() => {});
}

