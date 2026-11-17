/* 节点评分门面：按「读哪些表、改哪些表」把原来的 371 行拆成三层，本文件只做再导出，
   所以调用点与单测一字未改（行为由既有 2618 条断言证明）。
   · `score-health.ts` 健康度：冷却黑名单、回滚冻结、空关闭可疑、可用性（只读 S.nstat）
   · `score-cost.ts`   代价函数：把一条候选压成毫秒当量（纯计算，排序与面板共用）
   · `score-cands.ts`  候选表：谁能进候选、按什么顺序（排行缓存与分片重建）
   原来那个 `Scorer` 类一个字段都没有、方法全在读 S，属于「为空壳而 OOP」，7.288 起不再保留。 */

export { capOf, p90Of, pctOf, pcts } from "../core/hist";
export * from "./stat";
export * from "./score-health";
export * from "./score-cost";
export * from "./score-cands";
