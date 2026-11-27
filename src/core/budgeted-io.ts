import { connect, type Socket } from "cloudflare:sockets";
import { CONNECT_MS, withTimeout } from "./util";
import { BudgetLedger } from "./budget-ledger";

/**
 * 功能：`connect()` 与子请求 `fetch()` 的唯一出口，且每次出门先向账本取号。
 *
 * 为什么单独一个类：账本（`BudgetLedger`）只解释「还剩多少」，这里解释「怎么花钱」。
 * 全仓只有这个文件 import `cloudflare:sockets`，于是「漏写一次 take」不可能发生 ——
 * 想建连只能调 `openSocket()`，想发子请求只能调 `fetch()`。
 *
 * 为什么不用全局单例：额度的生命周期是**一次调用**（一个请求 / 一次 cron 轮）。
 * 挂在模块级就会变成跨请求状态，正是 `S.budget` 那种「类名义上拥有状态、真实状态在 S」的老毛病。
 */
export class BudgetedIO {
  /**
   * 功能：绑定一本账。
   * @param ledger 本次调用的额度账本
   */
  constructor(private readonly ledger: BudgetLedger) {}

  /**
   * 功能：开一本不设上限的门（只给单测与本地诊断用）。
   * @returns 额度无限的出口
   */
  static unlimited(): BudgetedIO {
    return new BudgetedIO(BudgetLedger.unlimited());
  }

  /**
   * 功能：取一次建连额度后建连。
   *
   * 注意：这里扣的是**发起次数**。平台限制的是「同时打开」的数量（免费计划 6 个），
   * 那由调用方保证 —— `SocketDialer` 超时后主动关掉迟到 socket，
   * 探活批按 `SC.PROBE_CONC` 切段。不要把这里当成并发闸门。
   * @param hostname 目标主机
   * @param port 目标端口
   * @returns 已建连的 socket（`connect()` 本身惰性，第一次 write 才真正握手）
   */
  async openSocket(hostname: string, port: number): Promise<Socket> {
    this.ledger.take("connect");
    return connect({ hostname, port });
  }

  /**
   * 功能：取一次子请求额度后发请求。
   * @param url 目标地址
   * @param init 请求参数（信号、头）
   * @returns 响应
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.ledger.take("sub");
    return fetch(url, init);
  }

  /**
   * 功能：读账本快照，给 `/debug?budget=1` 与单测看这一轮花了多少。
   * @returns 形态、开账时刻、已用、上限与被拒次数
   */
  snapshot(): ReturnType<BudgetLedger["snapshot"]> {
    return this.ledger.snapshot();
  }
}

/** 代理端点：host 可以是 IPv4 字面量或域名 */
export interface SocksEndpoint {
  host: string;
  port: number;
}

/** 握手阶段最多读这么多字节：再多说明对面不是 SOCKS5，别把内存交给它 */
const HANDSHAKE_MAX = 512;

/** 分片累积器：SOCKS5 的应答可能和后续目标字节挤在同一个 chunk 里 */
interface ChunkBuf {
  buf: Uint8Array;
}

/**
 * 功能：从流里读满 n 字节，多余的部分留在 `state` 里（必须还给下游，不能吞）。
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader 上游读端
 * @param {ChunkBuf} state 累积器
 * @param {number} n 需要的字节数
 * @returns {Promise<Uint8Array>} 恰好 n 字节
 */
async function readExact(reader: ReadableStreamDefaultReader<Uint8Array>, state: ChunkBuf, n: number): Promise<Uint8Array> {
  while (state.buf.length < n) {
    // 每一步都有上限：代理接了连接却不应答时，不能让客户端一直等
    const r = await withTimeout(reader.read(), CONNECT_MS);
    if (r.done) throw new Error("socks eof");
    const next = new Uint8Array(state.buf.length + r.value.length);
    next.set(state.buf, 0);
    next.set(r.value, state.buf.length);
    state.buf = next;
    if (state.buf.length > HANDSHAKE_MAX) throw new Error("socks too much");
  }
  const out = state.buf.slice(0, n);
  state.buf = state.buf.slice(n);
  return out;
}

/**
 * 功能：拼 CONNECT 请求 —— IPv4 字面量走 ATYP=1（不用代理做 DNS），域名走 ATYP=3。
 * @param {SocksEndpoint} target 目标主机与端口
 * @returns {Uint8Array} 请求字节
 */
