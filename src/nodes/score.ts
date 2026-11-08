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
export function nsGet(k: any): NodeStats {
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
      seedBps: 0, counted: 0,
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
export function nsDecay(s: any, now: any) {
  if (!s) return;
  if (!s.at) { s.at = now; return; }
  const k = Math.pow(0.5, (now - s.at) / SC.HL);
  if (k >= 0.9999) return;
  s.okW *= k; s.failW *= k; s.stallMs *= k; s.runMs *= k;
  s.pN *= k; s.pSum *= k; s.pSumSq *= k; s.pF *= k; s.tS *= k; s.tF *= k;
  if (s.hist) for (let i = 0; i < HIST_N; i++) s.hist[i] *= k;
  s.at = now;
}

/**
 * 记一次成功（同时更新握手耗时 EWMA）。
 * @param {string} k "host:port"
 * @param {number} [tcp] TCP 建连毫秒
 * @param {number} [tls] TLS 往返毫秒
 * @returns {void}
 */
export function nsOk(k: any, tcp: any, tls: any) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  s.okW += 1; s.ok += 1; s.tS = (s.tS || 0) + 1;
  s.streak = 0; s.blackUntil = 0; s.at = now;
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
export function nsProbe(k: any, ms: any, tcp: any, tls: any) {
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
export function nsProbeFail(k: any) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  s.pF += 1;
  if (s.pF >= 2) s.blackUntil = Math.max(s.blackUntil || 0, now + 10 * 60000);
  s.at = now;
}

/**
 * 记一次失败，并按指数退避设置冷却。
 * @param {string} k "host:port"
 * @returns {void}
 */
export function nsFail(k: any) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  s.failW += 1; s.fail += 1; s.tF = (s.tF || 0) + 1;
  s.streak = (s.streak || 0) + 1;
  const ladder = [60000, 300000, 900000, 3600000];
  s.blackUntil = now + ladder[Math.min(s.streak, 4) - 1];
  if (s.streak >= 4) s.streak = 0;     // 给第五次机会
  s.at = now;
  S.hostRankCache.clear();             // 冷却中的节点不该继续被站点排行推荐
}

/**
 * 记录一个吞吐样本：进 log2 直方图（带衰减，所以 p90 反映"近期峰值"）。
 * @param {string} k "host:port"
 * @param {number} bps 字节/秒
 * @param {number} bytes 该样本覆盖的字节数
 * @param {object} [env] 用于节流落盘
 * @returns {void}
 */
export function nsSpeed(k: any, bps: any, bytes: any, env: any) {
  if (!k || !(bps > 0)) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  const i = Math.max(0, Math.min(HIST_N - 1, Math.round(Math.log2(Math.max(bps, 1) / HIST_BASE))));
  s.hist[i] += 1;
  s.seedBps = 0;                                   // 本地有样本了，导入值作废
  s.bytesDown = (s.bytesDown || 0) + (bytes || 0);
  s.at = now;
  S.seedDirty = true;
}

/** 记录卡顿时长（背压累计） */
export function nsStall(k: any, stallMs: any, runMs: any) {
  if (!k) return;
  const s = nsGet(k), now = Date.now();
  nsDecay(s, now);
  s.stallMs += stallMs || 0;
  s.runMs += runMs || 0;
  s.at = now;
}

