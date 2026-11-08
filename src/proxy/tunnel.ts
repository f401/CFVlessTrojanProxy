import type { Socket } from "cloudflare:sockets";
import { closeQuietly, errMsg, safeSend, toU8 } from "../core/util";
import { logErr, rttMark } from "../nodes/metrics";
import { nsGet } from "../nodes/score";
import { cnt } from "../px/pool";
import type { Connection } from "./connection";

export function pipeBack(sock: Socket, ws: WebSocketLike, st: Connection, onClose?: (gotData: boolean) => void): void {
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
          if (onClose) onClose(st.down > 0);
          else {
            try { ws.close(1000, "done"); } catch (e) {}
          }
        },
        abort() {
          closeQuietly(sock);
        },
      })
    )
    .catch((err) => {
      logErr("pipe: " + (errMsg(err)), st && st.node ? st.node : "");
      closeQuietly(sock);
      // 已经传过数据却异常结束 = 中途断流，算这个节点一次失败（以前只在空关闭时记账）
      if (st && st.down > 0) {
        st.failed = true;
        cnt("cut");
        if (st.node) {
          const sn = nsGet(st.node);
          sn.tF = (sn.tF || 0) + 1;
          // 中途断流的节点先凉 60 秒：客户端的重试就会落到别的节点上，
          // 否则重试大概率还选同一个，用户看到的就是"这个下载一直失败"。
          // 站点级试探的连接不冻结（它可能只是对这个站不行，别的站还好）。
          if (!st.hostTrial) sn.freeUntil = Math.max(sn.freeUntil || 0, Date.now() + 60000);
        }
      }
      try { ws.close(1011, "pipe error"); } catch (e) {}
    });
}
