// 行为判定（OOP 版）：把「连接收尾的观测」变成判定表结论。
// 只有这里会因流量写判定：probe 级证据（7.69 删除）与客户端回流（从来没接）都不存在。
// 设计目标：① IP 级封锁 1 次请求就能感知；② 业务层 403 绝不被「拦截」——
// 判定只影响「走哪条通道」，永不断开连接；某站点一条通道都不剩时自愈（VerdictTable.clearHost）。
import { S } from "../core/state";
import { TrafficEvt } from "../core/hook";
import { Chan, DIRECT, chanKey } from "./channel";
import { vBad, vOk } from "./verdict";
import { recordBlock, recordPass, recordTraffic } from "./observe";
import { cfHttpCode } from "../proxy/cfverdict";
import { cnt } from "../core/counter";
import { HEALTH } from "./relay-health";
import { FACT } from "./factshadow";
import type { FactOut } from "./commitfact";
import { PS } from "./psfacts";
import { DNS } from "./dnsfacts";
import { egDerive } from "./egfacts";
import { BLK } from "./blkfacts";

const BIG = 20000; // 整页（含握手）的下限
const SMALL_MAX = 12000; // 小响应上限：再大就不当封锁证据
const JUNK_MAX = 6000; // 中继自家默认页的量级
const BASE_TTL = 6 * 3600_000; // 「站点能出整页」的记忆
const PX_TTL = 21_600_000; // 下次优先中转的提示位
const NEG_TTL = 600_000; // 短负面记忆：10 分钟后自动失效（只降权，不写封禁）
/** 正记忆：刚出过整页的中继在 10 分钟内优先复用；冷 isolate 的「每连接盲选」是主要残差来源 */
const POS_TTL = 600_000;
// 「这条中继出口对 CF 托管站点不友好」的通用键：只用在本 isolate 的软降权里，
// 不进判定表、不跨 isolate 共享 —— 它是一条统计倾向，不是封锁事实。
export const CF_NEG = "*cf";

/** 判定器：唯一写「流量证据」的地方，纯内存、无 IO */
export class Judge {
  /**
   * 短负面记忆：键 `站点|通道`，值 = 到期时间戳。
   *
   * 存在的原因：公开中继背后是一组 egress，部分出口走 IPv6 或质量差，**同一条中继会逐连接漂移**；
   * 选路层只按健康度/证据时间排序治不了它。这里用「刚刚这条通道对该站点回了异常小的响应」
   * 作为 10 分钟的软降权依据，让突发流量中的下一条连接自动绕开它，但绝不写封禁
   * （不放进判定表，因此不影响「无 2xx 不写封禁」的纪律，也不会污染 blockedRatio）。
   */
  private neg = new Map<string, number>();
  /** 正记忆：`站点|r:ip` → 到期时间戳（有界，见 markPos） */
  private pos = new Map<string, number>();

  /**
   * 功能：记录一条短负面记忆（10 分钟），供选路层把该通道排到后面。
   * @param host 目标站
   * @param ip 中继出口 IP
   * @param now 当前时间戳
   * @returns 无
   */
  markNeg(host: string, ip: string, now: number): void {
    if (!host || !ip) return;
    this.neg.set(host + "|r:" + ip, now + NEG_TTL);
  }

  /**
   * 功能：查询该（站点, 中继）是否仍在负面记忆期内。
   * @param host 目标站
   * @param ip 中继出口 IP
   * @param now 当前时间戳
   * @returns 在期内返回 true（调用方应把它排到后面，而不是禁用它）
   */
  negOn(host: string, ip: string, now = Date.now()): boolean {
    const k = host + "|r:" + ip;
    const until = this.neg.get(k);
    if (!until) return false;
    if (until > now) return true;
    this.neg.delete(k); // 过期即清，避免表随流量无限长
    return false;
  }

  /**
   * 功能：记录一条「该中继刚给本站出过整页」的正记忆（10 分钟），供选路层优先复用。
   * @param host 目标站
   * @param ip 中继出口 IP
   * @param now 当前时间戳
   * @returns 无
   */
  markPos(host: string, ip: string, now: number): void {
    if (!host || !ip) return;
    if (this.pos.size > 400) this.pos.clear(); // 有界：满了整表清空（正记忆丢了只是回到盲选，不致命）
    this.pos.set(host + "|r:" + ip, now + POS_TTL);
  }

  /**
   * 功能：查询该（站点, 中继）是否仍在正记忆期内。
   * @param host 目标站
   * @param ip 中继出口 IP
   * @param now 当前时间戳
   * @returns 在期内返回 true（调用方应优先复用它）
   */
  posOn(host: string, ip: string, now = Date.now()): boolean {
    const k = host + "|r:" + ip;
    const until = this.pos.get(k);
    if (!until) return false;
    if (until > now) return true;
    this.pos.delete(k);
    return false;
  }