/** 记录本地实测延迟（探活用） */
export function nsLatency(k: any, ms: any) {
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
export function pFailOf(s: any) {
  if (!s) return 0.4;
  const ok = s.tS || 0;
  const bad = s.tF || 0;
  const n = ok + bad;
  const p = (bad + 1) / (n + 10);
  const se = Math.sqrt(Math.max(p * (1 - p), 0.01) / (n + 1));
  return Math.min(0.9, p + se);
}

/** 可用性（小样本用后验均值，大样本用 Wilson 下界） */
export function availOf(s: any) {
  if (!s) return 0.5;
  const ok = s.tS || 0, bad = s.tF || 0;
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
export function pStallOf(s: any) {
  if (!s) return 0.05;
  return (s.stallMs + 50) / (s.runMs + 1000);
}

/**
 * 直方图分位（连续插值）。q=0.9 是峰值能力，q=0.5 是中位。
 * 用插值而不是"落到哪个桶就返回哪个桶"，否则分位会在 2 倍档之间来回跳，
 * 排序跟着跳，表现就是"节点速率忽快忽慢"。
 * @param {object} s 统计对象
 * @param {number} q 0~1
 * @returns {number} 字节/秒
 */
export function pctOf(s: any, q: any) {
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
export function p90Local(s: any) { return pctOf(s, 0.9); }

/**
 * 一次遍历同时得到 p50 / p90 / cap，避免三次重复扫描直方图
 * @param {object} s 统计对象
 * @returns {{p50:number,p90:number,cap:number}} 分位与能力值
 */
export function pcts(s: any) {
  if (!s || !s.hist) return { p50: 0, p90: 0, cap: s && s.seedBps ? s.seedBps : 0 };
  let tot = 0;
  for (let i = 0; i < HIST_N; i++) tot += s.hist[i];
  if (!(tot > 0)) return { p50: 0, p90: 0, cap: s.seedBps || 0 };
  let acc = 0, p50 = 0, p90 = 0;
  const at = (i: any, prev: any, target: any) => HIST_BASE * Math.pow(2, i - 0.5 + (s.hist[i] > 0 ? Math.max(0, Math.min(1, (target - prev) / s.hist[i])) : 1));
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
export function capOf(s: any) {
  if (!s) return 0;
  const p90 = pctOf(s, 0.9);
  const p50 = pctOf(s, 0.5);
  if (!(p90 > 0)) return s.seedBps || 0;
  if (!(p50 > 0)) return p90;
  return Math.min(p90, p50 * 2.5);
}

/** 近期吞吐峰值（p90，带衰减的直方图插值） */
export function p90Of(s: any) { return pctOf(s, 0.9); }

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
  stallMs: 0, runMs: 0, bytesDown: 0, hist: new Array(HIST_N).fill(0), seedBps: 0, counted: 0,
};

export const TEN_MB = 10 * 1048576;
export const E10_PRIOR = (TEN_MB / SC.PRIOR_BPS) * 1000;   // 无吞吐样本时的先验代价（≈51 秒）

export function costOf(k: any, mode: any) {
  const m = mode === "tput" ? "tput" : "lat";
  const s = S.nstat.get(k) || ZERO_STAT;   // 空对象会让 pStall 变 NaN，必须用带零值的占位
  const a = (S.alive.get(k) || {}) as NodeEntry;
  const tcp = s.tcp || Number(a.ms) || SC.P_TCP;
  const tls = s.tls || SC.P_TLS;
  // 置信度必须跟 pFail 用同一套计数（tS/tF），否则会出现
  // "失败率变了、分数却不动"的诡异现象（单测抓到的）
  const n = (s.tS || 0) + (s.tF || 0) || (s.okW || 0) + (s.failW || 0);

  // 只有"没观测到"的那部分才向先验收缩。
  // 早先整条 v 一起收缩，导致 tput 在没有吞吐样本时所有节点被压成同一个数，
  // 排序退化成随机 —— 下载就会随机落在一个慢节点上。
  const confF = 1 - Math.exp(-n / 4);
  const pF = pFailOf(s) * confF + 0.1 * (1 - confF);
  const pS = pStallOf(s);

  let v;
  let cap = 0;                                   // tput 模式下的能力值，只算一次
  if (m === "tput") {
    cap = capOf(s);
    const okB = (s.bytesDown || 0) >= 3 * 1048576 && n >= 3 && cap > 0;
    const confB = okB ? 1 - Math.exp(-n / 8) : 0;
    const e10 = okB ? (TEN_MB / cap) * 1000 : E10_PRIOR;
    v = e10 * confB + E10_PRIOR * (1 - confB) + tcp * 0.5 + pF * SC.FAIL + pS * SC.STALL;
  } else {
    v = tcp + tls * SC.TLS_G + Math.max(0, tls - 2 * tcp - SC.LOSS_SLACK) * SC.LOSS_G
      + pF * SC.FAIL + pS * SC.STALL;
  }
  if (pS > 0.25 && n >= 5) v += 400;
  // 吞吐低到 8 KB/s 以下基本等于不可用（早先这里又算了一遍 capOf）
  if (m === "tput" && cap > 0 && cap < 8 * 1024 && n >= 5) v += 400;
  return v;
}

/** 面板展示用的分值（越小越好） */
export function scoreMerged(k: any, _ns?: any) { return costOf(k, "lat"); }

/** 是否处于冷却期 */
export function isBlack(k: any) {
  const s = S.nstat.get(k);
  return !!(s && s.blackUntil > Date.now());
}
/** 是否被回滚冻结 */
export function isFrozen(k: any) {
  const s = S.nstat.get(k);
  return !!(s && s.freeUntil > Date.now());
}
/** 冻结一个刚出问题的节点 */
export function freezeNode(k: any) {
  if (!k) return;
  const s = nsGet(k);
  s.freeUntil = Date.now() + SC.ROLL_FREEZE;
  S.hostRankCache.clear();     // 站点排行里不能再推荐它
}

/**
 * 中转后仍然大量空关闭 → 这个节点基本是坏的。
 * 只看"走了中转"的口径，直连空关闭是目标站的问题，不能算到节点头上。
 * @param {string} k "host:port"
 * @returns {boolean} 是否可疑
 */
export function emptyCloseSuspect(k: any) {
  const s = S.nstat.get(k);
  if (!s) return false;
  const viaP = s.eCloseP || 0;
  const attempts = (s.tS || 0) + viaP;
  return attempts >= 5 && viaP / attempts > 0.5;
}

/** 候选列表（已过滤黑名单/冻结，按代价升序） */
export function candsFor(mode: any) {
  const out: any[] = [];
  for (const k of S.alive.keys()) {
    if (isBlack(k) || isFrozen(k)) continue;
    const s = (S.nstat.get(k) || ZERO_STAT);
    const n = (s.tS || 0) + (s.tF || 0);
    if (n >= 5 && availOf(s) < 0.75) continue;        // 可用性硬门槛
    if (emptyCloseSuspect(k)) continue;               // 中转后仍大量空关闭
    out.push({ k, v: costOf(k, mode) });
  }
  out.sort((a, b) => a.v - b.v);
  return out;
}

/**
 * 换一个节点（排除指定的那个），用于"这个节点断了再试下一个"
 * @param {string} mode "lat" | "tput"
 * @param {string} avoid 要避开的节点
 * @returns {string} 节点 key，没有可换的返回 ""
 */
export function nextNode(mode: any, avoid: any) {
  const c = candsFor(mode);
  for (const x of c) if (x.k !== avoid) return x.k;
  return "";
}

/** 当前最优 */
export function bestFor(mode: any) {
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

