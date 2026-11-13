// 证据入口：所有观测只从这里进，幂等、去重，且一次写两处（判定表 + 池子基础质量）。
// 硬规则：traffic 只能产生「弱 ok」，blocked/dead 只能由 probe 或 client 产生。
import { nsProbe, nsProbeFail } from "../nodes/score";
import { Chan, chanKey, nodeKeyOf } from "./channel";
import { vSet, vSetState, vState } from "./verdict";

export interface ProbeEvt {
  target: string; // 目标 IP，或 "*"（中继路径钉不死目标 IP）
  chan: Chan;
  code: number; // HTTP 状态码，0 = 没握手/连不上
  ms: number;
}

/** 强证据：同时更新判定表与池子统计 */
export function recordProbe(e: ProbeEvt): void {
  vSet(e.target, chanKey(e.chan), e.code, e.ms, 1);
  const nk = nodeKeyOf(e.chan);
  if (!nk) return;
  if (e.code <= 0) nsProbeFail(nk);
  else nsProbe(nk, e.ms, e.ms, 0);
}

export interface TrafficEvt {
  target: string;
  chan: Chan;
  down: number;
  ok: boolean;
}

/** 弱证据：成功只把 unknown 提成「弱 ok」；失败**不动**结论（等 probe 确认） */
export function recordTraffic(e: TrafficEvt): void {
  const ck = chanKey(e.chan);
  if (e.ok && e.down > 0 && vState(e.target, ck) === 0) vSetState(e.target, ck, 1, 0);
}

export interface ClientEvt {
  target: string;
  chan: Chan;
  ok: boolean;
  ms: number;
}

/** 端到端证据（订阅 expected-status 的回流）：最可信，可直接判 ok/blocked */
export function recordClient(e: ClientEvt): void {
  vSet(e.target, chanKey(e.chan), e.ok ? 200 : 403, e.ms, 2);
}
