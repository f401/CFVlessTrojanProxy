// 行为判定（OOP 版）：把「连接收尾的观测」变成判定表结论。
// 只有这里会因流量写判定；probe / client 走 recordProbe / recordClient。
// 设计目标：① IP 级封锁 1 次请求就能感知；② 业务层 403 绝不被「拦截」——
// 判定只影响「走哪条通道」，永不断开连接；某站点一条通道都不剩时自愈（VerdictTable.clearHost）。
import { S } from "../core/state";
import { TrafficEvt } from "../core/hook";
import { Chan, DIRECT, chanKey } from "./channel";
import { vBad, vOk, vSetState } from "./verdict";
import { recordBlock, recordPass, recordTraffic } from "./observe";
import { cfHttpCode } from "../proxy/cfverdict";
import { cnt } from "../core/counter";
import { queueVerify } from "./verify";
import { HEALTH } from "./relay-health";

const BIG = 20000; // 整页（含握手）的下限
const SMALL_MAX = 12000; // 小响应上限：再大就不当封锁证据
const JUNK_MAX = 6000; // 中继自家默认页的量级
const BASE_TTL = 6 * 3600_000; // 「站点能出整页」的记忆
const PX_TTL = 21_600_000; // 下次优先中转的提示位
const NEG_TTL = 600_000; // 短负面记忆：10 分钟后自动失效（只降权，不写封禁）

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

  /** 连接收尾的观测 */
  onTraffic(e: TrafficEvt): void {
    if (e.host === S.site) return; // 探自己域名必 522（CF 自环），不构成任何通道证据
    HEALTH.note(e.node, e.down, e.ok); // 中继存活度：与站点无关的那一半证据
    const chan = this.chanOf(e);
    const ck = e.host + "|" + chanKey(chan);
    const now = Date.now();

    if (e.ok && e.down >= BIG) {
      cnt("trHit");
      S.bigByHost.set(e.host, now);
      S.bigChan.set(e.host, ck);
      S.smCnt.delete(ck);
      recordTraffic({ target: e.host, chan, down: e.down, ok: true });
      recordPass({ target: e.host, chan, down: e.down, ok: true });
      return;
    }
    if (e.down <= 0 || e.down >= SMALL_MAX || e.life > 8000 || e.up > 16384) return;

    cnt("trSmall");
    if (e.cf) {
      if (e.down < 900) cnt("sz1");
      else if (e.down < 1500) cnt("sz2");
      else if (e.down < 3000) cnt("sz3");
      else cnt("sz4");
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
      this.markNeg(e.host, nip, now);
    }
    if (!known) {
      queueVerify(e.host, chan); // 复核队列（PROBE_REQ=0 时只排队）
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

/** 供 probe 通道的结论写回判定表（弱→强升级） */
export function markProbeOk(host: string, ip: string, ms: number): void {
  vSetState(host, "r:" + ip, 1, 1);
  if (ms > 0) vSetState("*", "r:" + ip, 1, 1);
}

