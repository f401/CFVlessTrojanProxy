// 判定表的门面：12 个同名函数 + 单例再导出。
// 为什么保留这一层：调用点按函数调用（`vSet`/`vAll`…）写，表本体则按类写；
// 拆开之后「谁能改表」只有 verdict-table.ts 一个答案，而「谁在读表」仍然一眼可见。
import { VT } from "./verdict-table";
import type { Verdict, VSrc, VState } from "./verdict-types";

export { VerdictTable, VT } from "./verdict-table";
export { VT_TTL_MS } from "./verdict-types";
export type { Verdict, VSrc, VState } from "./verdict-types";

/**
 * 功能：写入一条带状态码的观察。
 * @param t 目标站
 * @param c 通道键
 * @param code HTTP 状态码
 * @param ms 首字节延迟（毫秒）
 * @param src 证据来源，默认 1
 * @returns 无
 */
export function vSet(t: string, c: string, code: number, ms: number, src: VSrc = 1): void {
  VT.set(t, c, code, ms, src);
}

/**
 * 功能：直接写入状态（用于判定「被拦/连不上」）。
 * @param t 目标站
 * @param c 通道键
 * @param state 2 被拦 / 3 连不上
 * @param src 证据来源
 * @returns 无
 */
export function vSetState(t: string, c: string, state: VState, src: VSrc): void {
  VT.setState(t, c, state, src);
}

/**
 * 功能：读证据来源。
 * @param t 目标站
 * @param c 通道键
 * @returns 0/1/2
 */
export function vSrc(t: string, c: string): VSrc {
  return VT.srcOf(t, c);
}

/**
 * 功能：读状态机取值。
 * @param t 目标站
 * @param c 通道键
 * @returns 0/1/2/3
 */
export function vState(t: string, c: string): VState {
  return VT.state(t, c);
}

/**
 * 功能：读结论更新时间。
 * @param t 目标站
 * @param c 通道键
 * @returns 毫秒时间戳，无记录为 0
 */
export function vAt(t: string, c: string): number {
  return VT.at(t, c);
}

/**
 * 功能：该通道对该目标是否可用（含通配回落）。
 * @param t 目标站
 * @param c 通道键
 * @returns 可用为 true
 */
export function vOk(t: string, c: string): boolean {
  return VT.ok(t, c);
}

/**
 * 功能：该通道是否被判死/被拦。
 * @param t 目标站
 * @param c 通道键
 * @returns 被判死或被拦为 true
 */
export function vBad(t: string, c: string): boolean {
  return VT.bad(t, c);
}

/**
 * 功能：该目标是否所有通道都不可用。
 * @param t 目标站
 * @returns 全不可用为 true
 */
export function vDead(t: string): boolean {
  return VT.dead(t);
}

/**
 * 功能：列出结论。
 * @param t 目标过滤，空串为全部
 * @returns 判定行数组
 */
export function vAll(t = ""): Verdict[] {
  return VT.all(t);
}

/**
 * 功能：清空判定表。
 * @returns 无
 */
export function vClear(): void {
  VT.clear();
}

/**
 * 功能：清空某个目标的全部结论（站点自愈）。
 * @param t 目标站
 * @returns 无
 */
export function vClearHost(t: string): void {
  VT.clearHost(t);
}

/**
 * 功能：合并远端同步来的强证据。
 * @param rows `目标|通道` 行数组
 * @returns 无
 */
export function vImport(rows: Array<{ k: string; s: number; t: number }>): void {
  VT.import(rows);
}
