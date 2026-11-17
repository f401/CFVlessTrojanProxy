import { SC } from "../core/const";
import { S } from "../core/state";
import { isCfIp } from "../core/net";
import { DIRECT } from "./channel";
import { VT } from "./verdict";
import { HEALTH, ipOf } from "./relay-health";
import { JUDGE, CF_NEG } from "./judge";
import { PS } from "./psfacts";
import { WIRING } from "./policy-wiring";
import type { Choice, Ctx } from "./policy-wiring";
import { cnt } from "../core/counter";
import { St } from "../core/enums";
import { FACT_ALL } from "./factflags";
import { BLK } from "./blkfacts";
import { DEAD } from "./deadfacts";
import { factMul } from "./factmul";
import { RELPERF } from "./relperf";
import { EG } from "./egfacts";
import { cfHttpCode } from "../proxy/cfverdict";

// ---- 并入自 policy-ctx.ts ----
// 通道决策的输入/输出类型与共享上限：这里只有类型与常量，不含任何算法，
// 目的是让策略本体与装配层都能引用它而不产生循环依赖。

/** 全开的默认集合：没有读到 `env.facts` 时用它，等价于「不裁剪」。 */
export const FULL_ON: ReadonlySet<string> = new Set<string>(FACT_ALL);

/**
 * 「按站点」的内存表上限：站点名来自客户端请求，不是有限集合。
 * 7.158 起这个数字在 `SC.HOST_MEM_MAX`（judge / dialer / verdictsync 也要用同一份），
 * 这里保留别名只是为了不把 trim 里的算式改得到处都是。
 */
export const HOST_MEM_MAX = SC.HOST_MEM_MAX;

/** 端口类型住在装配层（`policy-wiring.ts`）：这里只做再导出，调用点不必改。 */
export type { Choice, Ctx } from "./policy-wiring";



// ---- 并入自 policy-rank.ts ----
// 决策的第一步：把「这一次能用哪些中继」算出来并按代价排好序。
//
// 这一步全是**纯计算**（只读判定表、负面/正记忆、健康度、站点实测与事实层），
// 不持有任何跨请求状态，所以做成自由函数而不是类 —— 它回答的是「候选长什么样」，
// 不回答「这次选谁」（那是 `policy.ts` 的竞技场，也是 `policy-cf.ts` 的分支树）。


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
  const dead = c.relays.filter((ip) => VT.bad(c.host, "r:" + ip));
  const sorted = dead.slice().sort((a, b) => VT.at(c.host, "r:" + b) - VT.at(c.host, "r:" + a));
  for (const ip of sorted.slice(2)) VT.setState(c.host, "r:" + ip, 0, 1);
  return c.relays.filter((ip) => !VT.bad(c.host, "r:" + ip));
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
  let usable = c.relays.filter((ip) => !(c.host && VT.bad(c.host, "r:" + ip)));
  usable = healRatio(c, usable);
  // 自愈：全部通道都被判死 → 清掉该站点的结论（宁可再试一次，也不能让站点没路可走）
  if (!usable.length && c.relays.length) {
    VT.clearHost(c.host);
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
    const r = RELPERF.costFor(c.mode === "lat" ? "lat" : "tput", c.host, ip);
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
        VT.at(c.host, "r:" + b) - VT.at(c.host, "r:" + a),
    );
  // I1：dead 是唯一允许缩小候选的事实，而且只挪到队尾不是删除
  const live = ranked.filter((ip) => !DEAD.isDead(ip));
  const stick = live.length ? live : ranked;
  const nonCf = stick.filter((ip) => !isCfIp(ip));
  // 通配键已不可能存在（7.133 起写入端直接拒绝）
  const okOnes = stick.filter((ip) => VT.ok(c.host, "r:" + ip));
  return { usable, blocked, ranked, stick, nonCf, okOnes };
}

// ---- 并入自 policy-cf.ts ----
// CF 托管目标的通道判定：这一整棵分支树只处理「目标是 CF 托管站点」这一种局面。
//
// 为什么单独成文件：CF 托管站点上直连与 CF 中继都是 CF→CF，会把**客户端出口 IP 原样透传**，
// 于是能改判的只有非 CF 主机（v8 §9）；这一条规则派生出六个分支（v6 客户端 / 只朝未量过轮换 /
// 冷启动钉住 / 优先非 CF / 看本出口状态码 / 事实层兜底）。它们的状态依赖（`pin`/`rot`）与
// `Policy` 的三张按站点表同源，所以用结构化接口 `PinSource` 反向注入 —— 与 7.285 的
// `PolicySource` 同一手法，避免两个文件互相 import。


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
 * 功能：v6 客户端打 CF 托管目标时的通道判定。
 *
 * 为什么单独一段：v6 客户端把目标必判 403（F6），这条分支**不读任何证据**、
 * 也不看本出口状态码 —— 它的结果只由候选分类决定，属于四段里最便宜的一段。
 * @param c 决策上下文（`c.clientV6` 为假时返回 null，交给后面的阶段）
 * @param r 候选视图（排序与分类已算好）
 * @returns 选中的通道；非 v6 客户端返回 null
 */
