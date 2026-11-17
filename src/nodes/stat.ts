import { HIST_N, SC, HIST_BASE } from "../core/const";
import { S } from "../core/state";
import { pcts } from "../core/hist";

// ---- 形状与刻度 ----
// 节点统计的类型与上限常量：衰減视图、零值、10MB 参考量、空关闭门槛。
// 这里不许出现任何读取 S 的代码 —— 它是其余三个 stat 模块的共同底座。


/** 衰减后的视图（只读投影，供评分函数复用） */
export interface EffView {
  k: number;
  okW: number;
  failW: number;
  stallMs: number;
  runMs: number;
  sumW: number;
  sumW2: number;
  recentBytesW: number;
  probeSamples: number;
  latN: number;
}

/** 经中转的空关闭累计到多少次算「这条通道可疑」（跨过那一条才作废站点排行缓存） */
export const EMPTY_CLOSE_BAD = 5;

export const TEN_MB = 10 * 1048576;

/** 全零统计行：新建节点、单测与「没有任何样本」的兜底，字段必须与 NodeStats 一致 */
export const ZERO_STAT: NodeStats = {
  ok: 0, fail: 0, at: 0, msLocal: 0, streak: 0, blackUntil: 0, freeUntil: 0, lastTry: 0,
  probeSamples: 0, pSum: 0, pSumSq: 0, probeFails: 0, cusumSum: 0, cusumBase: 0, tcp: 0, tls: 0, trafficOkW: 0, trafficFailW: 0, okW: 0, failW: 0, eCloseP: 0,
  stallMs: 0, runMs: 0, bytesDown: 0, hist: new Array(HIST_N).fill(0),
  sumW: 0, sumW2: 0, recentBytesW: 0, lastSampleAt: 0,
  counted: 0,
  winAt: 0, winOk: 0, winFail: 0,
};

// ---- 并入自 stat-table.ts ----
// 节点统计表本体：只负责「按 host:port 取条目」与「打掉排行缓存」，
// 唯一碰 S.nstat / S.hostRankCache 的地方。统计怎么算在 ./stat-observe，
// 怎么读在 ./stat-view —— 拆开是因为「表」有状态、「算」与「读」没有。


/**
 * 功能：节点统计表本体 —— 按 host:port 取条目、打掉排行缓存，以及九个观测写入。
 * 为什么写入挂在类上：它们都要「取条目 → 衰减 → 累加 → 必要时作废缓存」这四步，
 * 而每一步的前提（表在 `S.nstat`、缓存在 `S.rankCache`）都是这张表自己的不变量；
 * 留在模块函数里等于把这四步的纪律散在九个地方各写一遍（7.282 之前就是这样）。
 * 条目本身挂在 S.nstat 上（跨请求共享），所以它是仓里少数几个必须有状态的类之一。
 */
export class NodeStatsTable {
  /**
  * 取节点统计对象（不存在则初始化）。
  * @param {string} k "host:port"
  * @returns {object} 统计对象
  */
  nsGet(k: string): NodeStats {
    let s: NodeStats | undefined = S.nstat.get(k);
    // 懒初始化：节点第一次被记样本时才建对象。字段分四组——可用性、探活样本、真实流量、
    // 字节直方图（hist 是 32 档对数刻度，pcts 在上面插值）
    if (!s) {
      s = {
        ok: 0, fail: 0, at: 0, msLocal: 0,
        streak: 0, blackUntil: 0, freeUntil: 0, lastTry: 0,
        tcp: 0, tls: 0, okW: 0, failW: 0, stallMs: 0, runMs: 0,
        probeSamples: 0, pSum: 0, pSumSq: 0, probeFails: 0, cusumSum: 0, cusumBase: 0,   // 探活样本 / ttfb 矩 / 变点
        trafficOkW: 0, trafficFailW: 0,                            // 真实流量（只用于可用性）
        eCloseP: 0,                               // 空关闭：只记「走了中转」的口径（直连侧走 cnt("eCloseD")，不进节点统计）
        bytesDown: 0, hist: new Array(HIST_N).fill(0),
        sumW: 0, sumW2: 0, recentBytesW: 0, lastSampleAt: 0,
        counted: 0,
        winAt: 0, winOk: 0, winFail: 0,
      };
      // 只在这里 set：别处一律拿引用改字段——换对象会让正在跑的连接持有的旧引用失效
      S.nstat.set(k, s);
    }
    return s;
  }

