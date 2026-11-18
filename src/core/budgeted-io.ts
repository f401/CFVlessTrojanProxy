import { connect, type Socket } from "cloudflare:sockets";
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