function cfV6Choice(c: Ctx, r: Ranked): Choice | null {
  if (!c.clientV6) return null;
  const { usable, stick, nonCf, okOnes } = r;
  // 回退顺序用 `stick`（已把判死的挪到队尾），不能退回 `usable` —— 那里面还留着判死的通道；
  // 选谁交给排序结果（`stick` 已按 neg/pos/score 排好），不再按池子迭代顺序取第一条。
  const pool = nonCf.length ? nonCf : stick.length ? stick : usable;
  if (!pool.length) return { chan: DIRECT, why: "v6-cf-none" };
  // 「这池子里有送回过整页的那条」优先，否则取排序第一 —— 两者都在 pool 内，不引入新证据
  const ip = (okOnes.find((x) => pool.includes(x)) || pool[0]) as string;
  return { chan: { kind: "r", ip }, why: "v6-cf" };
}

/**
 * 功能：本站点还没有「可用」证据时的采样轮换与冷启动钉住。
 *
 * 为什么单独一段：这两支都以「本站点一条整页证据都没有」为前提，代价也最高
 * （轮换要挑没量过的那条、钉住要写一张 60 秒的表），而它们**只在这一段成立**。
 * @param c 决策上下文
 * @param r 候选视图
 * @param src 借来的按站点状态（钉住表 / 轮换游标）
 * @param code 本出口的 fetch 状态码（0 = 没拿到）
 * @returns 选中的通道；有证据可依时返回 null，交给后面的阶段
 */
function cfColdChoice(c: Ctx, r: Ranked, src: PinSource, code: number): Choice | null {
  const { stick, nonCf } = r;
  // 「本站点从未成功过」：判定表里没有任何一条中继拿到整页，也没有 10 分钟内的正面记忆
  const coldSite =
    !stick.some((ip) => VT.at(c.host, "r:" + ip) > 0) && !stick.some((ip) => JUDGE.posOn(c.host, ip));
  // 一次扫描同时拿到「量过几条」与「量过哪些」：7.188 之前这里把同一张表扫了三遍（每遍还要排序），
  // 而 CF 托管目标是热路径（闭环证明里 400 条请求有 379 条走这条分支）。
  const relRows = RELPERF.snap(c.host);
  const fresh = relRows.length;
  // 吞吐模式：还没有任何「本站点可用」的证据时**逐条轮换**，而不是钉死一条 60 秒。
  // 为什么：中继容量实测差 3–4 倍（1103 vs 300 KB/s），钉住一条时其余中继永远没有样本，
  // 「按站点 × 中继挑最快」就永远学不出来。只朝「没量过、也没进负面记忆」的那几条走。
  if (c.mode !== "lat" && coldSite && fresh >= 1) {
    const seen = new Set(relRows.map((row) => row.relayIp));
    const unmeasured = stick.filter((ip) => !JUDGE.negOn(c.host, ip) && !seen.has(ip));
    if (unmeasured.length > 0) {
      const ip = unmeasured[src.nextRotation(unmeasured.length)] as string;
      return { chan: { kind: "r", ip }, why: "rel-rot" };
    }
  }
  // 冷启动：该站点没有任何通道证据、本出口也没拿到状态码、也还没有「站点×中继」样本
  // → 钉住单条中继 60 秒（理由见 `Policy.pinFor`）。一旦有了样本就交给 stick 排序，避免钉住覆盖实测。
  if (!code && coldSite && fresh === 0) {
    // 钉住的那条一旦进了负面记忆就立刻换下一条：否则一次坏 egress 会在 60 秒里吞掉整个站点
    const pool = (nonCf.length ? nonCf : stick).filter((ip) => !JUDGE.negOn(c.host, ip));
    const cip = src.pinFor(c.host, pool.length ? pool : nonCf.length ? nonCf : stick);
    if (cip) return { chan: { kind: "r", ip: cip }, why: "cold-pin" };
  }
  return null;
}

/**
 * 功能：按候选分类与本出口状态码收口（非 CF 主机优先 → 状态码 → 任意中继）。
 *
 * 为什么单独一段：这三条判据只读 `Ranked` 与一个状态码，不碰任何表，最便宜且最常命中。
 * @param r 候选视图
 * @param code 本出口的 fetch 状态码
 * @returns 选中的通道；候选为空时返回 null
 */
