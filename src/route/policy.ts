// 通道决策的唯一入口（OOP 版）：观测 → 判定表 → Policy → 执行。
// 影子模式（SC.POLICY = 0）下只统计「建议」与「现状」的一致率，不改行为。
//
// 三层分工（7.285 起）：`policy-ctx.ts` 放输入/输出类型，`policy-wiring.ts` 把能力接到 HOOK 槽位，
// 这个文件只剩决策算法与三张按站点的内存表。
import { SC } from "../core/const";
import { S } from "../core/state";
import { isCfIp } from "../core/net";
import { DIRECT } from "./channel";
import { vAll, vAt, vBad, vOk } from "./verdict";
import { HEALTH, ipOf } from "./relay-health";
import { JUDGE } from "./judge";
import { psBest } from "./psfacts";
import { HOST_MEM_MAX } from "./policy-ctx";
import type { Choice, Ctx } from "./policy-ctx";
import { WIRING } from "./policy-wiring";
import { cnt } from "../core/counter";
import { St } from "../core/enums";
import { rankOf } from "./policy-rank";
import { decideCf } from "./policy-cf";
import type { PinSource } from "./policy-cf";

/** 选路策略：纯内存、可单测；所有「哪条通道」的判断都收敛在这里 */
export class Policy implements PinSource {
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
   * 压回时删 Map 里最前面的键，所以**顺序必须是最近使用序**。
   * 注意：JavaScript 的 `Map.set` 对已存在的键只更新值、**不移动插入位置**，
   * 所以「最近使用」不能在注释里假设，只能靠写入端先 `delete` 再 `set` 显式维持
   * （见 `decide` 与 `pinFor`）。7.204 之前这里按首次插入序淘汰：最早见过的站点
   * 往往正是最热的站点，于是它第一个被删、康复计数器反复归零，而真正陈旧的站点留着。
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
    if (pick) {
      // 同 `seq`：不先删就 set，`trim` 会按首次插入序淘汰，把刚钉过的站点先删掉
      this.pin.delete(host);
      this.pin.set(host, { ip: pick, until: now + 60_000 });
      // 写入端自己封顶：trim 原先只在 decide 里被调，单走 pinFor 的路径上这张表会无限长
      if (this.pin.size > HOST_MEM_MAX) this.trim();
    } else this.pin.delete(host);
    return pick;
  }

  /**
   * 功能：取下一个轮换序号（吞吐模式冷启动时让前几条连接落在不同中继上）。
   *
   * 为什么是游标而不是随机：容量差异要「尽快覆盖几条」，随机抽样在 16 条候选上
   * 会重复命中同一条（生日问题），轮换保证 N 条请求就覆盖 N 条中继。
   * @param limit 候选条数
   * @returns 0..limit-1 的下标
   */
  nextRotation(limit: number): number {
    return this.rot++ % limit;
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
    // 候选视图（排序 + 分类）由 policy-rank.ts 算，本函数只做「谁先谁后」的裁决。
    const r = rankOf(c);
    // 探索：被判死的通道按 5% 概率复检 —— 判死只是「当前证据」，网络会变，不试就永远好不了。
    // 成功的大响应会经 Judge 把它改回 ok；失败只会刷新 TTL，代价是一次连接的尝试。
    if (r.blocked.length && Math.random() < 0.05) {
      return { chan: { kind: "r", ip: r.blocked[0] as string }, why: "explore" };
    }
    // 直连已被实测/差分判死（任何站点都适用）→ 直接换中继
    if (r.usable.length && vBad(c.host, "d")) {
      return { chan: { kind: "r", ip: (r.nonCf[0] || r.usable[0]) as string }, why: "dir-blocked" };
    }
    // 康复通道（v8 §3.2 / D12）：每 20 条请求放 1 条「历史上有过整页、但现在排在最后」的中继。
    // 不这么做就存在死锁：被降权的通道再也拿不到样本 → 成功率永远停在先验 → 永远回不来。
    // 用序号而不是随机数，是为了让「第 20 条会康复」这件事可复现、可断言。
    const nth = (this.seq.get(c.host) || 0) + 1;
    // 先 delete 再 set：Map 对已存在的键不移动位置，不这么做 `trim` 就是在按首次插入序淘汰
    this.seq.delete(c.host);
    this.seq.set(c.host, nth);
    // 站点名不是有限集合：超过上限就压回（见 trim 的注释）
    if (this.seq.size > HOST_MEM_MAX || this.pin.size > HOST_MEM_MAX) this.trim();
    if (nth % 20 === 0 && r.stick.length > 1) {
      // 闸门看「历史最好」而不是会衰减的当前均值：这条通道唯一的用途就是打破
      // 「被降权 → 拿不到样本 → 永远回不来」的死锁；用均值等于把这次机会交给运气
      // （实测口径：成过一次、之后连败十条的通道，均值早已 < 0.6，而它正是最该被放一条的）。
      const back = r.stick.filter((ip) => psBest(c.host, ip) >= 0.6 || JUDGE.posOn(c.host, ip));
      const worst = back.length ? (back[back.length - 1] as string) : "";
      if (worst && worst !== r.stick[0]) {
        cnt("rehab");
        return { chan: { kind: "r", ip: worst }, why: "rehab" };
      }
    }
    // 直连成功证据只信 5 分钟：边缘出口会漂移。这条必须排在「客户端 v6」与「有中继就用中继」之前 ——
    // 客户端地址族只影响落到哪个 POP，不会传给目标（本地配对实测：直连 30/30 vs 中继 26/30）。
    const dAt = vAt(c.host, "d");
    if (vOk(c.host, "d") && dAt && Date.now() - dAt < 300000) return { chan: DIRECT, why: "direct-ok" };
    // 剩下的局面全在 policy-cf.ts：CF 托管目标的六个分支（v6 客户端 / 未量过轮换 / 冷启动钉住 /
    // 优先非 CF / 本出口状态码 / 事实层兜底）。它对非 CF 目标返回 null，表示「不归它管」。
    const cf = decideCf(c, r, this);
    if (cf) return cf;
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
      if (v.target !== host || v.state !== St.Reachable) continue;
      if (v.channel === "d") d = true;
      else if (v.channel.startsWith("r:")) {
        r = true;
        break;
      }
      if (d && r) break;
    }
    return { d, r };
  }

  /**
   * 功能：把策略装配到 HOOK 槽位（由 `src/index.ts` 的副作用 import 触发）。
   * 装配逻辑本体在 `PolicyWiring.install`：那一层管「谁接哪个槽位」，这里只是入口。
   * @returns {void}
   */
  install(): void {
    WIRING.install(this);
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
