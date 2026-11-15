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
import { HEALTH, ipOf } from "./relay-health";
import { CF_NEG, JUDGE } from "./judge";
import { EG } from "./egfacts";
import { relCostMode, relNote, relSnap } from "./relperf";
import { psBest } from "./psfacts";
import { deadNote, isDead } from "./deadfacts";
import { BLK } from "./blkfacts";
import { capNote } from "./capfacts";
import { factMul } from "./factmul";
import { FACTS, type FactsDelta } from "./factsstore";
import { FACT_ALL, factOnce } from "./factflags";

/** 全开的默认集合：没有读到 `env.facts` 时用它，等价于「不裁剪」。 */
const FULL_ON: ReadonlySet<string> = new Set<string>(FACT_ALL);
import { cnt } from "../core/counter";

export interface Ctx {
  host: string;
  cfHost: boolean; // 目标托管在 CF 上
  clientV6: boolean; // 客户端出口是 IPv6（cf-connecting-ip）
  relays: string[]; // 池里可用中继的 IP
  legacyWantsRelay: boolean; // 现状：session 的 wantPx
  /** 传输模式（`tput` / `lat`）；缺省按吞吐模式，测试可省略 */
  mode?: string;
  /** 启用的事实集合；缺省视为全开（测试与旧调用点不必改） */
  facts?: ReadonlySet<string>;
}

