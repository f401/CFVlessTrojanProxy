// 一轮 cron 的判定侧编排：按预算挑「最值得重新确认」的目标，逐个扫一遍。
// 只做编排，不做判断——证据一律经 observe.recordProbe 落表。
import { logErr } from "../nodes/metrics";
import { S } from "../core/state";
import { eachLimit, errMsg } from "../core/util";
import type { Plan } from "./budget";
import { sweepHost } from "./sweep";
import { vAll } from "./verdict";
import { SC } from "../core/const";

/** 一次 sweepHost 的固定成本（2 个目标 IP × 2 条通道） */
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
  // 免费计划单次 TLS 握手就超 10ms CPU（实测 1102），所以默认不探测；
  // 想要状态码级证据时把 SC.PROBE_RND 设为 1（付费计划可用）。
  if (SC.PROBE_RND <= 0) return { hosts: [], swept: 0 };
  const budget = plan.vt;
  const n = Math.max(0, Math.floor(budget / SWEEP_COST));
  const hosts = pickHosts(n);
  let swept = 0;
  if (hosts.length) {
    await eachLimit(hosts, 2, async (h) => {
      try {
        await sweepHost(h);
        swept++;
      } catch (e) {
        logErr(`sweep ${h}: ${errMsg(e)}`);
      }
    });
  }
  return { hosts, swept };
}
