// CF 托管目标的通道判定：这一整棵分支树只处理「目标是 CF 托管站点」这一种局面。
//
// 为什么单独成文件：CF 托管站点上直连与 CF 中继都是 CF→CF，会把**客户端出口 IP 原样透传**，
// 于是能改判的只有非 CF 主机（v8 §9）；这一条规则派生出六个分支（v6 客户端 / 只朝未量过轮换 /
// 冷启动钉住 / 优先非 CF / 看本出口状态码 / 事实层兜底）。它们的状态依赖（`pin`/`rot`）与
// `Policy` 的三张按站点表同源，所以用结构化接口 `PinSource` 反向注入 —— 与 7.285 的
// `PolicySource` 同一手法，避免两个文件互相 import。

import { DIRECT } from "./channel";
import { EG } from "./egfacts";
import { JUDGE } from "./judge";
import { isDead } from "./deadfacts";
import { relSnap } from "./relperf";
import { vAt } from "./verdict";
import { cfHttpCode } from "../proxy/cfverdict";
import type { Choice, Ctx } from "./policy-ctx";
import type { Ranked } from "./policy-rank";

/**
 * 分支树需要向策略本体借的两件状态。
 *
 * 都是「按站点的内存表 + 一个游标」，没有算法语义：
 * - `pinFor`：冷启动时把站点钉在一条中继上 60 秒（表在 `Policy.pin`）；
 * - `nextRotation`：吞吐模式冷启动的轮换游标（表在 `Policy.rot`）。
 */
export interface PinSource {
  /**
   * 功能：冷启动时为站点挑一条固定中继（60 秒内复用同一条）。
   * @param host 目标站点
   * @param list 候选中继（已排序）
   * @returns 选中的中继 IP（候选为空时返回空串）
   */
  pinFor(host: string, list: string[]): string;
  /**
   * 功能：取下一个轮换序号（自增游标取模）。
   * @param limit 候选条数
   * @returns 0..limit-1 的下标
   */
  nextRotation(limit: number): number;
}

/**
 * 功能：CF 托管目标的通道判定。
 * @param c 决策上下文（`c.cfHost` 必须为真才可能返回非空）
 * @param r 候选视图（`policy-rank.ts` 算好的排序与分类）
 * @param src 借来的按站点状态（钉住表 / 轮换游标）
 * @returns 选中的通道；`c.cfHost` 为假时返回 null 表示「不归本文件管」
 */
