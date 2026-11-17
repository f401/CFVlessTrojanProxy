// 决策的第一步：把「这一次能用哪些中继」算出来并按代价排好序。
//
// 这一步全是**纯计算**（只读判定表、负面/正记忆、健康度、站点实测与事实层），
// 不持有任何跨请求状态，所以做成自由函数而不是类 —— 它回答的是「候选长什么样」，
// 不回答「这次选谁」（那是 `policy.ts` 的竞技场，也是 `policy-cf.ts` 的分支树）。

import { isCfIp } from "../core/net";
import { BLK } from "./blkfacts";
import { isDead } from "./deadfacts";
import { factMul } from "./factmul";
import { CF_NEG, JUDGE } from "./judge";
import { HEALTH } from "./relay-health";
import { relCostMode } from "./relperf";
import { FULL_ON } from "./policy-ctx";
import type { Ctx } from "./policy-ctx";
import { vAt, vBad, vClearHost, vOk, vSetState } from "./verdict";

/** 一次决策看到的候选视图（后面的分支树只读它，不再自己筛） */
export interface Ranked {
  /** 判定表里没有「被封」结论的中继（已过比例兜底与自愈） */
  usable: string[];
  /** 被判死的那部分（只用于 5% 复检，绝不剔候选） */
  blocked: string[];
  /** 全部候选按 neg → pos → score → vAt 排好序 */
  ranked: string[];
  /** 把「判死」的挪到队尾（不是删除：全池判死也要发请求） */
  stick: string[];
  /** `stick` 里的非 CF 主机（唯一能把「客户端 IP 透传」改判掉的通道） */
  nonCf: string[];
  /** `stick` 里本站点已实测打得通的 */
  okOnes: string[];
}

/**
 * 功能：比例兜底 —— 被判死的通道超过 3/4 时只保留最近判死的两条，其余解除。
 *
 * 一次机房级风控不该让整池永久出局（5% 复检太慢，这里直接放开多数）。
 * 只看「被判死的」那批：7.268 之前这里对整个候选集排序，把唯一能打通那条的正证据
 * 也一起重置成 unknown（它的证据比最近四条判死更旧 ⇒ 排在后面 ⇒ 被 `slice(2)` 扫到）。
 * @param c 决策上下文
 * @param usable 当前可用的中继
 * @returns 兜底之后的可用集合
 */
function healRatio(c: Ctx, usable: string[]): string[] {
  const blockedRatio = c.relays.length ? (c.relays.length - usable.length) / c.relays.length : 0;
  if (!(blockedRatio > 0.75 && usable.length < 2)) return usable;
  const dead = c.relays.filter((ip) => vBad(c.host, "r:" + ip));
  const sorted = dead.slice().sort((a, b) => vAt(c.host, "r:" + b) - vAt(c.host, "r:" + a));
  for (const ip of sorted.slice(2)) vSetState(c.host, "r:" + ip, 0, 1);
  return c.relays.filter((ip) => !vBad(c.host, "r:" + ip));
}

/**
 * 功能：算出这一次请求的候选视图。
 *
 * 顺序有讲究：自愈必须在**所有早返回之前**（5% 复检与「直连被判死」两条路径都不排序，
 * 把维护动作挂在它们后面等于「每次请求有 5% 概率跳过自愈」，7.154 在单测偶发失败里发现）。
 * @param c 决策上下文
 * @returns 候选视图
 */
export function rankOf(c: Ctx): Ranked {
  let usable = c.relays.filter((ip) => !(c.host && vBad(c.host, "r:" + ip)));
  usable = healRatio(c, usable);
  // 自愈：全部通道都被判死 → 清掉该站点的结论（宁可再试一次，也不能让站点没路可走）
  if (!usable.length && c.relays.length) {
    vClearHost(c.host);
    usable = c.relays.slice();
  }
  // 站点级自愈：整池都被同一站点写满 ⇒ 判据失效/站点在拒绝所有人，清空并静默 30 分钟。
  // 分母必须是整池 `c.relays`（用 `usable` 时分子会被同一个事件剔掉，见 v7.143）。
  BLK.sweep(c.host, c.relays);
  const blocked = c.relays.filter((ip) => !usable.includes(ip));

  // 短负面记忆（10 分钟）优先于粘性：刚回过异常小响应的通道先让开一条连接，过期自动恢复。
  // CF 托管目标额外参考「这条中继对 CF 站点普遍不友好」的通用记录（站点无关，只在本 isolate）。
  const negOf = (ip: string): number =>
    JUDGE.negOn(c.host, ip) || (c.cfHost && JUDGE.negOn(CF_NEG, ip)) ? 1 : 0;
  // 正记忆（10 分钟）：这条中继刚给本站出过整页 → 排在同类之前（冷 isolate 的盲选是主要残差来源）
  const posOf = (ip: string): number => (JUDGE.posOn(c.host, ip) ? 0 : 1);
  // 健康度（本 isolate 的中继吞吐/成功率）：与站点无关，但对「背后是不是坏 egress」有信息量
  const hIdx = new Map<string, number>(HEALTH.rank(usable).map((ip, i) => [ip, i]));
  const hOf = (ip: string): number => hIdx.get(ip) ?? 99;
  // 站点 × 中继的实测代价：同一个中继对不同站点快慢差一个数量级，所以它比站点无关的健康度更贴题。
  // 没样本的排到 1e6 之后再用健康度打破并列 —— 「量过且慢」不会被当成「没量过」重新插队。
  const scoreOf = (ip: string): number => {
    const r = relCostMode(c.mode === "lat" ? "lat" : "tput", c.host, ip);
    const base = r < 1e6 ? r : 1e6 + hOf(ip) * 1000;
    // 出口族偏置与成功率折价都只是乘数，绝不剔候选（v8 §15 I1/I2）
    return base * factMul(c.facts || FULL_ON, c.host, ip, c.mode || "tput", !!c.cfHost);
  };
  const ranked = usable
    .slice()
    .sort(
      (a, b) =>
        negOf(a) - negOf(b) ||
        posOf(a) - posOf(b) ||
        scoreOf(a) - scoreOf(b) ||
        vAt(c.host, "r:" + b) - vAt(c.host, "r:" + a),
    );
  // I1：dead 是唯一允许缩小候选的事实，而且只挪到队尾不是删除
  const live = ranked.filter((ip) => !isDead(ip));
  const stick = live.length ? live : ranked;
  const nonCf = stick.filter((ip) => !isCfIp(ip));
  // 通配键已不可能存在（7.133 起写入端直接拒绝）
  const okOnes = stick.filter((ip) => vOk(c.host, "r:" + ip));
  return { usable, blocked, ranked, stick, nonCf, okOnes };
}
