// 子请求预算：一轮 cron 里给「准入探活」多少个 connect()。
// 硬上限是 SC.SCAN_SUB（免费计划 50 子请求）。判定侧扫描（`vt`）在 7.69 删 userland TLS 后就没额度了，
// 7.149 把这条只剩空壳的维度连同 round.ts 一起去掉——以前那套「覆盖缺口 × 陈旧度」加权只在
// 两个探测开关为真时有意义，而它们恒为 0（那对开关本身也在 7.153 删掉了：没有任何读取点，
// 留着只会让人以为「改成 1 就能开探测」），所以加权结果恒等于 cap，`?vt=` 里那份「判定额度」
// 与 `staleR` 就成了两个永远不动、看起来仍在测量的假仪表。
import { SC } from "../core/const";
import { S } from "../core/state";
import { vAll } from "./verdict";

export interface Plan {
  adm: number; // 池子准入探活（新增候选）
  cap: number; // 本轮总闸
}

/**
 * 本轮预算：准入拿满、但不超过 `SC.SCAN_MAX`。
 * @param poolN 池子大小（仅调试展示用：预算不再随池子变化）
 * @param aliveN 活跃池大小（同上）
 * @returns 本轮 `Plan`
 */
export function planRound(poolN: number, aliveN: number): Plan {
  // 预算已与池子/活跃数解耦：判定维度删除后，两个参数只剩「保留签名」的作用。
  // 注释里说明而不是删参数，是因为 `?vt=` 端点、`planView` 与单测都用这个签名取数。
  void poolN;
  void aliveN;
  const cap = Math.max(12, SC.SCAN_SUB);
  // 准入吃满整轮闸门：探活走 connect()，不吃 fetch 子请求额度（线上 /logs 从未出现 subrequest 超限）。
  return { adm: Math.min(cap, SC.SCAN_MAX), cap };
}

/**
 * 供调试端点与日志用的快照（不参与决策）
 * @param poolN 池子大小
 * @param aliveN 活跃池大小
 * @returns 预算 + 判定表行数 + 最近站点
 */
export function planView(poolN: number, aliveN: number): Plan & { verds: number; site: string } {
  const p = planRound(poolN, aliveN);
  return { ...p, verds: vAll().length, site: S.site || "" };
}
