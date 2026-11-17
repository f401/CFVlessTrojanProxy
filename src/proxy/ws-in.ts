import { toU8 } from "../core/util";

/**
 * 功能：单条连接上行队列的上限（字节）。
 *
 * 为什么需要：客户端把上行当无底洞往里写、而目标侧吞吐跟不上时，`enqueue` 的积压全在
 * isolate 内存里。免费计划的内存是硬上限，一旦撑爆就是整条连接被平台掐断，连日志都留不下来。
 * 8 MB 足够覆盖「首包 + 一个 MTU 级的突发」，再多说明上游确实卡住了。
 */
export const WS_UP_QUEUE_MAX = 8 * 1024 * 1024;

/**
 * 功能：客户端 WS 的最小接口。
 *
 * 为什么单独定义：本模块只在 Worker 侧被用（`session.ts`），而测试要拿一个能记账的假 WS，
 * 所以只声明真正用到的两个成员，不依赖 `cloudflare:workers` 的完整类型。
 */
export interface WebSocketLike {
  /** 注册事件监听（`message` / `close` / `error`）。 */
  addEventListener(type: "message" | "close" | "error", fn: (ev: unknown) => void): void;
  /** 关连接（超限时用 1013 表示「稍后再试」）。 */
  close(code?: number, reason?: string): void;
}

/**
 * 功能：一条连接的上行字节流（客户端 → 上游）。
 *
 * 为什么成类：这条流有自己独占的可变状态 —— 已入队未读走的字节数、流是否还活着、
 * 以及那个只能被控制器读写的 `controller`。三者必须在同一次连接内保持一致：
 * 超限时既要让读端报错、又要关掉 WS，关闭时只能 `close()` 一次，错误来了不能再 `enqueue`。
 * 写成一条函数时这些状态散在四个闭包里，测不了也读不出「谁负责收尾」。
 */
export class UploadStream {
  /** 已入队但还没被读端取走的字节数（`pipeThrough` 里按块大小扣减）。 */
  private queued = 0;

  /** 流是否还活着；置假之后不再入队，也不再重复收尾。 */
  private live = true;

  /** 读端控制器，由 `start` 回调注入（构造期一定先于任何事件到达）。 */
  private ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;

  /** 对外暴露的只读字节流（同时做背压计数的旁路变换）。 */
  readonly stream: ReadableStream<Uint8Array>;

