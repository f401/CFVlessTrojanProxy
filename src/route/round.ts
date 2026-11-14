// 一轮 cron 的判定侧编排：按预算挑「最值得重新确认」的目标，逐个扫一遍。
// 只做编排，不做判断——证据一律经 observe.recordProbe 落表。
import { S } from "../core/state";
import type { Plan } from "./budget";
import { vAll } from "./verdict";

/** 历史成本常量（sweepHost 已随 subtls 删除，保留导出避免下游 import 断裂） */
export const SWEEP_COST = 4;

export interface RoundOut {
  hosts: string[];
  swept: number;
}

/**
 * 挑要扫的站点：`needPx` 里未过期的（有真实异常信号）优先，其次判定表里「被记成 blocked 但
 * 已过半个 TTL」的（该复核，好转要能学到），最后是完全没有证据的热门站（不能凭空猜，只能从
 * needPx 与判定表这两个有来源的池子里挑）。
 */
export function pickHosts(n: number): string[] {
  if (n <= 0) return [];
  const now = Date.now();
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (h: string) => {
    if (!h || seen.has(h) || out.length >= n) return;
    seen.add(h);
    out.push(h);
  };
  // ① 真实异常信号
  for (const [h, t] of S.needPx) if (t > now) push(h);
  // ② 待复核的 blocked/dead
  for (const v of vAll()) {
    if (v.state >= 2 && now - v.at > 900000) push(v.t);
  }
  return out;
}

/** 按预算扫，返回本轮实际扫过的站点 */
export async function runRound(plan: Plan): Promise<RoundOut> {
  // 免费计划单次 userland TLS 握手就超 CPU 预算（实测 1102），subtls 已删除、探索轮不再发探测；
  // 状态码级证据统一走 tfb（tunnelfetch，在 DO 里一次请求完成握手）。保留函数是为了
  // `?vt=` 的输出与 cron 编排不变，plan 里的 vt 额度由 budget.ts 归零。
  void plan;
  return { hosts: [], swept: 0 };
}

