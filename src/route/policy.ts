// 通道决策的唯一入口（OOP 版）：观测 → 判定表 → Policy → 执行。
// 影子模式（SC.POLICY = 0）下只统计「建议」与「现状」的一致率，不改行为。
import { SC } from "../core/const";
import { S } from "../core/state";
import { isCfIp } from "../core/net";
import { Chan, DIRECT } from "./channel";
import { DecisionIn, DecisionOut, HOOK, TrafficEvt } from "../core/hook";
import { vAll, vAt, vBad, vClearHost, vOk, vSet, vSetState } from "./verdict";
import { cfHttpCode } from "../proxy/cfverdict";
import { vtAck, vtDelta, vtLoad, vtNack } from "./verdictsync";
import { chanPref } from "./prefs";
import { runVerify } from "./verify";
import { HEALTH, ipOf } from "./relay-health";
import { JUDGE } from "./judge";

export interface Ctx {
  host: string;
  cfHost: boolean; // 目标托管在 CF 上
  clientV6: boolean; // 客户端出口是 IPv6（cf-connecting-ip）
  relays: string[]; // 池里可用中继的 IP
  legacyWantsRelay: boolean; // 现状：session 的 wantPx
}

export interface Choice {
  chan: Chan;
  why: string;
}

/** 选路策略：纯内存、可单测；所有「哪条通道」的判断都收敛在这里 */
export class Policy {
  /** 通道是否可用：既没有站点级封禁，也没有通配级封禁（vBad 自身会回退到通配） */
  chanOk(ip: string, host = ""): boolean {
    return !(host && vBad(host, "r:" + ip)) && !vBad("*", "r:" + ip);
  }

  decide(c: Ctx): Choice {
    let usable = c.relays.filter((ip) => this.chanOk(ip, c.host));
    // 比例兜底：被判死的通道超过 3/4 时，只保留最近判死的两条，其余解除 ——
    // 一次机房级风控不该让整池永久出局（复检 5% 太慢，这里直接放开多数）。
    const blockedRatio = c.relays.length ? (c.relays.length - usable.length) / c.relays.length : 0;
    if (blockedRatio > 0.75 && usable.length < 2) {
      const sorted = c.relays.slice().sort((a, b) => vAt(c.host, "r:" + b) - vAt(c.host, "r:" + a));
      for (const ip of sorted.slice(2)) vSetState(c.host, "r:" + ip, 0, 1);
      usable = c.relays.filter((ip) => this.chanOk(ip, c.host));
    }
    // 自愈：全部通道都被判死 → 清掉该站点的结论（宁可再试一次，也不能让站点没路可走）
    if (!usable.length && c.relays.length) {
      vClearHost(c.host);
      usable = c.relays.slice();
    }
    // 探索：被判死的通道按 5% 概率复检 —— 判死只是「当前证据」，网络会变，不试就永远好不了。
    // 成功的大响应会经 Judge 把它改回 ok；失败只会刷新 TTL，代价是一次连接的尝试。
    const blocked = c.relays.filter((ip) => !this.chanOk(ip, c.host));
    if (blocked.length && Math.random() < 0.05) {
      return { chan: { kind: "r", ip: blocked[0] as string }, why: "explore" };
    }

    // 直连已被实测/差分判死（任何站点都适用）→ 直接换中继
    if (usable.length && vBad(c.host, "d")) {
      const nonCf0 = usable.filter((ip) => !isCfIp(ip));
      return { chan: { kind: "r", ip: (nonCf0[0] || usable[0]) as string }, why: "dir-blocked" };
    }
    const nonCf = usable.filter((ip) => !isCfIp(ip));
    const okOnes = usable.filter((ip) => vOk(c.host, "r:" + ip) || vOk("*", "r:" + ip));

    if (c.clientV6 && c.cfHost) {
      // F6：v6 客户端打 CF 目标必 403，只有非 CF 主机能改判
      const pool = nonCf.length ? nonCf : usable;
      if (pool.length) {
        const ip = (okOnes.find((x) => pool.includes(x)) || pool[0]) as string;
        return { chan: { kind: "r", ip }, why: "v6-cf" };
      }
      return { chan: DIRECT, why: "v6-cf-none" };
    }

    if (c.cfHost) {
      // CF 托管目标：直连/CF 中继都是 CF→CF，会把客户端出口原样透传，能改判的只有非 CF 主机。
      // 本出口的 fetch 状态码只作辅助证据（CF→CF 的 fetch 常返回 200，隧道却 403）。
      if (okOnes.length) return { chan: { kind: "r", ip: okOnes[0] }, why: "cf-ok-relay" };
      if (nonCf.length) return { chan: { kind: "r", ip: nonCf[0] }, why: "cf-noncf" };
      const code = cfHttpCode(c.host);
      if (code === 403 && usable.length) return { chan: { kind: "r", ip: usable[0] }, why: "http403" };
      if (code === 200) return { chan: DIRECT, why: "http200" };
      if (usable.length) return { chan: { kind: "r", ip: usable[0] }, why: "cf-any" };
    }
    return { chan: DIRECT, why: "direct" };
  }

