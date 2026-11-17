// 客户端 WS 那一侧的常量与生命周期动作：发送（含拆帧）、释放写锁与 socket。
// 名字说明用途 —— 这些以前都叫 `util`，读代码时看不出它们只服务 WS 出口。

export const WS_OPEN = 1;
export const WS_BUFFER_LIMIT = 1024 * 1024; // 下行发送缓冲超过 1MB 就开始背压
export const WS_STALL_MS = 60000; // 客户端一时收不动很常见，给它 60 秒
export const WS_MAX_BUFFER = 16 * 1024 * 1024; // 硬上限：别因为客户端慢就把下载掐死

/** 单帧上限：CF 对超大 WS 消息会直接断开，safeSend 按这个尺寸切片 */
export const WS_MSG_MAX = 256 * 1024;

/**
 * 功能：安全发送——WS 未开或已关闭时静默丢弃（隧道里对端随时消失，不能因此抛错）。
 * @param ws WebSocket 兼容对象
 * @param data 待发字节
 * @returns 无
 */
export function safeSend(ws: WebSocketLike, data: Uint8Array) {
  try {
    if (!ws || ws.readyState !== WS_OPEN) return;
    // 大块拆帧：一次 send 超过约 1 MB 时运行时可能直接重置连接，
    // 表现就是「下载到 1 MB 左右必断」。
    if (data && data.length > WS_MSG_MAX) {
      for (let i = 0; i < data.length; i += WS_MSG_MAX) {
        ws.send(data.subarray(i, Math.min(i + WS_MSG_MAX, data.length)));
      }
    } else {
      ws.send(data);
    }
  } catch (e) {
    /* 对端已关闭，忽略 */
  }
}

/**
 * 释放一次连接持有的全部资源（写队列 + 上层 socket）。
 * @param {object} st 连接状态对象
 * @returns {void}
 */
export function releaseAll(st: { writer: { releaseLock(): void } | null; sock: { close(): void } | null } | null) {
  if (!st) return;
  try {
    if (st.writer) st.writer.releaseLock();
  } catch (e) {
    /* 仍有未完成的写，忽略 */
  }
  st.writer = null;
  closeQuietly(st.sock);
  st.sock = null;
}

/**
 * 静默关闭 socket，忽略重复关闭产生的异常。
 * @param {Socket|null} sock 待关闭的连接
 * @returns {void}
 */
export function closeQuietly(sock: { close(): void } | null | undefined) {
  try {
    if (sock) sock.close();
  } catch (e) {
    /* ignore */
  }
}
