/* 错误账本：5 秒去重 + 10 分钟直方图 + 限流丢弃计数（每个 isolate 各自一份，不写 KV）。 */
import { S } from "../core/state";

/**
 * 功能：错误账本（每个 isolate 一份）：5 秒去重表 + 10 分钟分类直方图 + 限流丢弃计数。
 *
 * 三张表各有明确分工，缺一个就对不上账：
 * - seen：msg|tag → 上次记录时间，5 秒内的重复消息直接丢弃（节点抖动时每条连接都会刷）；
 * - bucket：消息前两个词 → 本 10 分钟窗口的条数，给 /health 的 errsByKind；
 * - dup：被 5 秒限流丢掉的条数，给 /health 的 errsDup，与 50 条环相加才是真实总量。
 */
export class ErrRing {
  /** 错误日志去重表：msg|tag → 上次记录时间（5 秒窗口） */
  readonly seen = new Map<string, number>();

  /** 每类的近 10 分钟计数（每 isolate 独立；不写 KV，供 /health 观察） */
  private bucket = new Map<string, { win: number; n: number }>();

  /** 本窗口内被 5 秒限流丢掉的条数（window → 条数），让直方图与环能对账 */
  private dup = new Map<number, number>();

  /**
   * 功能：记录一次分类计数：窗口跨过 10 分钟就把该类清零，避免无限增长。
   * @param msg 错误消息
   * @returns 无
   */
  count(msg: unknown): void {
    const k = errKind(msg);
    const win = Math.floor(Date.now() / 600000);
    const cur = this.bucket.get(k);
    if (!cur || cur.win !== win) this.bucket.set(k, { win, n: 1 });
    else cur.n++;
    // 表本身有界：只保留当前窗口的键，历史窗口直接淘汰（不写 KV，不跨 isolate）
    if (this.bucket.size > 64) {
      for (const [kk, v] of this.bucket) if (v.win !== win) this.bucket.delete(kk);
      // 同一个窗口里也会超上限：分类键是「消息前两个词」，而 `tfb <站点>` 这类消息把
      // 客户端带来的站点名带了进来 —— 换个站点就多一个键。只按窗口淘汰等于没淘汰
      // （当前窗口一个都删不掉），而每写一条日志都要把整张表遍历一遍：随机站点名可以
      // 把它撑成 CPU 放大。这里再按「本窗口计数最少」淘汰一次，留下的是真正高频的那几类。
      if (this.bucket.size > 64) {
        const cold = [...this.bucket.entries()].sort((a, b) => a[1].n - b[1].n);
        for (let i = 0; i < cold.length - 64; i++) this.bucket.delete(cold[i][0]);
      }
    }
  }

  /**
   * 功能：当前 10 分钟窗口里被限流丢掉的错误条数（与环里留下的条数对账）。
   * @returns 条数
   */
  dropped(): number {
    const win = Math.floor(Date.now() / 600000);
    return this.dup.get(win) || 0;
  }

  /**
   * 功能：当前窗口的错误直方图（按消息前两个词分类，降序取前 8）。
   * @returns [{k 分类, n 次数}]
   */
  hist(): Array<{ k: string; n: number }> {
    const win = Math.floor(Date.now() / 600000);
    const out: Array<{ k: string; n: number }> = [];
    for (const [k, v] of this.bucket) if (v.win === win) out.push({ k, n: v.n });
    out.sort((a, b) => b.n - a.n);
    return out.slice(0, 8);
  }

  /**
   * 功能：记一条错误日志：先计数（限流前就计，保证账目不丢），再按「消息+tag」5 秒去重后写入 50 条环。
   * @param msg 消息（会被截断到 200 字符）
   * @param tag 关联键（一般是目标主机名）
   * @returns 无
   */
  log(msg: unknown, tag?: string | null): void {
    const m = String(msg).slice(0, 200);
    // 先计数再限流：环可能把这条丢掉，但直方图必须看到它
    try {
      this.count(m);
    } catch (e) {}
    // 同一个错误 5 秒内只记一次：节点大面积抖动时，每条连接都刷一行，
    // console.error 既费 CPU 又把真正有用的日志冲掉（面板也只留 50 条）。
    const now0 = Date.now();
    const key = tag ? m + "|" + tag : m;
    const last = this.seen.get(key) || 0;
    if (now0 - last < 5000) {
      // 被限流丢掉的那部分也要有账：否则直方图（全量）和环（被限流）两个数没法对照
      const win = Math.floor(now0 / 600000);
      this.dup.set(win, (this.dup.get(win) || 0) + 1);
      if (this.dup.size > 8) for (const k of this.dup.keys()) if (k < win - 1) this.dup.delete(k);
      return;
    }
    // 满了就按时间剪掉 5 秒前的键；以前是整体 clear()，
    // 一清表所有 host 立刻重新刷一遍，正好在最吵的时候放大日志量。
    if (this.seen.size > 200) {
      for (const [k, v] of this.seen) if (now0 - v >= 5000) this.seen.delete(k);
      if (this.seen.size > 260) {
        const keep = [...this.seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 130);
        this.seen.clear();
        for (const [k, v] of keep) this.seen.set(k, v);
      }
    }
    this.seen.set(key, now0);

    try {
      S.errs.push({ t: now0, m, tag: tag || "" });
      while (S.errs.length > 50) S.errs.shift();
    } catch (e) {}
    try {
      console.error("[err]", msg);
    } catch (e) {}
  }
}

/** 进程内单例：错误账本（每个 isolate 各自一份） */
export const ERRS = new ErrRing();

/**
 * 功能：错误分类：取消息前两个词，例如 "tfb x.com" / "forced _Rd" / "cron:"。
 * @param msg 错误消息
 * @returns 分类键（最长 40 字符；空消息返回 "?"）
 */
export function errKind(msg: unknown): string {
  return String(msg).split(/\s+/).filter(Boolean).slice(0, 2).join(" ").slice(0, 40) || "?";
}

/**
 * 功能：记录一次分类计数（薄包装，委托 ERRS.count）。
 * @param msg 错误消息
 * @returns 无
 */
export function errCount(msg: unknown): void {
  ERRS.count(msg);
}

/**
 * 功能：当前窗口的错误直方图（薄包装，委托 ERRS.hist）。
 * @returns [{k, n}] 最多 8 条，按次数降序
 */
export function errHist(): Array<{ k: string; n: number }> {
  return ERRS.hist();
}

/**
 * 功能：记一条错误日志（薄包装，委托 ERRS.log）。
 * @param msg 消息（截断到 200 字符）
 * @param tag 关联键
 * @returns 无
 */
export function logErr(msg: unknown, tag?: string | null): void {
  ERRS.log(msg, tag);
}