export function decideCf(c: Ctx, r: Ranked, src: PinSource): Choice | null {
  if (!c.cfHost) return null;
  const { usable, stick, nonCf, okOnes } = r;

  if (c.clientV6) {
    // F6：v6 客户端打 CF 目标必 403，只有非 CF 主机能改判
    // 回退顺序用 `stick`（已把判死的挪到队尾），不能退回 `usable` —— 那里面还留着判死的通道；
    // 选谁交给排序结果（`stick` 已按 neg/pos/score 排好），不再按池子迭代顺序取第一条。
    const pool = nonCf.length ? nonCf : stick.length ? stick : usable;
    if (pool.length) {
      const ip = (okOnes.find((x) => pool.includes(x)) || pool[0]) as string;
      return { chan: { kind: "r", ip }, why: "v6-cf" };
    }
    return { chan: DIRECT, why: "v6-cf-none" };
  }

  // CF 托管目标：直连/CF 中继都是 CF→CF，会把客户端出口原样透传，能改判的只有非 CF 主机。
  // 本出口的 fetch 状态码只作辅助证据（CF→CF 的 fetch 常返回 200，隧道却 403）。
  const code = cfHttpCode(c.host);
  // 吞吐模式：还没有任何「本站点可用」的证据时，**逐条轮换**而不是钉死一条 60 秒。
  // 为什么：中继容量实测差 3–4 倍（1103 vs 300 KB/s），钉住一条时其余中继永远没有样本，
  // 「按站点 × 中继挑最快」就永远学不出来；轮换几条后样本足够，再交给排序去利用。
  const coldSite =
    !stick.some((ip) => vAt(c.host, "r:" + ip) > 0) && !stick.some((ip) => JUDGE.posOn(c.host, ip));
  // 一次扫描同时拿到「量过几条」与「量过哪些」：7.188 之前这里把同一张表扫了三遍（每遍还要排序），
  // 而 CF 托管目标是热路径（闭环证明里 400 条请求有 379 条走这条分支）。
  const relRows = relSnap(c.host);
  const fresh = relRows.length;
  // 只给「本站点一次都没量过」的中继采样机会，而且必须已经有 1 条样本做锚：
  // 全池轮换会把 0/4、2/4 全 403 的中继塞给用户（实测 tput 2/8），
  // 完全不轮换又永远学不出容量差异（只剩一条中继有样本）。小步、只朝没试过的走。
  const seen = new Set(relRows.map((row) => row.relayIp));
  const unmeasured = stick.filter((ip) => !JUDGE.negOn(c.host, ip) && !seen.has(ip));
  if (c.mode !== "lat" && coldSite && fresh >= 1 && unmeasured.length > 0) {
    const ip = unmeasured[src.nextRotation(unmeasured.length)] as string;
    return { chan: { kind: "r", ip }, why: "rel-rot" };
  }
  // 冷启动：该站点没有任何通道证据、本出口也没拿到状态码、也还没有「站点×中继」样本
  // → 钉住单条中继 60 秒（理由见 `Policy.pinFor`）。一旦有了样本就交给 stick 排序，
  // 避免钉住覆盖实测结论。
  if (!code && coldSite && fresh === 0) {
    // 钉住的那条一旦进了负面记忆就立刻换下一条：否则一次坏 egress 会在 60 秒里吞掉整个站点
    const pool = (nonCf.length ? nonCf : stick).filter((ip) => !JUDGE.negOn(c.host, ip));
    const cip = src.pinFor(c.host, pool.length ? pool : nonCf.length ? nonCf : stick);
    if (cip) return { chan: { kind: "r", ip: cip }, why: "cold-pin" };
  }
  // 曾经这里有一条「只要本站在某条中继上有过成功记录就直接用它」的短路（`cf-ok-relay`）。
  // 本地闭环证明（`tools/exp-v8proof.mjs`）把它钉成了缺陷：v6 出口有 12.5% 的概率蒙过一次，
  // 一旦蒙过就把整站钉在这条 v6 上，`eg`/`score` 全被绕过（400 条里 399 条走这条短路，成功率 10.8%）。
  // v8 的纪律是「事实只改顺序」：让 `posOf`（最近出过整页）+ `scoreOf`（含族偏置）去排序即可，
  // 蒙过一次的 v6 中继会因为 `eg=6` 的 ×40 而排在已知 v4 后面。
  // 非 CF 主机是唯一能把「客户端 IP 透传」这条封禁规则改判掉的通道，所以优先；
  // 注意「直连成功证据优先」那一条已经在本函数上半部（direct-ok），不在这里重复。
  if (nonCf.length) return { chan: { kind: "r", ip: nonCf[0] }, why: "cf-noncf" };
  // 「本出口 fetch 得 200」不等于「隧道直连得 200」：fetch 走的是 CF 自己的出口，
  // 隧道直连可能落在一个对 CF 托管站点不友好的边缘出口上（实测 200 → 隧道 403）。
  // 所以只有在**隧道直连自己有过成功证据**（`vOk(host,"d")`）时才选直连；否则宁可走一条已知可用的中继。
  // 直连成功证据只信 5 分钟内：边缘出口会漂移，"十分钟前直连 200" 不代表这一分钟还行。
  // 30 分钟 TTL 内一直选直连，一次幸运 200 会换来一串 4 字节 403（实测 tput 15/20 → 20/20 就来自这里）。
  if (code === 403 && stick.length) return { chan: { kind: "r", ip: stick[0] as string }, why: "http403" };
  if (code === 200 && !stick.length) return { chan: DIRECT, why: "http200" };
  if (stick.length) return { chan: { kind: "r", ip: stick[0] as string }, why: "cf-any" };
  // 冷 isolate 兜底：`S.alive` 还没探出来时 `stick` 是空的，原来的结局是直连 → 403。
  // 事实层里已有「这条中继送回过整页」的 v4 出口（DO 读到的），先把它们用起来，
  // 比直连稳得多（钉中继实测 v4 9/9 200、直连约 1/6）。只挑一条，失败交给 dialer 的重试。
  // 事实里的 v4 出口也可能刚被判死：不挑 dead，否则兜底会把请求送到已知连不上的中继
  const eg4 = EG.v4List().filter((x) => !isDead(x));
  if (eg4.length) return { chan: { kind: "r", ip: eg4[0] as string }, why: "eg-pin" };
  return null;
}
