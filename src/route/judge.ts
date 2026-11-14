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

/** 判定器：唯一写「流量证据」的地方，纯内存、无 IO */
export class Judge {
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

  private markBlocked(e: TrafficEvt, chan: Chan, ck: string, now: number): void {
    S.smCnt.delete(ck);
    recordBlock({ target: e.host, chan, down: e.down, ok: false });
    S.needPx.set(e.host, now + PX_TTL);
  }

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

