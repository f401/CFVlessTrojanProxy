/**
 * 运行时类型（Cloudflare Workers 的 WebSocket 形状）
 */

/** Worker 侧的 WebSocket（客户端连接与服务端连接共用） */
interface WebSocketLike {
  accept(): void;
  send(data: Uint8Array | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  bufferedAmount: number;
  binaryType?: string;
  addEventListener(t: string, f: (ev: { data?: unknown }) => void): void;
  removeEventListener(t: string, f: (ev: { data?: unknown }) => void): void;
}
