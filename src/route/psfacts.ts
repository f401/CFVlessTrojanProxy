// 「站点 × 中继」成功率事实的门面（v8 §5 的 `ps`）：进程内单例 + 五个薄包装。
//
// 拆分后的四个文件（按「谁负责哪件事」分，而不是按体积分）：
// - `ps-types.ts`  形状与刻度（`PsRow`/`PsWire`/`PS_TTL`/`PS_MAX`/`PS_K`/`toQ`）；
// - `ps-prior.ts`  唯一允许「没量过也先给个数」的地方（v4 0.9 / v6 0.45 / 未知 0.83）；
// - `ps-outbox.ts` 待上报队列的纪律（只有 ack 才清 pending，7.143 修过的那条）；
// - `ps-table.ts`  表本体：观测、贝叶斯收缩、折价因子、容量淘汰。
//
// 三条纪律（违反任意一条都会重演线上事故）：
// 1) 只折价、不过滤：本模块的输出只能乘进代价，永远不能把候选从集合里删掉。
//    7.57 的通配硬封锁把可用池从 8 条打剩 2 条，成功率 97% → 2/20。
// 2) 折价相对**自己的先验**：没有样本时因子恒为 1，冷启动行为与接入前逐位相同。
// 3) 有界 + 会衰减：表上限 512 行，45 分钟没再被观测就当作没有样本。
import { PsFacts } from "./ps-table";

export * from "./ps-types";
export { psPrior } from "./ps-prior";
export { PS_BATCH, PsOutbox } from "./ps-outbox";
export { PsFacts } from "./ps-table";

/** 进程内唯一的成功率事实表 */
export const PS = new PsFacts();

/**
 * 功能：薄包装 —— 记一次观测（调用方只有 `src/route/judge.ts` 的判定出口）。
 * @param {string} host 目标站点
 * @param {string} ip 中继 IP
 * @param {boolean} ok 是否拿到完整响应
 * @param {number} now 观测时间
 * @returns {void}
 */
export function psNote(host: string, ip: string, ok: boolean, now = Date.now()): void {
  PS.note(host, ip, ok, now);
}

/**
 * 功能：薄包装 —— 历史成功率（供康复通道判断「这条通道曾经成过」）。
 * @param {string} host 目标站点
 * @param {string} ip 中继 IP
 * @param {number} now 当前时间
 * @returns {number} 0..1；-1 表示没有样本
 */
export function psOk(host: string, ip: string, now = Date.now()): number {
  return PS.okOf(host, ip, now);
}

/**
 * 功能：薄包装 —— 历史最好（供康复通道判断「曾经成过」）。
 * @param {string} host 目标站点
 * @param {string} ip 中继出口 IP
 * @param {number} now 当前时间（毫秒）
 * @returns 0..1；-1 表示没有样本
 */
export function psBest(host: string, ip: string, now = Date.now()): number {
  return PS.bestOf(host, ip, now);
}

/**
 * 功能：薄包装 —— 折价因子（供选路层调用）。
 * @param {string} host 目标站点
 * @param {string} ip 中继 IP
 * @param {number} now 当前时间
 * @returns {number} 0.5..2
 */
export function psFactor(host: string, ip: string, now = Date.now()): number {
  return PS.factor(host, ip, now);
}

/**
 * 功能：薄包装 —— 快照（供调试端点使用）。
 * @param {string} host 只看某个站点时传它的名字
 * @returns {Array<{ k: string; q: number; n: number; at: number; top: number }>} 快照
 */
export function psSnap(host = ""): Array<{ k: string; q: number; n: number; at: number; top: number }> {
  return PS.snap(host);
}