  /** 排行缓存作废：节点状态变了就调它（排序与时间戳一起清，避免只清一半）。
  *  表与进行中的分片进度都留着：否则每次失败都退化成「只有前 128 名」的半张表，
  *  失败密集时还会把分片循环反复打回起点（永远算不完一轮）。 */
  invalidateRank() {
    const c = S.rankCache;
    S.rankCache = { t: 0, at: {}, v: c.v, step: c.step };
  }

  /**
  * 记一次空关闭（连接建立后 0 字节结束）。viaP=true 表示已经过了中转。
  */
  nsEmptyClose(k: string, viaP: boolean) {
    if (!k) return;
    const s = this.nsGet(k), now = Date.now();
    nsDecay(s, now);
    const before = s.eCloseP || 0;
    // 只记「走了中转」这一口径：直连空关闭是目标站的问题，不进节点统计
    // （全局计数走 cnt("eCloseD")，与这张表不是同一份数据）
    if (viaP) s.eCloseP = before + 1;
    // 只有「这一条刚好把计数推过门槛」才作废缓存。
    // 原写法判的是 `eCloseP >= 5`，而 eCloseP 按 `SC.HL`（6 小时）半衰期衰减 ——
    // 一旦跨过就至少挂几个小时，这段时间里**每一条**空关闭都会清掉整张站点排行缓存
    // （最多 80 个站点），等于把缓存关掉。`nsOk` 里那条「每条成功连接都清会让过滤缓存
    // 永远失效」是同一个教训，这里漏改了。
    if (viaP && before < EMPTY_CLOSE_BAD && s.eCloseP >= EMPTY_CLOSE_BAD) {
      S.hostRankCache.clear();
      this.invalidateRank();
    }
    s.at = now;
  }

  /** 记一次成功（同时更新握手耗时 EWMA）。 */
  nsOk(k: string, tcp: number, tls: number) {
    if (!k) return;
    const s = this.nsGet(k), now = Date.now();
    nsDecay(s, now);
    bumpWin(s, now, true);
    s.okW += 1; s.ok += 1; s.trafficOkW = (s.trafficOkW || 0) + 1;
    const wasCool = s.blackUntil > now || s.freeUntil > now;
    s.streak = 0; s.blackUntil = 0; s.freeUntil = 0;   // 真流量成功：黑名单和冻结都解除
    // 只有"刚才还在冷却/冻结"才需要打掉候选缓存；每条成功连接都清会让 2 s 过滤缓存永远失效
    if (wasCool) this.invalidateRank();
    s.at = now;
    if (tcp > 0) s.tcp = s.tcp ? s.tcp * (1 - SC.A) + tcp * SC.A : tcp;
    if (tls > 0) s.tls = s.tls ? s.tls * (1 - SC.A) + tls * SC.A : tls;
  }

  /**
  * 记一次探活结果：只累加探活样本数与 tcp/tls 的 EWMA，不参与可用性、也不解除熔断。
  * `ms`（握手总耗时）只用来筛掉非正样本，**不写** `pSum`/`pSumSq`：
  * 那两个字段是「真实首字节」的一二阶矩，混进探活 RTT 会让还没承载用户流量的节点
  * 平白多出一份抖动罚（`jitMs = pSumSq * 1.4826`），而探活本来就在 `probeL` 里另算。
  * @param {string} k "host:port"
  * @param {number} ms 握手总耗时（仅校验）
  * @param {number} tcp 建连耗时
  * @param {number} tls TLS 往返
  * @returns {void}
  */
  nsProbe(k: string, ms: number, tcp: number, tls: number) {
    if (!k || !(ms > 0)) return;
    const s = this.nsGet(k), now = Date.now();
    nsDecay(s, now);
    s.probeSamples += 1;
    s.probeFails *= 0.5;
    // 探活只动探活计数与 tcp/tls 的 EWMA：不要动 s.ok，否则面板成功率会被探测次数灌水；
    // 也不要写 pSum/pSumSq —— 它们是真实首字节矩，混进来会给「还没承载流量」的节点加抖动罚
    if (tcp > 0) s.tcp = s.tcp ? s.tcp * (1 - SC.A) + tcp * SC.A : tcp;
    if (tls > 0) s.tls = s.tls ? s.tls * (1 - SC.A) + tls * SC.A : tls;
    s.at = now;
  }

