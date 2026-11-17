// 节点统计表本体：只负责「按 host:port 取条目」与「打掉排行缓存」，
// 唯一碰 S.nstat / S.hostRankCache 的地方。统计怎么算在 ./stat-observe，
// 怎么读在 ./stat-view —— 拆开是因为「表」有状态、「算」与「读」没有。

import { HIST_N } from "../core/const";
import { S } from "../core/state";

/**
 * 功能：节点统计表本体 —— 只有「按 host:port 取条目」与「打掉排行缓存」两件事。
 * 条目本身挂在 S.nstat 上（跨请求共享），所以它是仓里少数几个必须有状态的类之一。
 */
export class NodeStatsTable {
  /**
  * 取节点统计对象（不存在则初始化）。
  * @param {string} k "host:port"
  * @returns {object} 统计对象
  */
  nsGet(k: string): NodeStats {
    let s: NodeStats | undefined = S.nstat.get(k);
    // 懒初始化：节点第一次被记样本时才建对象。字段分四组——可用性、探活样本、真实流量、
    // 字节直方图（hist 是 32 档对数刻度，pcts 在上面插值）
    if (!s) {
      s = {
        ok: 0, fail: 0, at: 0, msLocal: 0,
        streak: 0, blackUntil: 0, freeUntil: 0, lastTry: 0,
        tcp: 0, tls: 0, okW: 0, failW: 0, stallMs: 0, runMs: 0,
        probeSamples: 0, pSum: 0, pSumSq: 0, probeFails: 0, cusumSum: 0, cusumBase: 0,   // 探活样本 / ttfb 矩 / 变点
        trafficOkW: 0, trafficFailW: 0,                            // 真实流量（只用于可用性）
        eCloseP: 0,                               // 空关闭：只记「走了中转」的口径（直连侧走 cnt("eCloseD")，不进节点统计）
        bytesDown: 0, hist: new Array(HIST_N).fill(0),
        sumW: 0, sumW2: 0, recentBytesW: 0, lastSampleAt: 0,
        counted: 0,
        winAt: 0, winOk: 0, winFail: 0,
      };
      // 只在这里 set：别处一律拿引用改字段——换对象会让正在跑的连接持有的旧引用失效
      S.nstat.set(k, s);
    }
    return s;
  }

  /** 排行缓存作废：节点状态变了就调它（排序与时间戳一起清，避免只清一半）。
  *  表与进行中的分片进度都留着：否则每次失败都退化成「只有前 128 名」的半张表，
  *  失败密集时还会把分片循环反复打回起点（永远算不完一轮）。 */
  invalidateRank() {
    const c = S.rankCache;
    S.rankCache = { t: 0, at: {}, v: c.v, step: c.step };
  }
}

export const STATS = new NodeStatsTable();

/**
 * 功能：按 host:port 取节点统计条目（没有就新建并挂进 S.nstat）。
 * @param {string} k host:port
 * @returns {NodeStats} 条目
 */
export function nsGet(k: string): NodeStats {
  return STATS.nsGet(k);
}

/**
 * 功能：打掉排行缓存（节点状态变了，下一次 pick 必须重排）。
 * @returns {void}
 */
export function invalidateRank(): void {
  STATS.invalidateRank();
}
