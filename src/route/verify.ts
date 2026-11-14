// 判定复核：流量只当触发器，判定必须靠「同站点 × 两条不同通道」的 TLS 实测差分。
//
// 为什么不能只靠流量：HTTPS 端到端，Worker 只看得见密文字节数，看不见状态码。
// 「小响应 + 短寿命」既可能是出口 IP 被风控（我们关心的），也可能是业务层的 403/401/204。
// 只有拿同一个 host 去两条不同通道各要一次，才能把两者分开：
//   通道 A 403 + 通道 B 200  → 是 A 的出口有问题（通道级，可 veto）
//   两条都 403               → 是站点/业务层拒绝所有人（站点级，不 veto 任何通道）
//   通道 A 200               → 之前的怀疑是误判，记 ok

import { probeTls } from "./probe";
import { Chan, chanKey, nodeKeyOf } from "./channel";
import { vSetState, vState, vAt } from "./verdict";
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

/** 记录一次「可疑」，供下一轮 waitUntil 复核（不直接下判定） */
export function queueVerify(host: string, chan: Chan): void {
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

export function takeVerify(): VQ[] {
  const now = Date.now();
  const out = S.vtQ.filter((q) => now - q.t < TTL).slice(0, 1);
  S.vtQ = S.vtQ.filter((q) => now - q.t < TTL && !out.includes(q));
  return out;
}

export function queueLen(): number {
  return S.vtQ.length;
}

/**
 * 纯函数：由两次实测结论判定。
 * a = 可疑通道的 TLS 结果码，b = 参照通道的结果码（0 = 连接/握手失败）。
 */
export function judge(a: number, b: number): VJudge {
  const ok = (c: number): boolean => c >= 200 && c < 400;
  const blocked = (c: number): boolean => c >= 400 && c < 500;
  if (ok(a)) return "ok";
  if (blocked(a) && ok(b)) return "chan";
  if (blocked(a) && blocked(b)) return "site";
  if (a === 0 && ok(b)) return "chan"; // 可疑通道连握手都过不去，参照通道正常
  return "unknown";
}

/** 选一条参照通道：优先已判 ok 的非 CF 中继，其次任意未判死的中继 */
function pickRef(host: string, skip: string): string {
  let okOne = "";
  let freeOne = "";
  for (const [k] of S.alive) {
    const ip = k.slice(0, k.lastIndexOf(":"));
    const ck = "r:" + ip;
    if (ck === skip) continue;
    const st = vState(host, ck);
    if (st === 1) {
      okOne = ip;
      break;
    }
    if (st !== 2 && st !== 3 && !freeOne) freeOne = ip;
  }
  return okOne || freeOne;
}

/** 执行一次复核：可疑通道 + 参照通道各探一次（每次 ≤2 个子请求） */
export async function runVerify(): Promise<number> {
  const items = takeVerify();
  let n = 0;
  for (const q of items) {
    const ch = q.ck;
    const isD = ch === "d";
    const ip = isD ? "" : ch.slice(2);
    const ref = pickRef(q.host, isD ? "d" : ch);
    if (!ref) continue;
    // 直连也照此办理：可疑通道 = 直连（relay 传空），参照 = 一条中继。
    // 「直连 403 + 中继 200」就是「直连被这个站点封、中继可用」的确切证据。
    const a = await probeTls(q.host, "/head", isD ? "" : nodeKeyOf({ kind: "r", ip }));
    const b = await probeTls(q.host, "/", nodeKeyOf({ kind: "r", ip: ref }));
    const v = judge(a.code, b.code);
    n++;
    if (v === "chan") vSetState(q.host, ch, 2, 1);
    else if (v === "site") vSetState(q.host, "*", 2, 1);
    else if (v === "ok") vSetState(q.host, ch, 1, 1);
    S.vtLast = { host: q.host, ck: ch, a: a.code, b: b.code, v, at: Date.now() };
    if (v === "chan" || v === "site") S.needPx.set(q.host, Date.now() + 21600000);
  }
  return n;
}

/** 供 debug 展示 */
export function verifyInfo(): { q: number; last: typeof S.vtLast } {
  return { q: S.vtQ.length, last: S.vtLast };
}

/** 功能：lastVerifyAt 是薄包装，直接委托 vAt。@param host string。@param ck string。@returns 转发 vAt 的返回值（number） */
export function lastVerifyAt(host: string, ck: string): number {
  return vAt(host, ck);
}

