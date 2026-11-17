// 节点统计的观测写入层：成功、探活、失败、站点失败、带宽、卡顿、首字节、空关闭。
// 每条都是「取条目 → 衰減 → 累加这一笔 → 必要时打掉排行缓存」，没有别的职责。

import { HIST_BASE, HIST_N, SC } from "../core/const";
import { pcts } from "../core/hist";
import { S } from "../core/state";
import { STATS } from "./stat-table";
import { EMPTY_CLOSE_BAD } from "./stat-types";
import { nsDecay } from "./stat-view";

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

/**
* 记一次空关闭（连接建立后 0 字节结束）。viaP=true 表示已经过了中转。
*/
export function nsEmptyClose(k: string, viaP: boolean) {
  if (!k) return;
  const s = STATS.nsGet(k), now = Date.now();
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
    STATS.invalidateRank();
  }
  s.at = now;
}

/** 记一次成功（同时更新握手耗时 EWMA）。 */
export function nsOk(k: string, tcp: number, tls: number) {
  if (!k) return;
  const s = STATS.nsGet(k), now = Date.now();
  nsDecay(s, now);
  bumpWin(s, now, true);
  s.okW += 1; s.ok += 1; s.trafficOkW = (s.trafficOkW || 0) + 1;
  const wasCool = s.blackUntil > now || s.freeUntil > now;
  s.streak = 0; s.blackUntil = 0; s.freeUntil = 0;   // 真流量成功：黑名单和冻结都解除
  // 只有"刚才还在冷却/冻结"才需要打掉候选缓存；每条成功连接都清会让 2 s 过滤缓存永远失效
  if (wasCool) STATS.invalidateRank();
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
export function nsProbe(k: string, ms: number, tcp: number, tls: number) {
  if (!k || !(ms > 0)) return;
  const s = STATS.nsGet(k), now = Date.now();
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
export function nsProbeFail(k: string) {
  if (!k) return;
  const s = STATS.nsGet(k), now = Date.now();
  nsDecay(s, now);
  s.probeFails += 1;
  if (s.probeFails >= 2) {
    s.blackUntil = Math.max(s.blackUntil || 0, now + 10 * 60000);
    // 探活也能拉黑节点：排行缓存里可能还留着它，下次 pick 不能继续推荐
    S.hostRankCache.clear();
    STATS.invalidateRank();
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
  const s = STATS.nsGet(k), now = Date.now();
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
  STATS.invalidateRank();                    // 失败改变了排序前提
}

/**
* 站点侧失败：连上了节点，但目标站 0 字节关闭 / 拒绝。
* 只轻记全局（0.2 次），不动连续失败阶梯 —— 一个站封了这个 IP，不该毁掉节点在别处的排名。
*/
export function nsSiteFail(k: string) {
  if (!k) return;
  const s = STATS.nsGet(k), now = Date.now();
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
export function nsSpeed(k: string, bps: number, bytes: number, _env: Env, w = 1) {
  if (!k || !(bps > 0)) return;
  const s = STATS.nsGet(k), now = Date.now();
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
export function nsStall(k: string, stallMs: number, runMs: number) {
  if (!k) return;
  const s = STATS.nsGet(k), now = Date.now();
  nsDecay(s, now);
  s.stallMs += stallMs || 0;
  s.runMs += runMs || 0;
  s.at = now;
}

/** 记录本地实测延迟（ttfb，主延迟信号）：winsorize 后进 EWMA，MAD 进 pSumSq，偏离累积进 cusumSum */
export function nsLatency(k: string, ms: number) {
  if (!k || !(ms > 0)) return;
  const s = STATS.nsGet(k);   // 必须走 nsGet，否则缺 stallMs/runMs 会让 pStall 变 NaN
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
    STATS.invalidateRank(); // 冻结立刻从候选表里消失，不能等 2 s 过滤缓存过期
    s.pSum = (s.pSum + ms) / 2;   // 认账：以新水位为基准，否则旧基线会一直报警
    s.msLocal = Math.round(s.pSum);
  }
}
