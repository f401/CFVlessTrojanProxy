/**
 * 功能：免费计划三条额度的账本 —— 只记账，不做任何 I/O。
 *
 * 为什么把账本和 I/O 分开：`BudgetedIO`（7.362 起）把 `connect()` 与 `fetch()` 揉进了额度对象，
 * 于是这个对象既解释「还剩多少」又解释「怎么拨号」，谁改拨号都要动账本。这里只管
 * caps / used / refused / snapshot，真正花钱的地方在 `src/core/budgeted-io.ts`。
 *
 * 口径：**计数是「本次调用里发起过几次」**，不是「同时开着几个」—— 同时开着几个由
 * `SocketDialer` 的超时关闭与 `SC.PROBE_CONC` 切段保证（免费计划 ≤6 个并发 `connect()`）。
 */

/** 花的是哪一类额度：建连 / 子请求 / 对计量 DO 的往返。 */
export type BudgetKind = "connect" | "sub" | "do";

/** 三个类别的固定顺序，遍历时用（不写对象字面量的键名，`do` 这种两字符键会撞命名门禁）。 */
export const BUDGET_KINDS: readonly BudgetKind[] = ["connect", "sub", "do"];

/** 一次调用（一个请求，或一次 cron 轮）适用的上限形态。 */
export type BudgetProfile = "request" | "cron";

/**
 * 各形态的上限：请求按「一次浏览」估（4 条腿 + 6 次子请求 + 2 次 DO），
 * cron 轮按「一轮能刷完一批候选」估（40 次建连 + 48 次子请求，仍低于平台 50 的硬上限）。
 */
export const BUDGET_CAPS: Record<BudgetProfile, Record<BudgetKind, number>> = {
  request: { connect: 4, sub: 6, do: 2 },
  cron: { connect: 40, sub: 48, do: 6 },
};

/**
 * 功能：额度用尽。
 *
 * 为什么要独立类型：调用方普遍把「建连失败」当成「这条腿坏了」去换下一条 —— 额度用尽
 * 不是坏腿，继续换只会把剩下的候选全试一遍、还把错误记到节点账上。所以这个错误必须能被
 * 认出来并**立刻中止**重试链（7.362 就吃过这个亏：它被 `catch (e)` 当成网络错吞掉了）。
 */
export class BudgetExhausted extends Error {
  /**
   * 功能：记住是哪一类额度用尽。
   * @param kind 用尽的那一类
   */
  constructor(readonly kind: BudgetKind) {
    super("budget exhausted: " + kind);
    this.name = "BudgetExhausted";
  }
}

/**
 * 功能：判断一个错误是不是「额度用尽」。
 *
 * 为什么要单独给一个判断：拨号与探活的 catch 普遍要「换下一条候选」，而额度用尽时
 * 继续换只会把剩下的候选全试一遍并把错记到节点账上；有了这个判断，那些 catch 能一眼
 * 认出「这不是坏腿」并原样抛上去。
 * @param err 捕获到的错误
 * @returns 是额度用尽返回 true
 */
export function isBudgetExhausted(err: unknown): err is BudgetExhausted {
  return err instanceof BudgetExhausted;
}

/**
 * 功能：一次调用的额度账本：上限、已用、被拒次数与快照。
 *
 * 用法：请求入口 `new BudgetLedger("request")`，cron 入口 `new BudgetLedger("cron")`，
 * 随参数传给需要花钱的地方；本对象不持有任何跨请求状态，也不认识 `S`。
 */
export class BudgetLedger {
  /** 已用次数（按类别）。 */
  private readonly usedCount: Record<BudgetKind, number>;
  /** 被拒次数（按类别）—— 这是「额度是否真的成为瓶颈」的唯一证据。 */
  private readonly refusedCount: Record<BudgetKind, number>;
  /** 上限（构造时按形态取，可按类别覆盖）。 */
  private readonly caps: Record<BudgetKind, number>;
  /** 开账时刻，只用于快照里说明这批账是哪一次调用记的。 */
  readonly openedAt: number;
  /** 形态：请求还是 cron 轮。 */
  readonly profile: BudgetProfile;