  /** 连接收尾的观测 */
  onTraffic(e: TrafficEvt): void {
    if (e.host === S.site) return; // 探自己域名必 522（CF 自环），不构成任何通道证据
    // 事件自己的时间戳：回放/聚合的事件必须按发生时间归批，否则三批会被压成一批
    const ty = (e as { at?: number }).at ?? Date.now();
    HEALTH.note(e.node, e.down, e.ok); // 中继存活度：与站点无关的那一半证据
    // v8 的写入裁决：`commitFact` 决定「这条观测最多能写一条什么事实」。
    // 生产与影子**共用同一次裁决**（`FACT.decide`）：以前影子先算、生产再算一次，而影子算完就会
    // 推进批次/节流时钟 —— 生产读到的是「刚刚」，于是密集 tiny 流里生产侧永远看到 `R_SINGLE_BATCH`。
    // 分工要写清，否则很容易以为「这里就是唯一的写入口」：
    //   · `ps`（站点×中继的成功率）由这里消费，是唯一的写者；
    //   · `blk`（封锁）不在这里落库 —— 它需要「三批独立确认」的跨事件状态，纯函数持不了，
    //     真正的写者是下面 `BLK.note` 的批次投票，`commitFact` 的 `blk` 裁决只是逐观测的建议；
    //   · `dead` 同理，由拨号器/探活的 `deadNote` 写。
    let out: FactOut = { reason: "" };
    try {
      out = FACT.decide(e, ty);
    } catch {
      /* 影子统计绝不影响真实判定 */
    }
    if (e.via === "node" && e.node && e.host) {
      const pip = e.node.slice(0, e.node.lastIndexOf(":"));
      if (pip) {
        // 只有「拿到完整响应」才记成功率；tiny 的负样本由 blk 的批次投票负责（§5.1 D14）
        if (out.write && out.write.kind === "ps" && out.write.j.ok) PS.note(e.host, pip, true, ty);
        // B 级负样本：`tiny` + 同窗口有 ≥20KB 对照，但批次还不够三批（A 级），此时不写 `blk`，
        // 但必须让 `ps` 记住这次失败 —— 否则 `ps` 只能因为成功而变便宜（`factor = prior/p` 恒 ≤1），
        // 「这条中继对这个站点不行」这个信息一条也进不去（本地对照里 `ps` 边际为 0 的主因之一）。
        else if (out.reason === "R_TINY_PEER") PS.note(e.host, pip, false, ty);
      }
    }
    const chan = this.chanOf(e);
    const ck = e.host + "|" + chanKey(chan);
    const now = ty;
    // 事件自己的时间戳：回放/聚合的事件必须按发生时间归批，否则三批会被压成一批
    // v8 的 blk：只有「本通道 tiny + 同窗口另一通道出过整页」才投票（三批独立确认后才写行）。
    // 这里只喂证据，不决定顺序 —— 后果是代价 ×6（policy 里乘），候选永远不会被移出。
    if (e.via === "node" && e.node && e.host) {
      const nip = e.node.slice(0, e.node.lastIndexOf(":"));
      const row = S.peers.get(e.host);
      // 用事件时间 `ty` 而不是 `Date.now()`：回放/聚合的事件按发生时间判窗口，
      // 否则「同一批事件」在回放时永远看不到对照（与上面归批时钟是同一个坑）。
      const peerBig = !!row && row.some((x) => x.down >= 20000 && ty - x.at <= 120000);
      if (nip && e.down > 0 && e.down <= 2048 && peerBig) BLK.note({ host: e.host, ip: nip, down: e.down, peerBig: true, at: ty });
      else if (nip && e.down >= 20000) BLK.contra(e.host, nip);
    }

    // 整页是出口族的硬证据，必须在下面「整页直接 return」之前提取，否则永远走不到那条分支。
    if (e.via === "node" && e.node) egDerive(e.node.slice(0, e.node.lastIndexOf(":")), e.down, { siteV4: DNS.v6Of(e.host) === 0, cf: !!e.cf }, now);
    if (e.ok && e.down >= BIG) {
      cnt("trHit");
      S.bigByHost.set(e.host, now);
      S.bigChan.set(e.host, ck);
      S.smCnt.delete(ck);
      recordTraffic({ target: e.host, chan, down: e.down, ok: true });
      recordPass({ target: e.host, chan, down: e.down, ok: true });
      // 正记忆：这条中继刚给本站出过整页 —— 10 分钟内优先复用它。
      // 依据只有本 isolate 的观测，不跨 isolate 共享（各 isolate 的出口质量不同）。
      if (e.via === "node" && e.node) this.markPos(e.host, e.node.slice(0, e.node.lastIndexOf(":")), now);
      return;
    }
    if (e.down <= 0 || e.down >= SMALL_MAX || e.life > 8000 || e.up > 16384) return;

    cnt("trSmall");
    if (e.cf) {
      if (e.down < 900) cnt("sz1");
      else if (e.down < 1500) cnt("sz2");
      else if (e.down < 3000) cnt("sz3");
      else cnt("sz4");
      // 归因：小响应是「直连出口被拒」还是「中继出口被拒」——调参前必须知道钱花在哪条路上
      cnt(e.via === "node" ? "smN" : "smD");
    }
    const n = (S.smCnt.get(ck) || 0) + 1;
    S.smCnt.set(ck, n);

    // 中继把自家默认页（nginx）当响应回：这个中继对任何站点都是废的，攒 3 次判死
    if (e.ok && e.via === "node" && e.down < JUNK_MAX && n >= 3) {
      this.markBlocked(e, chan, ck, now);
      return;
    }
    // 「站点本身能出内容」的旁证（有其一即可 1 次请求判定）：
    // ① 本出口 fetch 根路径 200 —— 站点活着，而这条通道只回了小响应；
    // ② 同站点**另一条**通道 6 小时内出过整页 —— 差分成因明确。
    const httpOk = cfHttpCode(e.host) === 200;
    const bigDiff = (S.bigByHost.get(e.host) || 0) > now - BASE_TTL && S.bigChan.get(e.host) !== ck;
    const known = httpOk || bigDiff;
    // 短负面记忆：只要「站点确实能出整页」的旁证成立，就把这条通道对该站点软降权 10 分钟。
    // 它是选路层的排序依据，不是封锁结论 —— 突发负载下一条连接就会换别的通道。
    if (known && e.via === "node") {
      const nip = e.node ? e.node.slice(0, e.node.lastIndexOf(":")) : "";
      // 只做本 isolate 的软降权（10 分钟），**不写通配封锁**：
      // 曾经试过用 `*|r:<中继>` 把「这条中继出口走 v6」共享给其他 isolate，实测副作用更大 ——
      // 通配行 30 分钟才过期，几轮突发就能把大半中继标死，可用池变薄后连接反而更差（失败率 10→20%）。
      // 结论：出口地址族确实可以共享，但必须走「带节点名的软标记 + 有界表」，不能复用硬封锁通道。
      if (nip) this.markNeg(e.host, nip, now);
      // 同一份证据再记一份「这条中继对 CF 托管站点不友好」：出口地址族这类毛病与具体站点无关，
      // 学一次就能惠及所有 CF 托管目标（仍只在本 isolate 生效、10 分钟过期）。
      if (nip && e.cf) this.markNeg(CF_NEG, nip, now);
    }
    // 出口族只能从「这次真拿到了什么」反推：整页 ⇒ v4；同类小页且有整页对照 ⇒ v6。
    if (e.via === "node" && e.node) egDerive(e.node.slice(0, e.node.lastIndexOf(":")), e.down, { peerBig: bigDiff, known, siteV4: DNS.v6Of(e.host) === 0, cf: !!e.cf }, now);
    if (!known) {
      if (n >= 2 || e.cf) S.needPx.set(e.host, now + PX_TTL); // 只提醒「下次优先中转」，不下判定
      return;
    }
    this.markBlocked(e, chan, ck, now);
  }

