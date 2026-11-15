import { HIST_BASE, HIST_N } from "./const";

/* 直方图分位：纯函数，供 score / metrics / seed / 面板共用 */
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
  // 目标计数 = 总量 × q；累加跨过它时在本桶内线性插值，把桶号换算成 2 的幂次刻度上的连续值
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
  // 累加不到（直方图有空洞）就退化成最大值桶，宁可报高也不报 0——0 会被当成「没网」
  return HIST_BASE * Math.pow(2, HIST_N - 0.5);
}

/**
 * 一次遍历同时得到 p50 / p90 / cap，避免三次重复扫描直方图
 * @param {object} s 统计对象
 * @returns {{p50:number,p90:number,cap:number}} 分位与能力值
 */
export function pcts(s: NodeStats) {
  if (!s || !s.hist) return { p50: 0, p90: 0, cap: 0 };
  let tot = 0;
  for (let i = 0; i < HIST_N; i++) tot += s.hist[i];
  if (!(tot > 0)) return { p50: 0, p90: 0, cap: 0 };
  let acc = 0,
    p50 = 0,
    p90 = 0;
  // 单遍扫描同时取 p50 与 p90：acc 是累计计数、prev 是本桶之前的累计；插值公式与 pctOf 必须一致，否则面板对不上
  const at = (i: number, prev: number, target: number) =>
    HIST_BASE * Math.pow(2, i - 0.5 + (s.hist[i] > 0 ? Math.max(0, Math.min(1, (target - prev) / s.hist[i])) : 1));
  for (let i = 0; i < HIST_N; i++) {
    const prev = acc;
    acc += s.hist[i];
    if (!p50 && acc >= tot * 0.5) p50 = at(i, prev, tot * 0.5);
    if (acc >= tot * 0.9) {
      p90 = at(i, prev, tot * 0.9);
      break;
    }
  }
  if (!p90) p90 = HIST_BASE * Math.pow(2, HIST_N - 0.5);
  // cap 是「能力值」：p90 容易被一次突发拉高，用 p50×2.5 封顶，避免按峰值给节点定价
  const cap = p50 > 0 ? Math.min(p90, p50 * 2.5) : p90;
  return { p50, p90, cap };
}

/** 用于排序的"能力值"：p90 与 p50 取折中，单次突发不能定生死 */
export function capOf(s: NodeStats) {
  if (!s) return 0;
  const p90 = pctOf(s, 0.9);
  const p50 = pctOf(s, 0.5);
  if (!(p90 > 0)) return 0;
  if (!(p50 > 0)) return p90;
  return Math.min(p90, p50 * 2.5);
}

/** 近期吞吐峰值（p90，带衰减的直方图插值） */
export function p90Of(s: NodeStats) {
  return pctOf(s, 0.9);
}

