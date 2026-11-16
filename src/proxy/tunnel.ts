import type { Socket } from "cloudflare:sockets";
import { WS_OPEN, closeQuietly, errMsg, safeSend, toU8 } from "../core/util";
import { logErr, rttMark } from "../nodes/metrics";
import { invalidateRank, nsDecay, nsGet, nsSiteFail } from "../nodes/score";
import { cnt } from "../core/counter";
import { S } from "../core/state";
import type { Connection } from "./connection";

/**
 * 功能：把上游数据流写回 WS（下游方向），流结束或出错时收尾。
 * @param ws 客户端 WS
 * @param reader 上游数据流
 * @returns 无
 */
export function pipeBack(
  sock: Socket,
  ws: WebSocketLike,
  st: Connection,
  onClose?: (gotData: boolean) => void | Promise<void>,
): void {
  sock.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const u8 = toU8(chunk);
          // 热路径：加字节 → 比阈值 → 发送。其余全在 tick 里（每 512 KB）
          st.down += u8.length;
          if (!st.ttfb && st.tAttach) st.ttfb = Date.now() - st.tAttach;
          if (st.down >= st.mark) {
            if (!(await st.tick(ws))) return;
          }
          if (st.header && !st.headerSent) {
            const merged = new Uint8Array(st.header.length + u8.length);
            merged.set(st.header, 0);
            merged.set(u8, st.header.length);
            safeSend(ws, merged);
            st.headerSent = true;
          } else {
            safeSend(ws, u8);
          }
          if (!st.markedOk) {
            st.markedOk = true;
            rttMark(st.id, st.ipTag, true);
          }
        },
        close() {
          if (onClose && !st.notified) {
            // 只通知一次：pipe 的 error 路径也会走到同一个 onClose（见下面的 catch）
            st.notified = true;
            // onClose 是 async（可能再拨号 / attach）：这里必须接住 rejection，
            // 否则会在事件回调里变成 unhandled rejection，Workers 直接记 1101。
            try {
              Promise.resolve(onClose(st.down > 0)).catch((e) => {
                logErr("pipe close: " + errMsg(e), st.node || "");
              });
            } catch (e) {
              logErr("pipe close: " + errMsg(e), st.node || "");
            }
          } else {
            try {
              ws.close(1000, "done");
            } catch (e) {}
          }
        },
        abort() {
          closeQuietly(sock);
        },
      }),
    )
    .catch((err) => {
      logErr("pipe: " + errMsg(err), st && st.node ? st.node : "");
      closeQuietly(sock);
      const clientGone = !ws || ws.readyState !== WS_OPEN;
      if (st && !st.notified) {
        if (clientGone) {
          // 客户端自己走了（切网 / 关标签 / 取消）：不是节点的问题，不记失败、不冻结
          st.notified = true;
          cnt("ccut");
        } else if (st.down === 0 && onClose) {
          // 连上了却一个下行字节都没给就报错：与「上游正常关闭、零字节」（close 路径）
          // 是同一种可观察事实，必须走同一本账 —— attacher 的 onClose 会记 eCloseP、
          // 给 nsEmptyClose 降权、并换一条中继重试。7.245 之前这里什么都不做，于是
          // 「接受连接后立刻 RST」的节点既不计数也不降权，客户端只收到 1011。
          st.notified = true;
          Promise.resolve(onClose(false)).catch((e) => {
            logErr("pipe close: " + errMsg(e), st.node || "");
          });
        } else if (st.down > 0) {
          st.notified = true;
          st.failed = true;
          cnt("cut");
          if (st.node) {
            if (st.siteFail) {
              nsSiteFail(st.node); // 站点侧：只轻记
            } else {
              // 中途断流是节点问题：只记 trafficFailW 的话 pFail/可用性完全看不到，
              // 节点过了 60 秒冻结又原样回到候选表。加 0.5 次失败权重（不走阶梯）。
              const sn = nsGet(st.node),
                now = Date.now();
              nsDecay(sn, now);
              sn.failW = (sn.failW || 0) + 0.5;
              sn.fail = (sn.fail || 0) + 0.5;
              sn.trafficFailW = (sn.trafficFailW || 0) + 0.5;
              // 中途断流的节点先凉 60 秒；站点级试探不冻结（可能只是对这个站不行）
              if (!st.hostTrial) {
                sn.freeUntil = Math.max(sn.freeUntil || 0, now + 60000);
                S.hostRankCache.clear(); // 站点排行不能继续推荐刚断流的节点
                invalidateRank();
              }
              sn.at = now;
            }
          }
        }
      }
      if (!clientGone) {
        try {
          ws.close(1011, "pipe error");
        } catch (e) {}
      }
    });
}

