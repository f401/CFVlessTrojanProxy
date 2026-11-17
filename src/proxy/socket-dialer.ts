import { connect } from "cloudflare:sockets";
import type { Socket } from "cloudflare:sockets";
import { CONNECT_MS, withTimeout } from "../core/util";

/**
 * 功能：按预算建一条 TCP，超时之后把「迟到成功」的 socket 关掉。
 *
 * 为什么要有这个类：主路径（`Dialer.open`）、补救链（`fallback.ts`）、地区分流（`region.ts` 两处）、
 * 会话兜底（`session.ts`）各自写过一遍「`Promise.resolve(connect(...))` + `withTimeout` +
 * 迟到关闭」。任何一处漏掉后半段，免费计划那 6 个并发 `connect()` 名额就会被死连接慢慢吃掉 ——
 * 表现是全站零星失败，而且看不出是哪一处漏的。收敛成一处之后，这条规则只有一个实现。
 */
export class SocketDialer {
  /** 单次建连的预算（毫秒）。默认 `CONNECT_MS`，诊断路径可以给更小的值 */
  readonly budgetMs: number;

  /**
   * 功能：建一个拨号器。
   * @param budgetMs 单次建连预算，默认 `CONNECT_MS`（2500ms）
   */
  constructor(budgetMs: number = CONNECT_MS) {
    this.budgetMs = budgetMs;
  }

  /**
   * 功能：建连，超过预算即失败。
   * @param hostname 目标主机（IP 字面量或主机名）
   * @param port 目标端口
   * @returns 已连上的 socket
   * @throws 建连失败或超过 `budgetMs`
   */
  async open(hostname: string, port: number): Promise<Socket> {
    // Cloudflare 的 connect() 自身没有超时：黑洞地址会一直挂着，所以预算由这里兜
    const pending = Promise.resolve(connect({ hostname, port }));
    try {
      return await withTimeout(pending, this.budgetMs);
    } catch (error) {
      // 超时之后 connect 仍可能迟到成功：不关掉就会白占并发名额（7.86 的坑）
      void pending
        .then((socket) => {
          // 迟到的那条已经没人用了，关掉让名额立刻回到池子里
          try {
            socket.close();
          } catch {
            /* 已经被关掉了 */
          }
        })
        .catch(() => {
          /* 本来就没连上 */
        });
      throw error;
    }
  }
}

/** 进程内共用的拨号器：预算统一走 `CONNECT_MS`，要更小的预算就自己 new 一个 */
export const SOCKET_DIALER = new SocketDialer();