  /**
   * 功能：建流并立刻开始收 WS 数据。
   * @param ws 客户端 WS（只用到 `addEventListener` 与 `close`）
   * @param earlyData WS 握手时带上的早期数据（base64，可空）
   */
  constructor(
    private readonly clientSocket: WebSocketLike,
    private readonly earlyData: string,
  ) {
    // 先建源流：`start` 同步执行，控制器在这里注入，所以构造结束前就能安全收包
    const src = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.ctrl = c;
        this.bind();
        this.feedEarly();
      },
      // 读端主动取消说明上游不想要了：停止收包，避免继续往一个没人读的流里堆内存
      cancel: () => {
        this.live = false;
      },
    });
    // 背压旁路：每块被读走就扣掉它的大小，`queued` 才是「真实积压」而不是「累计写入」
    this.stream = src.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, c) => {
          this.queued = Math.max(0, this.queued - chunk.length);
          c.enqueue(chunk);
        },
      }),
    );
  }

  /**
   * 功能：挂上 WS 的三个事件（`message` / `close` / `error`）。
   * @returns 无
   */
  private bind(): void {
    // 消息统一走 `push`：那里做超限判定与入队，顺序与收包顺序一致
    this.clientSocket.addEventListener("message", (ev) => {
      this.push((ev as { data?: unknown }).data);
    });
    // 正常关闭：让读端看到 EOF，上游据此收尾
    this.clientSocket.addEventListener("close", () => {
      this.shut();
    });
    // 异常关闭：把错误透给读端，否则上游会一直等一个永远不会来的块
    this.clientSocket.addEventListener("error", (ev) => {
      this.abort((ev as { error?: unknown }).error ?? new Error("ws error"));
    });
  }

  /**
   * 功能：收一块客户端数据：解码、计入积压、超限就收尾，否则入队。
   * @param d WS 消息数据（base64 文本、ArrayBuffer 或字节数组）
   * @returns 无
   */
  private push(d: unknown): void {
    if (!this.live) return;
    const u8 = this.decode(d);
    this.queued += u8.length;
    // 超限优先于入队：先关连接再报错，避免又有一次 enqueue 落到同一块内存上
    if (this.queued > WS_UP_QUEUE_MAX) {
      this.overflow();
      return;
    }
    // 读端已经取消时 `enqueue` 会抛，抛了就当流结束，不再重试
    if (!this.emit(u8)) this.live = false;
  }

  /**
   * 功能：把一块字节交给读端。
   * @param u8 字节
   * @returns 是否成功入队（失败通常意味着读端已取消）
   */
  private emit(u8: Uint8Array): boolean {
    const c = this.ctrl;
    if (!c) return false;
    try {
      c.enqueue(u8);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 功能：排队超限时的收尾：关 WS（1013）并让读端报错。
   * @returns 无
   */
  private overflow(): void {
    this.live = false;
    const c = this.ctrl;
    if (c) {
      try {
        c.error(new Error("upload queue overflow"));
      } catch {
        // 已经被关掉了：错误已经送到读端，这里只是防止二次抛
      }
    }
    try {
      this.clientSocket.close(1013, "slow upstream");
    } catch {
      // 对端已经断开：没有可关闭的连接
    }
  }

  /**
   * 功能：客户端正常关闭时的收尾：让读端看到 EOF。
   * @returns 无
   */
  private shut(): void {
    if (!this.live) return;
    this.live = false;
    const c = this.ctrl;
    if (!c) return;
    try {
      c.close();
    } catch {
      // 已经关过或被取消：重复 close 会抛，忽略
    }
  }

  /**
   * 功能：客户端异常时的收尾：把错误透给读端。
   * @param e 错误对象
   * @returns 无
   */
  private abort(e: unknown): void {
    if (!this.live) return;
    this.live = false;
    const c = this.ctrl;
    if (!c) return;
    try {
      c.error(e);
    } catch {
      // 读端已取消：错误无处可送
    }
  }

  /**
   * 功能：把 WS 握手带上的早期数据先灌进流。
   *
   * 为什么需要：VLESS/Trojan 的客户端会在 upgrade 请求里就把首包塞进来（`Sec-WebSocket-Protocol`），
   * 这些字节不属于任何 `message` 事件；早于目标连上就写进去，等于把首包提前交给上游。
   * @returns 无
   */
  private feedEarly(): void {
    if (!this.earlyData) return;
    try {
      this.push(atob(this.earlyData));
    } catch {
      // 早期数据不是合法 base64：丢掉，让客户端在正式帧里重发（协议层会判首帧）
    }
  }

  /**
   * 功能：把 WS 消息数据统一成字节。
   * @param d 消息数据
   * @returns 字节数组
   */
  private decode(d: unknown): Uint8Array {
    // ws2 每帧是 1 字节类型 + base64 文本；ArrayBuffer 是二进制帧；字符串按 UTF-8
    if (typeof d === "string") {
      if (d.length > 0 && d.charCodeAt(0) === 2) return toU8(atob(d.slice(1)));
      return toU8(new TextEncoder().encode(d));
    }
    return toU8(d);
  }
}

/**
 * 功能：把客户端 WebSocket 转成只读字节流。
 *
 * 保留函数入口是为了让调用方（`session.ts`）不必关心这是一个对象：流本身就是全部接口，
 * 连接的收尾全在 `UploadStream` 内部完成。
 * @param ws 客户端 WS
 * @param earlyData WS 握手时带上的早期数据（base64，可空）
 * @returns 上行字节流
 */
export function wsToStream(ws: WebSocketLike, earlyData: string): ReadableStream<Uint8Array> {
  return new UploadStream(ws, earlyData).stream;
}
