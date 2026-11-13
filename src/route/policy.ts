// 通道决策的唯一入口：观测 → 判定表 → 这里 → 执行。
// 影子模式（SC.POLICY = 0）下只统计「建议」与「现状」的一致率，不改行为。
import { SC } from "../core/const";
import { S } from "../core/state";
import { isCfIp } from "../core/net";
import { Chan, DIRECT, chanKey } from "./channel";
import { DecisionIn, DecisionOut, HOOK, TrafficEvt } from "../core/hook";
import { recordBlock, recordPass, recordTraffic } from "./observe";
import { vAll, vBad, vOk, vSet } from "./verdict";
import { cnt } from "../core/counter";
import { cfHttpCode } from "../proxy/cfverdict";
import { vtDelta, vtLoad } from "./verdictsync";
import { chanPref } from "./prefs";
import { queueVerify, runVerify } from "./verify";

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

// 通道是否可用：既要没有「站点级」封禁，也要没有「通配级」封禁（vBad 自身会回退到通配）
const chanOk = (ip: string, host = ""): boolean => !(host && vBad(host, "r:" + ip)) && !vBad("*", "r:" + ip);

/** 纯函数，可单测；不做 IO、不看时间以外的东西 */
export function decide(c: Ctx): Choice {
  const usable = c.relays.filter((ip) => chanOk(ip, c.host));
  // 直连已被实测/差分判为封（任何站点都适用）→ 直接换中继
  if (usable.length && vBad(c.host, "d")) {
    const nonCf0 = usable.filter((ip) => !isCfIp(ip));
    const ip = (nonCf0[0] || usable[0]) as string;
    return { chan: { kind: "r", ip }, why: "dir-blocked" };
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
    // CF 托管目标：Worker 直连/CF 中继都是 CF→CF，会把客户端出口原样透传，
    // 所以「能不能通」只取决于本出口有没有被按 IP 族拒。能改判的只有非 CF 主机，
    // 因此这里把非 CF 中继放在最前（本出口的 fetch 状态码只看作辅助证据：
    // CF→CF 的 fetch 常常返回 200，而真正的隧道却是 403，不能作为能否直连的依据）。
    const nonCf1 = usable.filter((ip) => !isCfIp(ip));
    if (okOnes.length) return { chan: { kind: "r", ip: okOnes[0] }, why: "cf-ok-relay" };
    if (nonCf1.length) return { chan: { kind: "r", ip: nonCf1[0] }, why: "cf-noncf" };
    const code = cfHttpCode(c.host);
    if (code === 403 && usable.length) return { chan: { kind: "r", ip: usable[0] }, why: "http403" };
    if (code === 200) return { chan: DIRECT, why: "http200" };
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
  // 中继候选：先看本 isolate 已探活的节点；池子还没探完（冷启动）时退到池子名单，
  // 否则「本出口 403 但没有可用中继」会退化成继续直连（正是线上 403 连发的成因）。
  let relays = Array.from(S.alive.keys()).slice(0, 16).map((k) => k.slice(0, k.lastIndexOf(":")));
  if (!relays.length) relays = S.pool.filter((x) => !isCfIp(x.h)).slice(0, 8).map((x) => x.h);
  const d = shadow({ host: x.host, cfHost: x.cfHost, clientV6: x.clientV6, relays, legacyWantsRelay: x.legacyWantsRelay });
  const via: "d" | "r" = d.chan.kind === "d" ? "d" : "r";
  return { via, ip: d.chan.ip, why: d.why };
};

/** 判定表里该站点 × 该中继被判死 → 选路时跳过（一次探测同时服务判定与选路） */
HOOK.veto = (host: string, ip: string): boolean => !!host && !!ip && vBad(host, "r:" + ip);

/** 连接收尾的弱证据：大响应 = 这条通道真能出整页；小响应要「差分」才判封锁 */
HOOK.traffic = (e: TrafficEvt): void => {
  if (e.host === S.site) return; // 探自己的域名必 522（CF 自环），不构成任何通道证据
  const ip = e.node ? e.node.slice(0, e.node.lastIndexOf(":")) : "";
  const chan: Chan = e.via === "node" && ip ? { kind: "r", ip } : DIRECT;
  const ck = e.host + "|" + chanKey(chan);
  const now = Date.now();
  if (e.ok && e.down >= 20000) {
    cnt("trHit");
    S.bigByHost.set(e.host, now);
    S.bigChan.set(e.host, ck);
    S.smCnt.delete(ck);
    recordTraffic({ target: e.host, chan, down: e.down, ok: true });
    recordPass({ target: e.host, chan, down: e.down, ok: true });
    return;
  }
  if (e.down <= 0 || e.down >= 12000 || e.life > 8000 || e.up > 16384) return;
  cnt("trSmall");
  if (e.cf) {
    if (e.down < 900) cnt("sz1");
    else if (e.down < 1500) cnt("sz2");
    else if (e.down < 3000) cnt("sz3");
    else cnt("sz4");
  }
  const n = (S.smCnt.get(ck) || 0) + 1;
  S.smCnt.set(ck, n);
  // 差分判据（不误伤业务 403）：只有当**同一站点的另一条通道在 30 分钟内拿到过整页**时，
  // 这次的小响应才说明「是这条通道被封」。业务层 403（鉴权/风控/HEAD）在所有通道上都小，
  // 永远凑不出这个差分，因此不会被判死。
  const bigAt = S.bigByHost.get(e.host) || 0;
  const bigCk = S.bigChan.get(e.host) || "";
  const diff = bigAt > now - 1800000 && !!bigCk && bigCk !== ck;
  // 中继把自家默认页（nginx）当响应回的假 200：通道永久无效，但要攒够 3 次（避免误伤极小的真响应）
  if (e.ok && e.via === "node" && e.down < 6000 && n >= 3) {
    recordBlock({ target: e.host, chan, down: e.down, ok: false });
    S.needPx.set(e.host, now + 21600000);
    return;
  }
  if (!diff) {
    queueVerify(e.host, chan); // 复核队列（PROBE_REQ=0 时只排队，不烧 CPU）
    if (n >= 2 || e.cf) S.needPx.set(e.host, now + 21600000); // 只学「下次优先中转」，不下判定
    return;
  }
  S.smCnt.delete(ck);
  recordBlock({ target: e.host, chan, down: e.down, ok: false });
  S.needPx.set(e.host, now + 21600000);
};
HOOK.verify = (): Promise<number> => runVerify();
/** 池子的中继实测 → 判定表：握手成功算 probe 级 ok（哪怕还没看到状态码） */
HOOK.relayProbe = (host: string, ip: string, ok: boolean, ms: number): void => {
  if (ok) vSet(host, "r:" + ip, 200, ms, 1);
};

/** 该站点 × 该中继被判 ok（probe 或端到端）→ 选路时优先 */
HOOK.prefer = (host: string, ip: string): boolean => !!host && !!ip && vOk(host, "r:" + ip);
/** 通道偏好表（判定表的「能通 / 打不通」两栏）：选路时避开被实测判死的通道 */
HOOK.chanPref = (ip: string, host = ""): number => chanPref(ip, host);

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
