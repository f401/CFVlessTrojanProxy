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
import { CF_NEG, JUDGE } from "./judge";
import { relCostMode, relNote, relSnap } from "./relperf";
import { EG } from "./egfacts";
import { PS, psFactor, psNote, psOk } from "./psfacts";
import { DEAD, deadNote, isDead } from "./deadfacts";
import { BLK, blkPen } from "./blkfacts";
import { cnt } from "../core/counter";

export interface Ctx {
  host: string;
  cfHost: boolean; // 目标托管在 CF 上
  clientV6: boolean; // 客户端出口是 IPv6（cf-connecting-ip）
  relays: string[]; // 池里可用中继的 IP
  legacyWantsRelay: boolean; // 现状：session 的 wantPx
  /** 传输模式（`tput` / `lat`）；缺省按吞吐模式，测试可省略 */
  mode?: string;
}

export interface Choice {
  chan: Chan;
  why: string;
}

/** 选路策略：纯内存、可单测；所有「哪条通道」的判断都收敛在这里 */
export class Policy {
  /**
   * 冷启动钉住表：站点 → { 中继 IP, 到期时间 }。
   *
   * 为什么要它：新 isolate 里某个站点还没有任何证据时，并发进来的多条连接会各自按健康度顺序选，
   * 等于同时赌好几条中继；任一条出口恰好是 v6/脏出口就丢一批请求。钉住一条（60 秒）后，冷启动只
   * 暴露在**一条**中继的波动下；等第一条整页证据回来，后续由粘性排序与负面记忆接管。
   */
  private pin = new Map<string, { ip: string; until: number }>();
  /** 吞吐模式冷启动的轮换游标：让前几条连接分别落在不同中继上，尽快量出容量差异 */
  private rot = 0;

  /** 每个站点的决策序号：康复通道按「每 20 条一次」触发，不随机（可复现、可测） */
  private seq = new Map<string, number>();

  /**
   * 功能：冷启动时为站点挑一条固定中继，60 秒内复用同一条。
   * @param host 目标站
   * @param list 候选通道（已排序）
   * @param now 当前时间戳
   * @returns 选中的中继 IP（候选为空时返回空串）
   */
  pinFor(host: string, list: string[], now = Date.now()): string {
    const cur = this.pin.get(host);
    if (cur && cur.until > now && list.includes(cur.ip)) return cur.ip;
    const pick = list[0] || "";
    if (pick) this.pin.set(host, { ip: pick, until: now + 60_000 });
    else this.pin.delete(host);
    return pick;
  }

  /** 通道是否可用：既没有站点级封禁，也没有通配级封禁（vBad 自身会回退到通配） */
  chanOk(ip: string, host = ""): boolean {
    return !(host && vBad(host, "r:" + ip)) && !vBad("*", "r:" + ip);
  }

