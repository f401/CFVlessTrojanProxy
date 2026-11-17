import { SC } from "../core/const";
import { S } from "../core/state";
import { availOf, effView, invalidateRank, nsGet } from "./stat";

/* 节点健康度：冷却黑名单、回滚冻结、空关闭可疑、可用性。
   这里原本是 `Scorer` 类上的六个方法，但类里一个字段都没有 —— 状态全在 `S.nstat`，
   类只是一层命名空间。按 AGENTS.md 的约定（只有独占跨请求可变状态才配类），
   把判断还原成自由函数：谁读哪些表，一眼可见。 */

/**
 * 功能：判断节点是否处于冷却期（`nsFail` 罚过之后 `blackUntil` 未到）。
 * @param k 节点键 host:port
 * @returns 在冷却期返回 true
 */
export function isBlack(k: string): boolean {
  const s = S.nstat.get(k);
  // 冷却截止时间在证据表里，没有记录就当没罚过
  return !!(s && s.blackUntil > Date.now());
}

/**
 * 功能：判断节点是否被「回滚冻结」（`freezeNode` 写下的 `freeUntil` 未到）。
 * @param k 节点键 host:port
 * @returns 被冻结返回 true
 */
export function isFrozen(k: string): boolean {
  const s = S.nstat.get(k);
  return !!(s && s.freeUntil > Date.now());
}

/**
 * 功能：冻结一个刚出问题的节点，并让所有依赖排序的缓存就地失效。
 *
 * 取 `Math.max` 是因为冻结可能被多次触发：短冻结不该把长冻结缩短。
 * @param k 节点键 host:port（空串直接忽略）
 * @returns 无
 */
export function freezeNode(k: string): void {
  if (!k) return;
  const s = nsGet(k);
  s.freeUntil = Math.max(s.freeUntil || 0, Date.now() + SC.ROLL_FREEZE);
  // 站点排行里不能再推荐它：清缓存 + 打一次失效戳
  S.hostRankCache.clear();
  invalidateRank();
}

/**
 * 功能：中转后仍然大量空关闭 → 这个节点基本是坏的。
 *
 * 只看「走了中转」的口径：直连空关闭是目标站的问题，不能算到节点头上。
 * 阈值取「至少 5 次尝试且空关闭过半」，样本更少时不下结论（避免一两次抖动把节点判死）。
 * @param s 节点统计对象（可为空）
 * @returns 可疑返回 true
 */
export function suspectOf(s: NodeStats | undefined): boolean {
  if (!s) return false;
  const viaP = s.eCloseP || 0;
  const attempts = (s.trafficOkW || 0) + viaP;
  return attempts >= 5 && viaP / attempts > 0.5;
}

/**
 * 功能：可疑节点的 key 版本（面板与规则共用同一份判定，避免两套阈值分叉）。
 * @param k 节点键 host:port
 * @returns 可疑返回 true
 */
export function emptyCloseSuspect(k: string): boolean {
  return suspectOf(S.nstat.get(k));
}

/**
 * 功能：节点当前是否可用（活着、不在冷却、没被冻结，样本够时还要求可用率）。
 *
 * 全局选路与地区选路必须共用这一份判定 —— 否则 `?rg=xx` 会绕过排除规则，
 * 把全国流量压到一个「连得上但永远传不出数据」的节点上。
 * @param k 节点键 host:port
 * @param now 当前时间戳
 * @returns 可用返回 true
 */
export function usable(k: string, now = Date.now()): boolean {
  if (!S.alive.has(k) || isBlack(k) || isFrozen(k)) return false;
  const s = S.nstat.get(k);
  // 没有任何证据的新节点先当可用：不让人为的乐观把池子锁死
  if (!s) return true;
  const e = effView(s, now);
  const n = e.okW + e.failW;
  // 样本够 8 个才用可用率下结论，否则只信「可疑」这一条
  if (n >= 8 && availOf(s, now, e) < 0.4) return false;
  return !suspectOf(s);
}
