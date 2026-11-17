// 节点统计的类型与上限常量：衰減视图、零值、10MB 参考量、空关闭门槛。
// 这里不许出现任何读取 S 的代码 —— 它是其余三个 stat 模块的共同底座。

import { HIST_N } from "../core/const";

/** 衰减后的视图（只读投影，供评分函数复用） */
export interface EffView {
  k: number;
  okW: number;
  failW: number;
  stallMs: number;
  runMs: number;
  sumW: number;
  sumW2: number;
  recentBytesW: number;
  probeSamples: number;
  latN: number;
}

/** 经中转的空关闭累计到多少次算「这条通道可疑」（跨过那一条才作废站点排行缓存） */
export const EMPTY_CLOSE_BAD = 5;

export const TEN_MB = 10 * 1048576;

/** 全零统计行：新建节点、单测与「没有任何样本」的兜底，字段必须与 NodeStats 一致 */
export const ZERO_STAT: NodeStats = {
  ok: 0, fail: 0, at: 0, msLocal: 0, streak: 0, blackUntil: 0, freeUntil: 0, lastTry: 0,
  probeSamples: 0, pSum: 0, pSumSq: 0, probeFails: 0, cusumSum: 0, cusumBase: 0, tcp: 0, tls: 0, trafficOkW: 0, trafficFailW: 0, okW: 0, failW: 0, eCloseP: 0,
  stallMs: 0, runMs: 0, bytesDown: 0, hist: new Array(HIST_N).fill(0),
  sumW: 0, sumW2: 0, recentBytesW: 0, lastSampleAt: 0,
  counted: 0,
  winAt: 0, winOk: 0, winFail: 0,
};
