import { HIST_BASE, HIST_N, SC } from "../core/const";
import { pcts } from "../core/hist";
import { S } from "../core/state";

/* 节点统计原语：衰减、滑动窗口、EWMA/MAD、CUSUM、概率与可用性。 */
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
      pN: 0, pSum: 0, pSumSq: 0, pF: 0, cus: 0, cusB: 0,   // 探活样本 / ttfb 矩 / 变点
      tS: 0, tF: 0,                            // 真实流量（只用于可用性）
      eCloseP: 0, eCloseD: 0,                  // 空关闭：中转后 / 直连
      bytesDown: 0, hist: new Array(HIST_N).fill(0),
      sumW: 0, sumW2: 0, recentBytesW: 0, lastSampleAt: 0,
      counted: 0,
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
  s.pN *= k; s.pF *= k; s.tS *= k; s.tF *= k;
  // pSum/pSumSq 是真实首字节的 EWMA 一二阶矩（nsLatency 写），不是权重，不随半衰期缩放
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
  const wasCool = s.blackUntil > now || s.freeUntil > now;
  s.streak = 0; s.blackUntil = 0; s.freeUntil = 0;   // 真流量成功：黑名单和冻结都解除
  // 只有"刚才还在冷却/冻结"才需要打掉候选缓存；每条成功连接都清会让 2 s 过滤缓存永远失效
  if (wasCool) invalidateRank();
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
  s.pN += 1;
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
  // 阶梯跟池子大小走：小池子把节点关 20 分钟等于把池子关掉（5 个节点关掉 1 个剩 4 个）。
  // 大池子才敢用长冷却 —— 800 个候选里挑最慢的比挑"刚失败过的"更亏。
  const small = S.alive.size < 8;
  const ladder = small ? [10000, 60000, 180000, 300000] : [60000, 300000, 900000, 1200000];
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
  // 变点检测要跟"旧水位"比，所以先留一份；下面 pcts 会把它算成新值
  const prevCap = s.capBps || 0;
  const i = Math.max(0, Math.min(HIST_N - 1, Math.round(Math.log2(Math.max(bps, 1) / HIST_BASE))));
  // 加权直方图：一个 8MB/s 的长连接和一个 200KB/s 的短连接不该等权
  s.hist[i] += weight;
  s.sumW += weight;
  s.sumW2 += weight * weight;
  s.recentBytesW += (bytes || 0) * weight;
  s.lastSampleAt = now;
  // 分位只跟直方图形状有关，而衰减是等比缩放 → 采样时算一次就够，读的时候 O(1)
  s.capBps = pcts(s).cap;
  // 吞吐变点：相对旧 cap 掉六成以上累积对数跌幅，越线立刻丢旧直方图（塌了的节点必须马上掉分）
  if (prevCap > 0 && bps < prevCap * 0.6) s.cusB += Math.log2(prevCap / Math.max(1, bps)) - 0.3;
  else s.cusB = Math.max(0, s.cusB - 0.15);
  if (s.cusB > 1.2) {
    s.cusB = 0;
    s.hist = s.hist.map((v) => v * 0.2);
    s.sumW *= 0.2;
    s.sumW2 *= 0.04;
    s.recentBytesW *= 0.2;
    s.capBps = Math.round(bps);
  }
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

/** 记录本地实测延迟（ttfb，主延迟信号）：winsorize 后进 EWMA，MAD 进 pSumSq，偏离累积进 cus */
export function nsLatency(k: string, ms: number) {
  if (!k || !(ms > 0)) return;
  const s = nsGet(k);   // 必须走 nsGet，否则缺 stallMs/runMs 会让 pStall 变 NaN
  const base = s.pSum || ms;
  const x = Math.min(ms, base * 3 + 200);   // 一条 2 秒的怪连接不该把均值抬高一周
  s.pSum = s.pSum ? s.pSum * 0.6 + x * 0.4 : x;
  s.pSumSq = s.pSumSq ? s.pSumSq * 0.6 + Math.abs(x - base) * 0.4 : 0;   // MAD，不是方差
  s.msLocal = Math.round(s.pSum);
  // CUSUM：连续偏高才累加，越过 h 立刻挪走流量（比失败阶梯早好几个样本）
  s.cus = Math.max(0, s.cus + ms - base - Math.max(SC.CUSUM_K, base * 0.25));
  if (s.cus > SC.CUSUM_H) {
    s.cus = 0;
    s.freeUntil = Math.max(s.freeUntil, Date.now() + SC.CUSUM_FREEZE);
    invalidateRank(); // 冻结立刻从候选表里消失，不能等 2 s 过滤缓存过期
    s.pSum = (s.pSum + ms) / 2;   // 认账：以新水位为基准，否则旧基线会一直报警
    s.msLocal = Math.round(s.pSum);
  }
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

  // 只用本地样本：别的 isolate 的失败率不进 Beta 先验（v6.35 起 seed 只传名字）
  const a = SC.BETA_A + e.failW;
  const b = SC.BETA_B + e.okW;
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
  pN: 0, pSum: 0, pSumSq: 0, pF: 0, cus: 0, cusB: 0, tcp: 0, tls: 0, tS: 0, tF: 0, okW: 0, failW: 0, eCloseP: 0, eCloseD: 0,
  stallMs: 0, runMs: 0, bytesDown: 0, hist: new Array(HIST_N).fill(0),
  sumW: 0, sumW2: 0, recentBytesW: 0, lastSampleAt: 0,
  counted: 0,
  winAt: 0, winOk: 0, winFail: 0,
};

export const TEN_MB = 10 * 1048576;
export const E10_PRIOR = (TEN_MB / SC.PRIOR_BPS) * 1000;   // 无吞吐样本时的先验代价（≈5 秒，PRIOR_BPS=2MB/s）


/** 排行缓存作废：节点状态变了就调它（排序与时间戳一起清，避免只清一半）。
 *  表与进行中的分片进度都留着：否则每次失败都退化成「只有前 128 名」的半张表，
 *  失败密集时还会把分片循环反复打回起点（永远算不完一轮）。 */
export function invalidateRank() {
  const c = S.rankCache;
  S.rankCache = { t: 0, at: {}, v: c.v, step: c.step };
}
