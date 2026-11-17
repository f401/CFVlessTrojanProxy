// 「站点 × 中继」成功率先验：由出口族事实回答（v8 §5）。
//
// 先验单独成文件的原因：它是**唯一**允许「没量过也先给个数」的地方，
// 而表本体（`ps-table.ts`）只做贝叶斯收缩；两者混在一起时，
// 「为什么新中继没有被降权」这个问题在代码里找不到唯一答案。
import { EG } from "./egfacts";

/**
 * 功能：本站点该通道的先验成功率 —— 由出口族事实回答（v4 0.9 / v6 0.45 / 未知 0.83）。
 *
 * 未知取 0.83 而不是 0.5：没量过不等于坏，否则新中继一进池就被整体降权，
 * 而「新中继」恰恰是补货链（v8 §40）唯一的增量来源。
 * @param {string} ip 中继 IP
 * @param {number} now 当前时间
 * @returns {number} 0..1 的先验
 */
export function psPrior(ip: string, now = Date.now()): number {
  const fam = EG.famOf(ip, now);
  if (fam === 4) return 0.9;
  if (fam === 6) return 0.45;
  return 0.83;
}