  /**
   * 功能：单点决策——综合判定表、站点偏好、预算与策略分级，决定本次请求走直连还是某条中继。
   * @param c 决策上下文（目标、候选通道、是否 CF 托管等）
   * @returns 选中的通道与理由
   */
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
    // 粘性：最近对该站点留下过证据的通道排前面（vAt 为最后证据时间，没证据的为 0 排最后）。
    // 突发场景下「每条连接都按健康度盲选」会分散到少数 v6 出口/质量差的中继；按站点证据排序能让
    // 已经证明「这个站点走它能成」的同一条中继被反复复用 —— 普适规则，不含站点特判。
    // 短负面记忆（10 分钟）优先于粘性：刚回过异常小响应的通道先让开一条连接，过期自动恢复。
    // CF 托管目标额外参考「这条中继对 CF 站点普遍不友好」的通用记录（站点无关，但只在本 isolate）。
    const negOf = (ip: string): number =>
      JUDGE.negOn(c.host, ip) || (c.cfHost && JUDGE.negOn(CF_NEG, ip)) ? 1 : 0;
    // 正记忆（10 分钟）：这条中继刚给本站出过整页 → 排在同类之前。
    // 冷 isolate 的盲选是主要残差来源，把「刚证明能成的那条」钉在队首是最省的修法（不跨 isolate 共享）。
    const posOf = (ip: string): number => (JUDGE.posOn(c.host, ip) ? 0 : 1);
    // 健康度（本 isolate 的中继吞吐/成功率）作为下一层：它跟站点无关，但对「这条中继背后是不是坏 egres」有信息量。
    const hIdx = new Map<string, number>(HEALTH.rank(usable).map((ip, i) => [ip, i]));
    const hOf = (ip: string): number => hIdx.get(ip) ?? 99;
    // 站点 × 中继的实测代价：同一个中继对不同站点快慢差一个数量级，所以它比「站点无关的健康度」更贴题。
    // 按模式取：吞吐优先看「拉 1MB 要多久」，延迟优先只看首字节（别被大文件样本带偏）。
    // 有样本就按样本排；没样本的排到 1e6 之后，再用站点无关的健康度打破并列 ——
    // 这样「量过且慢」不会被当成「没量过」重新插队，冷启动仍能靠健康度挑到合理的几条。
    const scoreOf = (ip: string): number => {
      const r = relCostMode(c.mode === "lat" ? "lat" : "tput", c.host, ip);
      const base = r < 1e6 ? r : 1e6 + hOf(ip) * 1000;
      // 出口族偏置（v8 §5）：v4 出口通过率明显更高，但这里只乘系数、不改候选集合——
      // v6 出口照样有机会被选中，只是要明显更便宜才会排到前面。
      // 再叠「站点 × 中继」成功率折价：没有样本时因子恒为 1（接入前后逐位相同）；
      // 有样本时把实测过不了的通道乘贵 —— 仍然只是乘数，绝不剔候选（v8 §15 I2）。
      // blk：判为「这个站点在这个出口上被封锁」时只乘 6 倍代价（v8 §15 的 I1：永不剔候选）
      return base * EG.bias(ip) * psFactor(c.host, ip) * blkPen(c.host, ip);
    };
    // 站点级自愈：整池都被同一站点写满 ⇒ 判据失效/站点在拒绝所有人，清空并静默 30 分钟
    BLK.sweep(c.host, usable);
    const ranked = usable
      .slice()
      .sort(
        (a, b) =>
          negOf(a) - negOf(b) ||
          posOf(a) - posOf(b) ||
          scoreOf(a) - scoreOf(b) ||
          vAt(c.host, "r:" + b) - vAt(c.host, "r:" + a),
      );
    // v8 §15 的 I1：dead 是唯一允许缩小候选的事实 —— 而且这里只把判死的中继挪到队尾，
    // 不是删除：全池都判死时仍要发出请求（leastBad），否则用户看到的是「无候选」而不是业务页。
    const live = ranked.filter((ip) => !isDead(ip));
    const stick = live.length ? live : ranked;
    // 康复通道（v8 §3.2 / D12）：每 20 条请求放 1 条「历史上有过整页、但现在排在最后」的中继。
    // 不这么做就存在死锁：被降权的通道再也拿不到样本 → 成功率永远停在先验 → 永远回不来。
    // 用序号而不是随机数，是为了让「第 20 条会康复」这件事可复现、可断言。
    const nth = (this.seq.get(c.host) || 0) + 1;
    this.seq.set(c.host, nth);
    if (nth % 20 === 0 && stick.length > 1) {
      const back = stick.filter((ip) => psOk(c.host, ip) >= 0.6 || JUDGE.posOn(c.host, ip));
      const worst = back.length ? (back[back.length - 1] as string) : "";
      if (worst && worst !== stick[0]) {
        cnt("rehab");
        return { chan: { kind: "r", ip: worst }, why: "rehab" };
      }
    }
    const nonCf = stick.filter((ip) => !isCfIp(ip));
    const okOnes = stick.filter((ip) => vOk(c.host, "r:" + ip) || vOk("*", "r:" + ip));

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
      const code = cfHttpCode(c.host);
      // 吞吐模式：还没有任何「本站点可用」的证据时，**逐条轮换**而不是钉死一条 60 秒。
      // 为什么：中继容量实测差 3–4 倍（1103 vs 300 KB/s），钉住一条时其余中继永远没有样本，
      // 「按站点 × 中继挑最快」就永远学不出来；轮换几条后样本足够，再交给下面的排序去利用。
      const coldSite = !stick.some((ip) => vAt(c.host, "r:" + ip) > 0) && !stick.some((ip) => JUDGE.posOn(c.host, ip));
      const fresh = relSnap(c.host).length;
      // 只给「本站点一次都没量过」的中继采样机会，而且必须已经有 1 条样本做锚：
      // 全池轮换会把 0/4、2/4 全 403 的中继塞给用户（实测 tput 2/8），
      // 完全不轮换又永远学不出容量差异（只剩一条中继有样本）。小步、只朝没试过的走。
      const seen = new Set(relSnap(c.host).map((r) => r.ip));
      const unmeasured = stick.filter((ip) => !JUDGE.negOn(c.host, ip) && !seen.has(ip));
      if (c.mode !== "lat" && coldSite && fresh >= 1 && unmeasured.length > 0) {
        const ip = unmeasured[this.rot++ % unmeasured.length] as string;
        return { chan: { kind: "r", ip }, why: "rel-rot" };
      }
      // 冷启动：该站点没有任何通道证据、本出口也没拿到状态码、也还没有「站点×中继」样本
      // → 钉住单条中继 60 秒（理由见 pinFor）。一旦有了样本就交给 stick 排序，避免钉住覆盖实测结论。
      if (!code && coldSite && relSnap(c.host).length === 0) {
        // 钉住的那条一旦进了负面记忆就立刻换下一条：否则一次坏 egress 会在 60 秒里吞掉整个站点
        const pool = (nonCf.length ? nonCf : stick).filter((ip) => !JUDGE.negOn(c.host, ip));
        const cip = this.pinFor(c.host, pool.length ? pool : nonCf.length ? nonCf : stick);
        if (cip) return { chan: { kind: "r", ip: cip }, why: "cold-pin" };
      }
      if (okOnes.length) return { chan: { kind: "r", ip: okOnes[0] }, why: "cf-ok-relay" };
      if (nonCf.length) return { chan: { kind: "r", ip: nonCf[0] }, why: "cf-noncf" };
      // 「本出口 fetch 得 200」不等于「隧道直连得 200」：fetch 走的是 CF 自己的出口，
      // 隧道直连可能落在一个对 CF 托管站点不友好的边缘出口上（实测 200 → 隧道 403）。
      // 所以只有在**隧道直连自己有过成功证据**（vOk(host,"d")）时才选直连；否则宁可走一条已知可用的中继。
      // 直连成功证据只信 5 分钟内：边缘出口会漂移，"十分钟前直连 200" 不代表这一分钟还行。
      // 30 分钟 TTL 内一直选直连，一次幸运 200 会换来一串 4 字节 403（实测 tput 15/20 → 20/20 的差别就来自这里）。
      const dAt = vAt(c.host, "d");
      if (vOk(c.host, "d") && dAt && Date.now() - dAt < 300000) return { chan: DIRECT, why: "direct-ok" };
      if (code === 403 && stick.length) return { chan: { kind: "r", ip: stick[0] as string }, why: "http403" };
      if (code === 200 && !stick.length) return { chan: DIRECT, why: "http200" };
      if (stick.length) return { chan: { kind: "r", ip: stick[0] as string }, why: "cf-any" };
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
  EG.ack();
  PS.ack();
  DEAD.ack();
  BLK.ack();
};
HOOK.syncNack = (): void => {
  HEALTH.nack();
  vtNack();
  EG.nack();
  PS.nack();
  DEAD.nack();
  BLK.nack();
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
HOOK.relPerf = (host: string, ip: string, ttfb: number, kbs: number): void => relNote(host, ip, ttfb, kbs);
HOOK.vtDelta = (): Array<{ k: string; s: number; t: number }> => vtDelta();
    HOOK.psDelta = (): Array<{ k: string; q: number; n: number; at: number }> => PS.delta();
    HOOK.psNote = (host: string, ip: string, ok: boolean): void => psNote(host, ip, ok);
    HOOK.deadNote = (ip: string, ok: boolean): void => deadNote(ip, ok);
    HOOK.deadDelta = (): Array<{ i: string; n: number; at: number }> => DEAD.delta();
    HOOK.blkDelta = (): Array<{ k: string; n: number; at: number }> => BLK.delta();
    HOOK.egDelta = (): Array<{ i: string; f: number; at: number }> => EG.delta();
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
/**
 * 功能：策略是否生效（SC.POLICY 分级：0 只影子统计 / 1 只放开硬规则 / 2 全生效）。
 * @returns 生效为 true
 */
export function policyOn(): boolean {
  return SC.POLICY > 0;
}

