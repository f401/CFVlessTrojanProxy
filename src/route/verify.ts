// 判定复核：流量只当触发器，判定必须靠「同站点 × 两条不同通道」的 TLS 实测差分。
//
// 为什么不能只靠流量：HTTPS 端到端，Worker 只看得见密文字节数，看不见状态码。
// 「小响应 + 短寿命」既可能是出口 IP 被风控（我们关心的），也可能是业务层的 403/401/204。
// 只有拿同一个 host 去两条不同通道各要一次，才能把两者分开：
//   通道 A 403 + 通道 B 200  → 是 A 的出口有问题（通道级，可 veto）
//   两条都 403               → 是站点/业务层拒绝所有人（站点级，不 veto 任何通道）
//   通道 A 200               → 之前的怀疑是误判，记 ok

import { Chan, chanKey } from "./channel";
import { vAt } from "./verdict";
import { S } from "../core/state";

export type VJudge = "chan" | "site" | "ok" | "unknown";

/** 复核队列项 */
interface VQ {
  host: string;
  ck: string;
  t: number;
}

const QMAX = 24;
const TTL = 120000;

/**
 * 复核队列与差分判定。
 *
 * 所有状态都存在 `S.vtQ` / `S.vtLast` 里（跨 isolate 不共享），
 * 本类只负责「什么时候排一次复核、拿到两个状态码后怎么判」。
 */
export class VerifyQueue {
  /**
   * 功能：记录一次「可疑」，留给下一轮 waitUntil 复核（这里不下判定）。
   * 同一（站点, 通道）在 2 分钟内重复触发只刷新时间，不重复排队。
   * @param host 目标主机
   * @param chan 可疑通道
   * @returns 无
   */
  queueVerify(host: string, chan: Chan): void {
    if (!host) return;
    const ck = chanKey(chan);
    const now = Date.now();
    for (const q of S.vtQ) {
      if (q.host === host && q.ck === ck && now - q.t < TTL) {
        q.t = now;
        return;
      }
    }
    S.vtQ.push({ host, ck, t: now });
    if (S.vtQ.length > QMAX) S.vtQ.shift();
  }

  /**
   * 功能：取走一条待复核项（取出即清空，避免重复花预算）。
   * @returns 待复核项数组（0 或 1 条）
   */
  takeVerify(): VQ[] {
    const now = Date.now();
    const out = S.vtQ.filter((q) => now - q.t < TTL).slice(0, 1);
    S.vtQ = S.vtQ.filter((q) => now - q.t < TTL && !out.includes(q));
    return out;
  }

  /**
   * 功能：待复核队列当前长度。
   * @returns 条数
   */
  queueLen(): number {
    return S.vtQ.length;
  }

  /**
   * 功能：纯函数——由两次实测的状态码判定。
   * @param a 可疑通道的状态码（0 = 连接/握手失败）
   * @param b 参照通道的状态码
   * @returns ok（误判）/ chan（通道级封锁）/ site（站点级拒绝）/ unknown（证据不足）
   */
  judge(a: number, b: number): VJudge {
    const ok = (c: number): boolean => c >= 200 && c < 400;
    const blocked = (c: number): boolean => c >= 400 && c < 500;
    if (ok(a)) return "ok";
    if (blocked(a) && ok(b)) return "chan";
    if (blocked(a) && blocked(b)) return "site";
    if (a === 0 && ok(b)) return "chan"; // 可疑通道连握手都过不去，参照通道正常
    return "unknown";
  }

  /**
   * 功能：执行一轮复核：可疑通道 + 参照通道各探一次，按差分结论落判定。
   * @returns 实际复核的条数
   */
  async runVerify(): Promise<number> {
    // userland TLS 握手在免费计划里跑不完（DO CPU 只有几十毫秒，一次握手就 1102 超限），
    // vendored subtls 已整体删除；判定证据改成「真实流量 + tunnelfetch 探测」两条路，
    // 这里只把队列取空，保持旧接口与单测契约（没有参照通道时不做任何判定）。
    this.takeVerify();
    return 0;
  }

  /**
   * 功能：给调试页用的复核概况。
   * @returns 队列长度与最近一次复核结果
   */
  verifyInfo(): { q: number; last: typeof S.vtLast } {
    return { q: S.vtQ.length, last: S.vtLast };
  }

  /**
   * 功能：某条通道最近一次被复核的时间。
   * @param host 目标主机
   * @param ck 通道键
   * @returns 毫秒时间戳；没复核过为 0
   */
  lastVerifyAt(host: string, ck: string): number {
    return vAt(host, ck);
  }
}

/** 进程内唯一复核队列 */
export const VERIFY = new VerifyQueue();

/**
 * 功能：记录一次可疑（薄包装，委托 VERIFY.queueVerify）。
 * @param host 目标主机
 * @param chan 可疑通道
 * @returns 无
 */
export function queueVerify(host: string, chan: Chan): void {
  VERIFY.queueVerify(host, chan);
}

/**
 * 功能：取走一条待复核项（薄包装）。
 * @returns 待复核项数组
 */
export function takeVerify(): VQ[] {
  return VERIFY.takeVerify();
}

/**
 * 功能：队列长度（薄包装）。
 * @returns 条数
 */
export function queueLen(): number {
  return VERIFY.queueLen();
}

/**
 * 功能：差分判定（薄包装，纯函数）。
 * @param a 可疑通道状态码
 * @param b 参照通道状态码
 * @returns ok / chan / site / unknown
 */
export function judge(a: number, b: number): VJudge {
  return VERIFY.judge(a, b);
}

/**
 * 功能：跑一轮复核（薄包装）。
 * @returns 实际复核条数
 */
export async function runVerify(): Promise<number> {
  return VERIFY.runVerify();
}

/**
 * 功能：调试概况（薄包装）。
 * @returns 队列长度与最近结果
 */
export function verifyInfo(): { q: number; last: typeof S.vtLast } {
  return VERIFY.verifyInfo();
}

/**
 * 功能：某通道最近复核时间（薄包装）。
 * @param host 目标主机
 * @param ck 通道键
 * @returns 毫秒时间戳
 */
export function lastVerifyAt(host: string, ck: string): number {
  return VERIFY.lastVerifyAt(host, ck);
}