function cfEgressChoice(r: Ranked, code: number): Choice | null {
  const { stick, nonCf } = r;
  // 非 CF 主机是唯一能把「客户端 IP 透传」这条封禁规则改判掉的通道，所以优先。
  // 「直连成功证据优先」那一条在 `Policy.decide` 的上半部（direct-ok），这里不重复。
  if (nonCf.length) return { chan: { kind: "r", ip: nonCf[0] }, why: "cf-noncf" };
  // 「本出口 fetch 得 200」不等于「隧道直连得 200」：fetch 走 CF 自己的出口，隧道直连可能落在
  // 对 CF 托管站点不友好的边缘上（实测 200 → 隧道 403）。所以 403 时宁可走一条已知可用的中继；
  // 而 200 且没有任何中继候选时才直连（直连成功证据只信 5 分钟，理由见 `Policy.decide`）。
  if (code === 403 && stick.length) return { chan: { kind: "r", ip: stick[0] as string }, why: "http403" };
  if (code === 200 && !stick.length) return { chan: DIRECT, why: "http200" };
  if (stick.length) return { chan: { kind: "r", ip: stick[0] as string }, why: "cf-any" };
  return null;
}

/**
 * 功能：冷 isolate 兜底 —— 用事实层里「送回整页」的 v4 出口。
 *
 * 为什么需要：`S.alive` 还没探出来时 `stick` 是空的，原来的结局是直连 → 403。事实层里已有
 * 别处观测到的 v4 出口（钉中继实测 9/9 200、直连约 1/6），先把它们用起来，失败交给 dialer 重试。
 * @returns 选中的通道；没有可用出口时返回 null
 */
function cfEgChoice(): Choice | null {
  // 这些出口也可能刚被判死：不挑 dead，否则兜底会把请求送到已知连不上的中继
  const eg4 = EG.v4List().filter((x) => !DEAD.isDead(x));
  return eg4.length ? { chan: { kind: "r", ip: eg4[0] as string }, why: "eg-pin" } : null;
}

/**
 * 功能：CF 托管目标的通道判定（四段按代价从低到高排）。
 * @param c 决策上下文（`c.cfHost` 必须为真才可能返回非空）
 * @param r 候选视图（`policy-rank.ts` 算好的排序与分类）
 * @param src 借来的按站点状态（钉住表 / 轮换游标）
 * @returns 选中的通道；`c.cfHost` 为假时返回 null 表示「不归本文件管」
 */
export function decideCf(c: Ctx, r: Ranked, src: PinSource): Choice | null {
  if (!c.cfHost) return null;
  // 第一段：v6 客户端只看候选分类
  const v6Pick = cfV6Choice(c, r);
  if (v6Pick) return v6Pick;
  // 本出口状态码只作辅助证据（CF→CF 的 fetch 常返回 200，隧道却 403）
  const code = cfHttpCode(c.host);
  // 后三段按代价递增兜底：冷启动采样/钉住 → 分类与状态码收口 → 事实层 v4 出口
  return cfColdChoice(c, r, src, code) || cfEgressChoice(r, code) || cfEgChoice();
}

// ---- 门面（对外导出面保持不变） ----
// 通道决策的唯一入口（OOP 版）：观测 → 判定表 → Policy → 执行。
// 影子模式（SC.POLICY = 0）下只统计「建议」与「现状」的一致率，不改行为。
//
// 三层分工（7.285 起）：`policy-ctx.ts` 放输入/输出类型，`policy-wiring.ts` 把能力接到 HOOK 槽位，
// 这个文件只剩决策算法与三张按站点的内存表。

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
    return !(host && VT.bad(host, "r:" + ip));
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
    if (r.usable.length && VT.bad(c.host, "d")) {
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
      const back = r.stick.filter((ip) => PS.bestOf(c.host, ip) >= 0.6 || JUDGE.posOn(c.host, ip));
      const worst = back.length ? (back[back.length - 1] as string) : "";
      if (worst && worst !== r.stick[0]) {
        cnt("rehab");
        return { chan: { kind: "r", ip: worst }, why: "rehab" };
      }
    }
    // 直连成功证据只信 5 分钟：边缘出口会漂移。这条必须排在「客户端 v6」与「有中继就用中继」之前 ——
    // 客户端地址族只影响落到哪个 POP，不会传给目标（本地配对实测：直连 30/30 vs 中继 26/30）。
    const dAt = VT.at(c.host, "d");
    if (VT.ok(c.host, "d") && dAt && Date.now() - dAt < 300000) return { chan: DIRECT, why: "direct-ok" };
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
    return !!host && !!ip && VT.ok(host, "r:" + ip);
  }

  /** 该站点的通道成功记忆：弱 ok（src=0）也算 */
  win(host: string): { d: boolean; r: boolean } {
    let d = false;
    let r = false;
    for (const v of VT.all()) {
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
   * 功能：策略是否生效（`SC.POLICY` 分级：0 只影子统计 / 1 只放开硬规则 / 2 全生效）。
   * 这是只读属性而不是方法：它是配置的投影，没有动作，调用点读 `POLICY.enabled` 即可。
   */
  get enabled(): boolean {
    return SC.POLICY > 0;
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