  /**
  * 探活失败：连续两次才拉黑 10 分钟（单次超时很常见，不能误杀）。
  * @param {string} k "host:port"
  * @returns {void}
  */
  nsProbeFail(k: string) {
    if (!k) return;
    const s = this.nsGet(k), now = Date.now();
    nsDecay(s, now);
    s.probeFails += 1;
    if (s.probeFails >= 2) {
      s.blackUntil = Math.max(s.blackUntil || 0, now + 10 * 60000);
      // 探活也能拉黑节点：排行缓存里可能还留着它，下次 pick 不能继续推荐
      S.hostRankCache.clear();
      this.invalidateRank();
    }
    s.at = now;
  }

  /**
  * 记一次失败，并按指数退避设置冷却。
  * @param {string} k "host:port"
  * @returns {void}
  */
  nsFail(k: string) {
    if (!k) return;
    const s = this.nsGet(k), now = Date.now();
    nsDecay(s, now);
    bumpWin(s, now, false);
    s.failW += 1; s.fail += 1; s.trafficFailW = (s.trafficFailW || 0) + 1;
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
    this.invalidateRank();                    // 失败改变了排序前提
  }

  /**
  * 站点侧失败：连上了节点，但目标站 0 字节关闭 / 拒绝。
  * 只轻记全局（0.2 次），不动连续失败阶梯 —— 一个站封了这个 IP，不该毁掉节点在别处的排名。
  */
  nsSiteFail(k: string) {
    if (!k) return;
    const s = this.nsGet(k), now = Date.now();
    nsDecay(s, now);
    s.failW += 0.2;
    s.fail += 0.2;       // 面板成功率与 failW 用同一份权重，别让一个被封的站把节点显示成 50%
    s.trafficFailW = (s.trafficFailW || 0) + 0.2;
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
  nsSpeed(k: string, bps: number, bytes: number, _env: Env, w = 1) {
    if (!k || !(bps > 0)) return;
    const s = this.nsGet(k), now = Date.now();
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
    if (prevCap > 0 && bps < prevCap * 0.6) s.cusumBase += Math.log2(prevCap / Math.max(1, bps)) - 0.3;
    else s.cusumBase = Math.max(0, s.cusumBase - 0.15);
    if (s.cusumBase > 1.2) {
      s.cusumBase = 0;
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
  nsStall(k: string, stallMs: number, runMs: number) {
    if (!k) return;
    const s = this.nsGet(k), now = Date.now();
    nsDecay(s, now);
    s.stallMs += stallMs || 0;
    s.runMs += runMs || 0;
    s.at = now;
  }

  /** 记录本地实测延迟（ttfb，主延迟信号）：winsorize 后进 EWMA，MAD 进 pSumSq，偏离累积进 cusumSum */
  nsLatency(k: string, ms: number) {
    if (!k || !(ms > 0)) return;
    const s = this.nsGet(k);   // 必须走 nsGet，否则缺 stallMs/runMs 会让 pStall 变 NaN
    const base = s.pSum || ms;
    const x = Math.min(ms, base * 3 + 200);   // 一条 2 秒的怪连接不该把均值抬高一周
    s.pSum = s.pSum ? s.pSum * 0.6 + x * 0.4 : x;
    s.pSumSq = s.pSumSq ? s.pSumSq * 0.6 + Math.abs(x - base) * 0.4 : 0;   // MAD，不是方差
    s.msLocal = Math.round(s.pSum);
    // CUSUM：连续偏高才累加，越过 h 立刻挪走流量（比失败阶梯早好几个样本）
    s.cusumSum = Math.max(0, s.cusumSum + ms - base - Math.max(SC.CUSUM_K, base * 0.25));
    if (s.cusumSum > SC.CUSUM_H) {
      s.cusumSum = 0;
      s.freeUntil = Math.max(s.freeUntil, Date.now() + SC.CUSUM_FREEZE);
      this.invalidateRank(); // 冻结立刻从候选表里消失，不能等 2 s 过滤缓存过期
      s.pSum = (s.pSum + ms) / 2;   // 认账：以新水位为基准，否则旧基线会一直报警
      s.msLocal = Math.round(s.pSum);
    }
  }
}

export const STATS = new NodeStatsTable();


// ---- 派生层（纯函数） ----
// 全部是「吃一个 NodeStats，吐一个数」，不读 S、不写 S —— 单测可以随便造条目。
// 节点统计的纯派生层：衰減、衰減后的视图、失败概率、可用性、卡顿概率。
// 全部是「吃一个 NodeStats，吐一个数」，不读 S、不写 S —— 单测可以随便造条目。


const LN2 = Math.LN2;

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
  s.probeSamples *= k; s.probeFails *= k; s.trafficOkW *= k; s.trafficFailW *= k;
  // pSum/pSumSq 是真实首字节的 EWMA 一二阶矩（nsLatency 写），不是权重，不随半衰期缩放
  // 空关闭计数必须一起衰减：trafficOkW 衰减而它不衰减，比值会单调涨，
  // 最终把曾经抽风过一次的节点永久踢出候选表。
  s.eCloseP *= k;
  s.sumW *= k; s.sumW2 *= k * k; s.recentBytesW *= k;
  if (s.hist) for (let i = 0; i < HIST_N; i++) s.hist[i] *= k;
  s.at = now;
}

/**
 * 功能：把「距样本时间已过 ms 毫秒」折算成权重系数 2^(-ms/HALF_LIFE)。
 * @param ms 已过去的毫秒数（<=0 视为不过期）
 * @returns 权重系数，1 表示不衰减
 */
export function ageFactor(ms: number): number {
  if (!(ms > 0)) return 1;
  return Math.exp((-ms / SC.HL) * LN2);
}

/**
* 读时有效视图（纯函数）。
* 存储里的权重是"上次写入时刻"的值；隔了多久就按半衰期折算多少。
*/
export function effView(s: NodeStats, now = Date.now()): EffView {
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
    probeSamples: s.probeSamples * k,
    // 延迟观测数：探活 + 成功连接（两者都提供握手耗时）
    latN: (s.probeSamples + s.okW) * k,
  };
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
  // 样本够多才用 Wilson 下界：小样本时下界会贴着 0，把「还没测过」当成「多半不行」
  if (n >= 30) {
    // z=1.96 是 95% 置信区间的双侧分位
    const phat = ok / n, z = 1.96;
    const den = 1 + (z * z) / n;
    const mid = phat + (z * z) / (2 * n);
    const adj = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
    return Math.max(0, (mid - adj) / den);
  }
  // 小样本退回 Beta(1,1) 后验均值：先验先给 0.5，别让一条失败就判死
  return (ok + 1) / (n + 2);
}

/** 卡顿占比（无数据 = 0.05） */
export function pStallOf(s: NodeStats, now = Date.now(), e0?: ReturnType<typeof effView>): number {
  if (!s) return 0.05;
  const e = e0 || effView(s, now);
  return (e.stallMs + 50) / (e.runMs + 1000);
}

// ---- 写入层（NodeStatsTable 的方法） ----
// 成功、探活、失败、站点失败、带宽、卡顿、首字节、空关闭都挂在表本体上：
// 每条都是「this.nsGet 取条目 → 衰减 → 累加这一笔 → 必要时打掉排行缓存」。
// 节点统计的观测写入层：成功、探活、失败、站点失败、带宽、卡顿、首字节、空关闭。
// 每条都是「取条目 → 衰減 → 累加这一笔 → 必要时打掉排行缓存」，没有别的职责。


/**
 * 功能：把快速失败窗口的计数按半衰期折算后，再累加一次成功/失败。
 * 与「N 分钟内计数、到点清零」相比，指数衰减不会在到点时把风险曲线拉成断崖。
 * @param s 节点统计行
 * @param now 当前时间戳（毫秒）
 * @param ok 本次是成功（true）还是失败（false）
 * @returns 无
 */
function bumpWin(s: NodeStats, now: number, ok: boolean) {
const k = s.winAt ? Math.pow(0.5, Math.max(0, now - s.winAt) / SC.WIN_HL) : 0;
s.winOk *= k;
s.winFail *= k;
s.winAt = now;
if (ok) s.winOk += 1;
else s.winFail += 1;
}


// ---- 对外导出面 ----
// 表本体（`STATS`）是唯一有状态的东西；派生层是纯函数；十一个同名转发在 7.302 全删，
// 调用点直接写 `STATS.nsOk(...)` / `STATS.nsFail(...)`，动词不再与实际对象脱节。
// 节点统计的门面：文件曾经 484 行、24 个方法加 24 个同名薄包装，
// 7.282 按「表 / 派生 / 观测」拆成三个模块，这里只做再导出，
// 调用点（score.ts 的 `export *`、attacher/dialer/region 的 nsFail）一字未改。