  /**
   * 功能：开一本账。
   * @param profileName 形态（决定默认上限）
   * @param caps 逐类覆盖上限，省略则用 `BUDGET_CAPS[profileName]`
   */
  constructor(readonly profileName: BudgetProfile = "request", caps?: Partial<Record<BudgetKind, number>>) {
    this.profile = profileName;
    this.caps = { ...BUDGET_CAPS[profileName] };
    // 逐类覆盖：用循环而不是逐个手写键，`do` 这种两字符键名写进对象字面量会撞命名门禁
    if (caps) {
      for (const kind of BUDGET_KINDS) {
        const want = caps[kind];
        if (want !== undefined) this.caps[kind] = want;
      }
    }
    this.usedCount = { connect: 0, sub: 0, do: 0 };
    this.refusedCount = { connect: 0, sub: 0, do: 0 };
    this.openedAt = Date.now();
  }

  /**
   * 功能：开一本不设上限的账 —— 只给单测与本地诊断用。
   * @returns 上限为 `Number.MAX_SAFE_INTEGER` 的账本
   */
  static unlimited(): BudgetLedger {
    return new BudgetLedger("request", {
      connect: Number.MAX_SAFE_INTEGER,
      sub: Number.MAX_SAFE_INTEGER,
      do: Number.MAX_SAFE_INTEGER,
    });
  }

  /**
   * 功能：取 n 次额度，不够就记账并抛 `BudgetExhausted`。
   * @param kind 类别
   * @param count 次数，默认 1
   * @returns 无（不足时抛错）
   */
  take(kind: BudgetKind, count = 1): void {
    if (!this.tryTake(kind, count)) throw new BudgetExhausted(kind);
  }

  /**
   * 功能：尝试取 count 次额度，不够返回 false（不抛错）。
   * @param kind 类别
   * @param count 次数，默认 1
   * @returns 取到了为 true；不足时 `refused[kind]` 加一并返回 false
   */
  tryTake(kind: BudgetKind, count = 1): boolean {
    if (this.left(kind) < count) {
      this.refusedCount[kind] += 1;
      return false;
    }
    this.usedCount[kind] += count;
    return true;
  }

  /**
   * 功能：批量申请（常用于「这一批要探 n 个」）：能给多少给多少。
   * @param kind 类别
   * @param want 想申请的次数
   * @returns 实际批准的次数（可能为 0）
   */
  grant(kind: BudgetKind, want: number): number {
    const got = Math.max(0, Math.min(want, this.left(kind)));
    if (got < want) this.refusedCount[kind] += 1;
    this.usedCount[kind] += got;
    return got;
  }

  /**
   * 功能：还剩多少。
   * @param kind 类别
   * @returns 剩余次数（不会小于 0）
   */
  left(kind: BudgetKind): number {
    return Math.max(0, this.caps[kind] - this.usedCount[kind]);
  }

  /**
   * 功能：这一类上限是多少。
   * @param kind 类别
   * @returns 上限
   */
  cap(kind: BudgetKind): number {
    return this.caps[kind];
  }

  /**
   * 功能：快照，给 `/debug?budget=1` 与单测读。
   * @returns 形态、开账时刻、已用、上限与被拒次数（都是浅拷贝）
   */
  snapshot(): {
    profile: BudgetProfile;
    openedAt: number;
    used: Record<BudgetKind, number>;
    caps: Record<BudgetKind, number>;
    refused: Record<BudgetKind, number>;
  } {
    // 三个计数字典都做浅拷贝：调用方拿到后随手改一改，不该影响账本自己的数
    return {
      profile: this.profile,
      openedAt: this.openedAt,
      used: { ...this.usedCount },
      caps: { ...this.caps },
      refused: { ...this.refusedCount },
    };
  }
}