export function socksConnectReq(target: SocksEndpoint): Uint8Array {
  // 目标是 IPv4 字面量：让代理别做 DNS（代理侧 DNS 坏了会被误判成「代理不可用」）
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(target.host);
  const port = target.port;
  if (v4) {
    // ATYP=1：VER/CMD/RSV/ATYP 之后直接跟 4 字节地址，再 2 字节大端端口
    const o = target.host.split(".").map(Number);
    return Uint8Array.from([5, 1, 0, 1, o[0], o[1], o[2], o[3], port >> 8, port & 255]);
  }
  // ATYP=3：域名长度 1 字节 + 域名本身（UTF-8），端口仍是大端 2 字节
  const h = new TextEncoder().encode(target.host);
  const out = new Uint8Array(7 + h.length);
  out.set([5, 1, 0, 3, h.length], 0);
  out.set(h, 5);
  out[5 + h.length] = port >> 8;
  out[6 + h.length] = port & 255;
  return out;
}

/**
 * 功能：把「多读到的目标字节 + 剩余上游」接成新的可读流，这样返回的 socket 与 `connect()` 同形。
 * @param {Socket} sock 已握手的原始 socket
 * @param {ChunkBuf} state 累积器（含已多读到的字节）
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader 仍持锁的读端
 * @returns {Socket} 对外可用的 socket
 */
function rewrap(sock: Socket, state: ChunkBuf, reader: ReadableStreamDefaultReader<Uint8Array>): Socket {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const out = writable.getWriter();
  // 先把多读到的目标字节补回下游，再把剩下的流原样搬过去（管道是流式的，不在这里缓冲整个响应）
  void (async () => {
    try {
      if (state.buf.length) await out.write(state.buf);
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        await out.write(r.value);
      }
      await out.close();
    } catch {
      try {
        await out.abort();
      } catch {
        /* 下游已经关了 */
      }
    }
  })();
  // 只需要「能读能写能关」这三件事：隧道只碰这些，`opened` 这类元信息用不上
  return { readable, writable: sock.writable, close: () => sock.close(), closed: sock.closed } as unknown as Socket;
}

/**
 * 功能：经 SOCKS5 代理（无认证）打开到目标的 TCP 通道 —— 与 `connect()` 的返回同形，可直接交给隧道搬运。
 *
 * 为什么需要它：CF 网络里的 proxyip 中继按 TLS SNI 转发，且只肯转发 CF 托管站点
 * （实测 www.gstatic.com / github.com 一律 `SSL alert number 40`）。公共 SOCKS5 代理是
 * 通用出口，能到任意站点，正好补上这块空缺。
 *
 * @param {BudgetedIO} gate 额度闸门（这一次 `connect()` 也占免费计划的并发名额）
 * @param {SocksEndpoint} proxy 代理地址（它的端口通常是 1080）
 * @param {SocksEndpoint} target 目标地址（域名或 IPv4 字面量）
 * @returns {Promise<Socket>} 已完成 SOCKS5 握手、可直接读写的 socket
 */
export async function socks5Open(gate: BudgetedIO, proxy: SocksEndpoint, target: SocksEndpoint): Promise<Socket> {
  const sock = await withTimeout(gate.openSocket(proxy.host, proxy.port), CONNECT_MS);
  const reader = sock.readable.getReader();
  const state: ChunkBuf = { buf: new Uint8Array(0) };
  try {
    // ① 问候：只报「无认证」一种方法；代理不接受就立刻失败，别升级成用户名密码
    const w = sock.writable.getWriter();
    await w.write(Uint8Array.from([5, 1, 0]));
    w.releaseLock();
    const greet = await readExact(reader, state, 2);
    if (greet[0] !== 5 || greet[1] !== 0) throw new Error("socks greet " + greet[1]);
    // ② CONNECT：ATYP 与端口都在 socksConnectReq 里拼好
    const w2 = sock.writable.getWriter();
    await w2.write(socksConnectReq(target));
    w2.releaseLock();
    const head = await readExact(reader, state, 4);
    if (head[0] !== 5) throw new Error("socks ver " + head[0]);
    // REP: 0 成功；其余是代理侧的拒绝（2 规则禁止 / 3 网络不可达 / 4 主机不可达 / 5 连接被拒）
    if (head[1] !== 0) throw new Error("socks rep " + head[1]);
    const atyp = head[3];
    const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : (await readExact(reader, state, 1))[0];
    await readExact(reader, state, addrLen + 2); // 绑定地址 + 绑定端口，读掉即可
    if (state.buf.length === 0) {
      reader.releaseLock();
      return sock;
    }
    // 目标已经抢先发了数据（很常见）：不能丢，包成新流交出去
    return rewrap(sock, state, reader);
  } catch (e) {
    // 握手失败的 socket 必须立刻关：免费计划全局只有 6 个并发 connect 名额
    try {
      reader.releaseLock();
    } catch {
      /* 读端已经释放 */
    }
    try {
      await sock.close();
    } catch {
      /* 已经关了 */
    }
    throw e;
  }
}
