import { toU8 } from "../core/util";

/**
 * 客户端 → 上游的字节流。
 *
 * WS 的 message 事件不会等下游：上游 socket 写得慢时，消息仍然一条条推进
 * ReadableStream 的队列。没有上限的话，一个客户端可以在几秒内把几百 MB
 * 塞进 isolate 内存（Workers 上限 128MB），表现为 1102 / OOM。
 *
 * 这里用 8MB 的软上限：超过就 1013 关闭并让流报错，由上层统一收尾。
 * 计数在 TransformStream 里扣减 —— 只有真正被下游读走的字节才释放额度。
 */
export const WS_UP_QUEUE_MAX = 8 * 1024 * 1024;

export function wsToStream(ws: WebSocketLike, earlyData: string): ReadableStream<Uint8Array> {
  // 流被取消（pipeTo 提前结束）后 WS 仍可能在推消息：
  // 继续 enqueue 会抛 "The stream is not in a state that permits enqueue"，
  // 而这个异常发生在事件回调里，没人接得住 —— 用一个闩把后续消息直接丢掉。
  let live = true;
  let queued = 0;
  const src = new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>) {
      const push = (d: unknown) => {
        if (!live) return;
        const u8 = toU8(d);
        queued += u8.length;
        if (queued > WS_UP_QUEUE_MAX) {
          live = false;
          try {
            controller.error(new Error("upload queue overflow"));
          } catch (e) {}
          try {
            ws.close(1013, "slow upstream");
          } catch (e) {}
          return;
        }
        try {
          controller.enqueue(u8);
        } catch (e) {
          live = false;
        }
      };
      ws.addEventListener("message", (ev) => push(ev.data));
      ws.addEventListener("close", () => {
        live = false;
        try {
          controller.close();
        } catch (e) {}
      });
      ws.addEventListener("error", (e) => {
        live = false;
        try {
          controller.error(e);
        } catch (err) {}
      });
      if (earlyData) {
        try {
          const b64 = earlyData.replace(/-/g, "+").replace(/_/g, "/");
          const raw = atob(b64);
          const buf = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
          push(buf);
        } catch (e) {
          /* 早期数据非法，忽略 */
        }
      }
    },
    cancel() {
      live = false;
    },
  });
  // 下游读走一块 → 释放一块额度；上游慢时队列才会真的涨到 8MB
  return src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        queued = Math.max(0, queued - chunk.length);
        controller.enqueue(chunk);
      },
    }),
  );
}