  /** 影子统计：只记一致率与原因分布，供 `?vt=` 观察 */
  shadow(c: Ctx): Choice {
    const d = this.decide(c);
    const want = d.chan.kind !== "d";
    if (want === c.legacyWantsRelay) S.polSame++;
    else S.polDiff++;
    S.polWhy[d.why] = (S.polWhy[d.why] || 0) + 1;
    return d;
  }

  /** 中继候选：先看本 isolate 已探活的节点，冷启动退到池子名单（否则「403 但没有中继」会继续直连） */
  relays(): string[] {
    // 存活表按健康度排序：整页多、无响应少的中继排前面（废中继不再滞留）
    const alive = HEALTH.rank(Array.from(S.alive.keys()).map(ipOf)).slice(0, 16);
    if (alive.length) return alive;
    return HEALTH.rank(S.pool.filter((x) => !isCfIp(x.h)).map((x) => x.h)).slice(0, 8);
  }

  /** 该站点 × 该中继是否被实测判 ok（probe 或端到端） */
  prefer(host: string, ip: string): boolean {
    return !!host && !!ip && vOk(host, "r:" + ip);
  }

  /** 该站点的通道成功记忆：弱 ok（src=0）也算 */
  win(host: string): { d: boolean; r: boolean } {
    let d = false;
    let r = false;
    for (const v of vAll()) {
      if (v.t !== host || v.state !== 1) continue;
      if (v.c === "d") d = true;
      else if (v.c.startsWith("r:")) {
        r = true;
        break;
      }
      if (d && r) break;
    }
    return { d, r };
  }

  /** 由 src/index.ts 的副作用 import 生效：一次装配，之后 proxy 只调核心 HOOK */
  install(): void {
    HOOK.decide = (x: DecisionIn): DecisionOut => {
      const d = this.shadow({ host: x.host, cfHost: x.cfHost, clientV6: x.clientV6, relays: this.relays(), legacyWantsRelay: x.legacyWantsRelay });
      return { via: d.chan.kind === "d" ? "d" : "r", ip: d.chan.ip, why: d.why };
    };
    HOOK.traffic = (e: TrafficEvt): void => JUDGE.onTraffic(e);
    // 「有非 CF 出口就优先用它」：CF→CF 会把客户端 IP 原样透传，封禁策略照旧命中
    HOOK.nonCfFirst = (): boolean => true;
    HOOK.healthDelta = (): Array<{ i: string; o: number; b: number; d: number }> => HEALTH.delta();

// 上报成功才让增量生效；失败则退回，下一轮重新发（否则一次 1102 就永久少一段证据）
HOOK.syncAck = (): void => {
  HEALTH.ack();
  vtAck();
};
HOOK.syncNack = (): void => {
  HEALTH.nack();
  vtNack();
};
    HOOK.verify = (): Promise<number> => runVerify();
    HOOK.veto = (host: string, ip: string): boolean => {
      if (!ip) return false;
      if (host && vBad(host, "r:" + ip)) return true;
      // 中继本身快死了（连上就断/零字节）也换掉：这类中继会把 403 变成 timeout
      return HEALTH.score(ip) < 0.3;
    };
    HOOK.relayProbe = (host: string, ip: string, ok: boolean, ms: number): void => {
      if (ok) vSet(host, "r:" + ip, 200, ms, 1);
    };
    HOOK.prefer = (host: string, ip: string): boolean => this.prefer(host, ip);
    HOOK.chanPref = (ip: string, host = ""): number => chanPref(ip, host);
    HOOK.win = (host: string): { d: boolean; r: boolean } => this.win(host);
    HOOK.vtDelta = (): Array<{ k: string; s: number; t: number }> => vtDelta();
    HOOK.vtLoad = (env: Env): Promise<void> => vtLoad(env);
  }
}

/** 进程内唯一策略 */
export const POLICY = new Policy();
POLICY.install();

/** 兼容旧导出（单测与预算模块直接调） */
export function decide(c: Ctx): Choice {
  return POLICY.decide(c);
}
/** 功能：shadow 是薄包装，直接委托 POLICY.shadow。@param c Ctx。@returns 转发 POLICY.shadow 的返回值（Choice） */
export function shadow(c: Ctx): Choice {
  return POLICY.shadow(c);
}
export function policyOn(): boolean {
  return SC.POLICY > 0;
}

