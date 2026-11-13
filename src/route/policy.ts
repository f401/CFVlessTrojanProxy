// 通道决策的唯一入口：观测 → 判定表 → 这里 → 执行。
// 影子模式（SC.POLICY = 0）下只统计「建议」与「现状」的一致率，不改行为。
import { SC } from "../core/const";
import { S } from "../core/state";
import { isCfIp } from "../core/net";
import { Chan, DIRECT } from "./channel";
import { DecisionIn, DecisionOut, HOOK, TrafficEvt } from "../core/hook";
import { recordTraffic } from "./observe";
import { vAll, vBad, vOk, vSet } from "./verdict";
import { vtDelta, vtLoad } from "./verdictsync";

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

const chanOk = (ip: string): boolean => !vBad("*", "r:" + ip); // vBad 已含 dead，且会回退到通配

/** 纯函数，可单测；不做 IO、不看时间以外的东西 */
export function decide(c: Ctx): Choice {
  const usable = c.relays.filter((ip) => chanOk(ip));
  const nonCf = usable.filter((ip) => !isCfIp(ip));
  const okOnes = usable.filter((ip) => vOk("*", "r:" + ip));

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
    if (okOnes.length) return { chan: { kind: "r", ip: okOnes[0] }, why: "cf-ok-relay" };
    if (nonCf.length) return { chan: { kind: "r", ip: nonCf[0] }, why: "cf-noncf" };
    if (usable.length) return { chan: { kind: "r", ip: usable[0] }, why: "cf-any" };
  }
  return { chan: DIRECT, why: "direct" };
}

/** 影子统计：只记一致率与原因分布，供 `?vt=` 观察 */
export function shadow(c: Ctx): Choice {
  const d = decide(c);
  const want = d.chan.kind !== "d";
  if (want === c.legacyWantsRelay) S.polSame++;
  else S.polDiff++;
  S.polWhy[d.why] = (S.polWhy[d.why] || 0) + 1;
  return d;
}

/** 由 src/index.ts 的副作用 import 生效：一次装配，之后 proxy 只调核心 HOOK */
HOOK.decide = (x: DecisionIn): DecisionOut => {
  const relays = Array.from(S.alive.keys()).slice(0, 16).map((k) => k.slice(0, k.lastIndexOf(":")));
  const d = shadow({ host: x.host, cfHost: x.cfHost, clientV6: x.clientV6, relays, legacyWantsRelay: x.legacyWantsRelay });
  const via: "d" | "r" = d.chan.kind === "d" ? "d" : "r";
  return { via, ip: d.chan.ip, why: d.why };
};

/** 判定表里该站点 × 该中继被判死 → 选路时跳过（一次探测同时服务判定与选路） */
HOOK.veto = (host: string, ip: string): boolean => !!host && !!ip && vBad(host, "r:" + ip);

/** 连接收尾的弱证据：成功就记 ok；小响应只学「下次优先中转」，不判死（判死只有 probe 能下） */
HOOK.traffic = (e: TrafficEvt): void => {
  const ip = e.node ? e.node.slice(0, e.node.lastIndexOf(":")) : "";
  const chan: Chan = e.via === "node" && ip ? { kind: "r", ip } : DIRECT;
  if (e.ok) recordTraffic({ target: e.host, chan, down: e.down, ok: true });
  // 边缘只回几百字节就关：学成「这个站点下次优先走中转」，6 小时后自然过期
  if (!e.ok && e.down > 0 && e.down < 12000 && e.via === "node") S.needPx.set(e.host, Date.now() + 21600000);
};

/** 池子的中继实测 → 判定表：握手成功算 probe 级 ok（哪怕还没看到状态码） */
HOOK.relayProbe = (host: string, ip: string, ok: boolean, ms: number): void => {
  if (ok) vSet(host, "r:" + ip, 200, ms, 1);
};

/** 该站点 × 该中继被判 ok（probe 或端到端）→ 选路时优先 */
HOOK.prefer = (host: string, ip: string): boolean => !!host && !!ip && vOk(host, "r:" + ip);

HOOK.vtDelta = (): Array<{ k: string; s: number; t: number }> => vtDelta();
HOOK.vtLoad = (env: Env): Promise<void> => vtLoad(env);

/** 该站点的通道成功记忆：判定表里的弱 ok（src=0）也算，够用就行 */
HOOK.win = (host: string): { d: boolean; r: boolean } => {
  let d = false;
  let r = false;
  for (const v of vAll()) {
    if (v.t !== host || v.state !== 1) continue;
    if (v.c === "d") d = true;
    else if (v.c.startsWith("r:")) { r = true; break; }
    if (d && r) break;
  }
  return { d, r };
};

export function policyOn(): boolean {
  return SC.POLICY > 0;
}
