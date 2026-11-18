// 一次调用的「额度闸门」：既是账本，也是 connect 与子请求这两个出口本身。
//
// 为什么把出口做成方法（7.362 用户要求）：额度如果只是账本，就得靠十来个拨号点各自记得
// 先 take 再 connect —— 漏一处就静默失效，而「谁吃掉了免费计划的 6 个 connect」只能人工清点。
// 现在调用方拿到的对象自己就能拨号、自己就能取 URL：不经过它就没有连接、也没有子请求，
// 于是「忘了记账」这种错误在类型层面就不存在了。
//
// 为什么不是全局单例：额度是随调用传下去的普通值对象（请求一份、cron 轮一份），
// 同一 isolate 里两个请求交错时不会互相偷额度。
//
// 计数口径是**发起次数**而不是同时打开数：同时打开数由 `SocketDialer` 的超时关闭与
// `SC.PROBE_CONC` 切段保证（各有单测）；这里回答的是「这次调用还允不允许再发起一次
// connect / 再花一次子请求」。超额抛 `BudgetExhausted`，让现有拨号失败路径自然接住。
import { connect } from "cloudflare:sockets";
import type { Socket } from "cloudflare:sockets";
import type { EpochMs } from "./types";

/** 三份额度 */
type BudgetKind = "connect" | "sub" | "do";

/** 调用的两种形态：一个用户请求 / 一轮 cron（后者要扫池子，connect 与子请求都更多） */
type BudgetProfile = "request" | "cron";

/** 各形态的上限（次数，不是并发数） */
const BUDGET_CAPS: Record<BudgetProfile, Record<BudgetKind, number>> = {
  // 请求：主路径 1 + 补救 1 + 兜底 2；子请求留给 DoH（最多 3 个解析服务）、CF 判定、探活回填。
  request: { connect: 4, sub: 6, do: 2 },
  // cron：一轮要扫池子 + 起搏 + 判定批，子请求上限与 `plan.sub` 同源（48）
  cron: { connect: 40, sub: 48, do: 6 },
};

/** 额度用完时抛的错：调用方按「这条腿拨不动了」处理，不要当成逻辑错误，也不要重试 */
export class BudgetExhausted extends Error {
  /**
   * @param {BudgetKind} kind 用尽的额度种类
   */
  constructor(readonly kind: BudgetKind) {
    super("budget exhausted: " + kind);
    this.name = "BudgetExhausted";
  }
}

/**
 * 功能：一次调用的额度闸门 —— 记账、建连、取子请求都在这里。
 *
 * `openSocket()` 与 `fetch()` 是**唯一**两个花额度的出口：生产路径只要拿到这个对象，
 * 就不可能绕过记账去 connect 或 fetch。
 */
export class CallGate {
  private readonly caps: Record<BudgetKind, number>;
  private readonly used: Record<BudgetKind, number> = { connect: 0, sub: 0, do: 0 };
  private readonly refused: Record<BudgetKind, number> = { connect: 0, sub: 0, do: 0 };
  private readonly openedAt: EpochMs = Date.now();

  /**
   * @param {BudgetProfile} profile 形态（决定三份额度上限）
   */
  constructor(readonly profile: BudgetProfile = "request") {
    this.caps = { ...BUDGET_CAPS[profile] };
  }

  /**
   * 功能：不限额的闸门 —— **只给单测与本地诊断用**；生产路径必须显式传一份真额度。
   * @returns {CallGate} 上限为 `Number.MAX_SAFE_INTEGER` 的实例
   */
  static unlimited(): CallGate {
    const gate = new CallGate("cron");
    gate.caps.connect = Number.MAX_SAFE_INTEGER;
    gate.caps.sub = Number.MAX_SAFE_INTEGER;
    gate.caps.do = Number.MAX_SAFE_INTEGER;
    return gate;
  }

  /**
   * 功能：扣一次额度；不够就抛 `BudgetExhausted`。
   * @param {BudgetKind} kind 额度种类
   * @param {number} n 次数，默认 1
   * @returns {void}
   * @throws {BudgetExhausted} 额度不足
   */
  take(kind: BudgetKind, n = 1): void {
    if (this.used[kind] + n > this.caps[kind]) {
      this.refused[kind] += 1;
      throw new BudgetExhausted(kind);
    }
    this.used[kind] += n;
  }

  /**
   * 功能：申请但不想抛错时用（「还有余量就顺手做」的可选动作）。
   * @param {BudgetKind} kind 额度种类
   * @param {number} n 次数，默认 1
   * @returns {boolean} 批准为 true
   */
  tryTake(kind: BudgetKind, n = 1): boolean {
    if (this.used[kind] + n > this.caps[kind]) {
      this.refused[kind] += 1;
      return false;
    }
    this.used[kind] += n;
    return true;
  }

  /**
   * 功能：批量场景「这次实际能给几个」—— 批准多少扣多少（用于探活切段）。
   * @param {BudgetKind} kind 额度种类
   * @param {number} want 想要的次数
   * @returns {number} 批准的次数（0 表示一个都不给）
   */
  grant(kind: BudgetKind, want: number): number {
    const give = Math.min(Math.max(0, want), this.left(kind));
    if (give < want) this.refused[kind] += 1;
    this.used[kind] += give;
    return give;
  }

  /**
   * 功能：建连的唯一出口 —— 先扣 connect 额度，再真正调用 `connect()`。
   *
   * 为什么必须经这里：`connect()` 自身没有超时，挂死会占住免费计划全局 6 个名额之一；
   * 额度不够时应当在「还没发起」就失败，而不是让调用方自己判断后决定要不要拨。
   * @param {string} hostname 目标主机（域名或 IP 字面量）
   * @param {number} port 目标端口
   * @returns {Promise<Socket>} 连上的 socket
   * @throws {BudgetExhausted} connect 额度不足
   */
  async openSocket(hostname: string, port: number): Promise<Socket> {
    this.take("connect");
    return connect({ hostname, port });
  }

  /**
   * 功能：子请求的唯一出口 —— 先扣 sub 额度，再 `fetch`。
   * @param {string} url 目标 URL
   * @param {RequestInit} init 可选的请求选项
   * @returns {Promise<Response>} 响应
   * @throws {BudgetExhausted} 子请求额度不足
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.take("sub");
    return fetch(url, init);
  }

  /**
   * @param {BudgetKind} kind 额度种类
   * @returns {number} 还剩多少次（不会为负）
   */
  left(kind: BudgetKind): number {
    return Math.max(0, this.caps[kind] - this.used[kind]);
  }

  /**
   * @param {BudgetKind} kind 额度种类
   * @returns {number} 上限
   */
  cap(kind: BudgetKind): number {
    return this.caps[kind];
  }

  /**
   * 功能：账目快照（`/health` 的预算分区与单测用）。
   * @returns {{ profile: BudgetProfile; openedAt: EpochMs; used: Record<BudgetKind, number>; caps: Record<BudgetKind, number>; refused: Record<BudgetKind, number> }} 快照
   */
  snapshot(): {
    profile: BudgetProfile;
    openedAt: EpochMs;
    used: Record<BudgetKind, number>;
    caps: Record<BudgetKind, number>;
    refused: Record<BudgetKind, number>;
  } {
    // 三个计数字典都做浅拷贝：调用方拿到后随手改一改不该影响闸门自己的账
    return {
      profile: this.profile,
      openedAt: this.openedAt,
      used: { ...this.used },
      caps: { ...this.caps },
      refused: { ...this.refused },
    };
  }
}