/** 「按站点」的两张内存表上限：站点名来自客户端请求，不是有限集合 */
const HOST_MEM_MAX = 512;

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
   * 功能：给两张「按站点」的表设上限（`pin` 与 `seq`）。
   *
   * 为什么要有（v7.140）：两者都在每次决策里 `set` 一次，条目只增不减 —— 长跑 isolate 里
   * 见过的每个站点都会留一行，而站点名来自客户端请求的 ClientHello，不是有限集合。
   * 裁剪规则：先清过期的 `pin`（`until <= now`），再把两张表压回 `HOST_MEM_MAX` 行；
   * 压回时删 Map 里最前面的键 —— `set` 每次都会把键移到末尾，所以顺序 ≈ 最近使用顺序。
   * @param now 当前时间
   * @returns {void}
   */
  trim(now = Date.now()): void {
    for (const [h, v] of this.pin) if (v.until <= now) this.pin.delete(h);
    while (this.pin.size > HOST_MEM_MAX) {
      const first = this.pin.keys().next().value as string | undefined;
      if (!first) break;
      this.pin.delete(first);
    }
    while (this.seq.size > HOST_MEM_MAX) {
      const first = this.seq.keys().next().value as string | undefined;
      if (!first) break;
      this.seq.delete(first);
    }
  }

  /** 功能：当前 `seq` 表条目数（单测与调试端点用）。 @returns {number} 条目数 */
  seqSize(): number {
    return this.seq.size;
  }

  /** 功能：当前 `pin` 表条目数（单测与调试端点用）。 @returns {number} 条目数 */
  pinSize(): number {
    return this.pin.size;
  }

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

  /**
   * 功能：该中继对某站点是否可用（判定表里没有「被封」结论）。
   * 只看站点级结论：通配级封锁在 7.57 事故后就不再有写入者，7.133 起判定表的写入入口
   * 直接拒绝 `*` 行（`blockWild`），所以这里不再查询通配键。
   * @param ip 中继出口 IP
   * @param host 目标站点
   * @returns 可用返回 true
   */
  chanOk(ip: string, host: string): boolean {
    return !(host && vBad(host, "r:" + ip));
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
      // dns：确证「纯 v4 站点」时把 v6 出口乘 2 —— 结构性过不去，不是状态不好。
      return base * factMul(c.facts || FULL_ON, c.host, ip, c.mode || "tput", !!c.cfHost);
    };
    // 站点级自愈：整池都被同一站点写满 ⇒ 判据失效/站点在拒绝所有人，清空并静默 30 分钟。
    // 分母必须是**整池** `c.relays`，不能是过滤后的 `usable`：一条中继被判「封锁」的同一刻
    // 就会离开 `usable`，而它的 `blk2` 封锁行要三批（≥3 分钟）才写成 —— 用 `usable` 当分母时，
    // 分子（有封锁行的通道）恰好被同一个事件剔掉了，覆盖率恒接近 0，这条自愈永远不触发（v7.143）。
    BLK.sweep(c.host, c.relays);
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
    // 站点名不是有限集合：超过上限就压回（见 trim 的注释）
    if (this.seq.size > HOST_MEM_MAX || this.pin.size > HOST_MEM_MAX) this.trim();
    if (nth % 20 === 0 && stick.length > 1) {
      // 闸门看「历史最好」而不是会衰减的当前均值：这条通道唯一的用途就是打破
      // 「被降权 → 拿不到样本 → 永远回不来」的死锁；用均值等于把这次机会交给运气
      // （实测口径：成过一次、之后连败十条的通道，均值早已 < 0.6，而它正是最该被放一条的）。
      const back = stick.filter((ip) => psBest(c.host, ip) >= 0.6 || JUDGE.posOn(c.host, ip));
      const worst = back.length ? (back[back.length - 1] as string) : "";
      if (worst && worst !== stick[0]) {
        cnt("rehab");
        return { chan: { kind: "r", ip: worst }, why: "rehab" };
      }
    }
    const nonCf = stick.filter((ip) => !isCfIp(ip));
    // 优先挑「本站点已实测打得通」的中继；通配键已不可能存在（7.133 起写入端直接拒绝）
    const okOnes = stick.filter((ip) => vOk(c.host, "r:" + ip));

    // 直连成功证据只信 5 分钟：边缘出口会漂移。这条必须排在「客户端 v6」与「有中继就用中继」之前 ——
    // 客户端地址族只影响落到哪个 POP，不会传给目标（本地配对实测：直连 30/30 vs 中继 26/30）。
    const dAt = vAt(c.host, "d");
    if (vOk(c.host, "d") && dAt && Date.now() - dAt < 300000) return { chan: DIRECT, why: "direct-ok" };

    if (c.clientV6 && c.cfHost) {
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
      // 所以只有在**隧道直连自己有过成功证据**（vOk(host,"d")）时才选直连；否则宁可走一条已知可用的中继。
      // 直连成功证据只信 5 分钟内：边缘出口会漂移，"十分钟前直连 200" 不代表这一分钟还行。
      // 30 分钟 TTL 内一直选直连，一次幸运 200 会换来一串 4 字节 403（实测 tput 15/20 → 20/20 的差别就来自这里）。
      if (code === 403 && stick.length) return { chan: { kind: "r", ip: stick[0] as string }, why: "http403" };
      if (code === 200 && !stick.length) return { chan: DIRECT, why: "http200" };
      if (stick.length) return { chan: { kind: "r", ip: stick[0] as string }, why: "cf-any" };
      // 冷 isolate 兜底：`S.alive` 还没探出来时 `stick` 是空的，原来的结局是直连 → 403。
      // 事实层里已有「这条中继送回过整页」的 v4 出口（DO 读到的），先把它们用起来，
      // 比直连稳得多（钉中继实测 v4 9/9 200、直连约 1/6）。只挑一条，失败交给 dialect 的重试。
      // 事实里的 v4 出口也可能刚被判死：不挑 dead，否则兜底会把请求送到已知连不上的中继
      const eg4 = EG.v4List().filter((x) => !isDead(x));
      if (eg4.length) return { chan: { kind: "r", ip: eg4[0] as string }, why: "eg-pin" };
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
  FACTS.ack();
};
HOOK.syncNack = (): void => {
  HEALTH.nack();
  vtNack();
  FACTS.nack();
};
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
HOOK.capNote = (ip: string, kbs: number): void => { capNote(ip, kbs); };
HOOK.vtDelta = (): Array<{ k: string; s: number; t: number }> => vtDelta();
    HOOK.deadNote = (ip: string, ok: boolean): void => deadNote(ip, ok);
    HOOK.factsDelta = (): FactsDelta => FACTS.delta();
    // 之前没注册这个槽位 -> DecisionIn.facts 恒 undefined -> scoreOf 走 FULL_ON，
    // 也就是「facts 绑定只影响 /health 显示、不影响选路」。这是 check-wire 抓不到的接线洞
    // （它扫的是符号是否有生产调用点，而槽位是「注册」不是「调用」）。
    HOOK.facts = (): ReadonlySet<string> => (S.factSet ?? new Set<string>(FACT_ALL));
    HOOK.factsFor = (raw: string): ReadonlySet<string> => factOnce(raw);
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

