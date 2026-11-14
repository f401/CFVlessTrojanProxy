import { srcHealth } from "./probe";

/**
 * 活跃池的目标规模。
 *
 * 为什么是 16：仿真里「稳态好出口比例」只有 `r/(d+r) ≈ 0.286`（d=5%/h 掉线、r=2%/h 恢复），
 * 池子 8 条时「好出口 < 2 条」的概率 28.5%，12 条 10.2%，16 条降到 **3.4%**；
 * 而把复检频率拉到最大也只能把缺货率压到 26.7% —— 探测频率买不来供给，只有池子大小能。
 */
export const ALIVE_TARGET = 16;

/** 活跃池的下限：低于这个数就该用「缺多少补多少」的力度去扫。 */
export const ALIVE_MIN = 12;

/**
 * 功能：在预算给出的准入条数上，按「离目标还差多少」加码。
 * 只在不够用时加码、从不在够用时削减 —— 池子扫描还兼着「找更好的节点」，削减它会伤大池表现。
 * @param alive 当前活跃节点数
 * @param want 预算原本给的准入条数
 * @returns {number} 本轮实际准入条数
 */
export function alivePlan(alive: number, want: number): number {
  if (alive >= ALIVE_TARGET) return want;
  return Math.max(want, ALIVE_TARGET - alive + 4);
}

/**
 * 功能：源健康度概览 —— `/health` 用，回答「补货是不是一直失败」。
 * 补货成功与否决定了能否维持 16 条活跃池；而 6 个公开源实测每轮都有 1–4 个失败
 * （可达 1/6、3/6、2/6），失败时不看不出来，只能靠这个数。
 * @returns {{ bad: number; retryAt: number }} 当前失败的源数量、最早恢复时间
 */
export function srcStat(): { bad: number; retryAt: number } {
  const snap = srcHealth();
  let bad = 0;
  let retryAt = 0;
  for (const k of Object.keys(snap)) {
    const v = snap[k];
    if (!v || !v.until || v.until <= Date.now()) continue;
    bad += 1;
    if (!retryAt || v.until < retryAt) retryAt = v.until;
  }
  return { bad, retryAt };
}
