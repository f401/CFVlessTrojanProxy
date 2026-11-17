// 节点统计的纯派生层：衰減、衰減后的视图、失败概率、可用性、卡顿概率。
// 全部是「吃一个 NodeStats，吐一个数」，不读 S、不写 S —— 单测可以随便造条目。

import { HIST_N, SC } from "../core/const";
import type { EffView } from "./stat-types";

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