  /** 距该通道上次被判 ok 的时间（0 = 没有记录） */
  okAge(host: string, ip: string): number {
    return vOk(host, "r:" + ip) ? 1 : 0;
  }

  /** 选路用：该通道是否被判死 */
  blocked(host: string, ip: string): boolean {
    return vBad(host, "r:" + ip);
  }

  /**
   * 功能：私有：落一条封锁结论（强证据，覆盖流量弱证据），并写一条日志。
   * @param e 流量事件（目标、上行/下行字节）
   * @param chan 通道
   * @param ck 通道键（判定表键）
   * @param now 当前时间戳
   * @returns 无
   */
  private markBlocked(e: TrafficEvt, chan: Chan, ck: string, now: number): void {
    S.smCnt.delete(ck);
    recordBlock({ target: e.host, chan, down: e.down, ok: false });
    S.needPx.set(e.host, now + PX_TTL);
  }

  /**
   * 功能：私有：由流量事件构造通道对象（经中转带 IP，否则直连）。
   * @param e 流量事件
   * @returns 通道对象
   */
  private chanOf(e: TrafficEvt): Chan {
    const ip = e.node ? e.node.slice(0, e.node.lastIndexOf(":")) : "";
    return e.via === "node" && ip ? { kind: "r", ip } : DIRECT;
  }
}

/** 进程内唯一判定器 */
export const JUDGE = new Judge();

