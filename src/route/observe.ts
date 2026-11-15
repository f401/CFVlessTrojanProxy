// 证据入口：流量层三条真实入口（弱 ok / 差分 blocked / 整页 pass）都从这里进。
// 硬规则：流量只能产生「弱 ok」；「差分 blocked」需要同窗口的整页对照（见 recordBlock）。
// 7.150 删掉了另外两条：probe 级（recordProbe，探测链在 7.69 整体移除后零调用点）
// 与客户端回流（recordClient，订阅只有 url-test，客户端从不回传状态码）。
import { Chan, chanKey } from "./channel";
import { vSetState, vState, vSrc, vAt } from "./verdict";

export interface TrafficEvt {
  target: string;
  chan: Chan;
  down: number;
  ok: boolean;
}

/**
 * 功能：弱证据——成功只把 unknown 提成「弱 ok」；失败**不动**结论（等差分或 tfb 确认）。
 * @param e 流量事件（目标、通道、下行字节、是否拿到响应）
 * @returns 无
 */
export function recordTraffic(e: TrafficEvt): void {
  const ck = chanKey(e.chan);
  if (e.ok && e.down > 0 && vState(e.target, ck) === 0) vSetState(e.target, ck, 1, 0);
}

/**
 * 功能：差分证据——上游只回几百~几千字节就结束 = 这条通道对该站点被拒（403/风控）。
 * 只在调用方已经确认「站点本身能出内容」（同窗口整页对照 / 本出口 200）时才该被调用；
 * 7.69 之后不存在探测级证据，所以这条就是「一次差分即可判封锁」的那条路（三批投票的 `blk`
 * 负责的是**代价**，不是判定）。探测确认过能打通的通道在 1 小时内免于被它推翻。
 * @param e 流量事件
 * @returns 无
 */
export function recordBlock(e: TrafficEvt): void {
  const ck = chanKey(e.chan);
  // 1 小时内的好证据（整页/探测级）比一次小响应可信，不用它翻案
  if (vState(e.target, ck) === 1 && vSrc(e.target, ck) >= 1 && Date.now() - vAt(e.target, ck) < 3600000) return;
  vSetState(e.target, ck, 2, 1); // 差分证据可推翻流量级的 ok
}

/**
 * 功能：反向证据——大响应回来 = 这条通道对这个站点能打通，顺手解除之前的小响应误判。
 * @param e 流量事件
 * @returns 无
 */
export function recordPass(e: TrafficEvt): void {
  vSetState(e.target, chanKey(e.chan), 1, 1); // 真拿到整页 = 与探测同级的好证据
}
