import type { Socket } from "cloudflare:sockets";
import { cnt } from "../core/counter";
import { WS_BUFFER_LIMIT, WS_MAX_BUFFER, WS_OPEN, WS_STALL_MS, closeQuietly } from "../core/util";

/** 背压检查的轮询间隔：10ms 是「感知得到客户端在读」与「不空转烧 CPU」的折中 */
export const FLOW_TICK_MS = 10;

/**
 * 客户端这一侧的流量控制：客户端收不动时暂停读上游，超时或爆缓冲则主动断开。
 *
 * 为什么单独成类：这段逻辑是**唯一**读 `ws.bufferedAmount` 的地方，也是唯一拿
 * 「客户端断连」与「节点卡死」做区分的地方 —— 两类原因必须记不同的计数器
 * （`ccut` vs `stall`），否则面板的可用性会被客户端切网/关标签页拉低（7.124 的同族缺陷）。
 * 把它埋在 `Connection` 的热路径旁边时，这两条计数的差别读不出来。
 *
 * 状态只有一项：本连接累计的背压毫秒。它同时喂给结算（`pStall`）和采样（折扣因子）。
 */
export class ClientFlow {
  /** 本连接累计的背压毫秒（只累加「真的卡住了」的时间，正常的缓冲不算） */
  stallMs = 0;

  /**
   * 功能：检查客户端缓冲区；必要时等它排空，等不到就断开这条连接。
   * @param {WebSocketLike} ws 客户端连接
   * @param {Socket | null} sock 上游 socket（判定卡死后要一起关掉）
   * @returns {Promise<boolean>} 真表示可以继续读上游，假表示这条连接应当中止
   */
  async gate(ws: WebSocketLike, sock: Socket | null): Promise<boolean> {
    const buffered = ws.bufferedAmount || 0;
    // 缓冲在阈值内：直接放行，这条热路径不该有任何等待
    if (buffered <= WS_BUFFER_LIMIT) return true;

    const t0 = Date.now();
    // 超限之后不立刻断：客户端可能只是瞬时抖动，给它 60 秒的恢复窗口
    const deadline = t0 + WS_STALL_MS;
    while ((ws.bufferedAmount || 0) > WS_BUFFER_LIMIT) {
      if (ws.readyState !== WS_OPEN) {
        // 「客户端自己走了」不是节点断流：必须记 ccut。记成 cut 会把切网/关标签算到节点头上
        cnt("ccut");
        closeQuietly(sock);
        return false;
      }
      if ((ws.bufferedAmount || 0) > WS_MAX_BUFFER || Date.now() > deadline) {
        // 缓冲涨到 16MB 上限或等满 60 秒：判定真卡死，主动断，别让一个连接拖住整个 isolate
        cnt("stall");
        this.stallMs += Date.now() - t0;
        try {
          ws.close(1011, "stall");
        } catch (e) {
          /* 已经关了就不必再关一次 */
        }
        closeQuietly(sock);
        return false;
      }
      await new Promise((r) => setTimeout(r, FLOW_TICK_MS));
    }
    // 排空了：这段时间仍然算「背压时间」，它要进 pStall 的分母（客户端慢是真的慢）
    this.stallMs += Date.now() - t0;
    return true;
  }
}
