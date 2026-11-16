// 冷启动质量观测（v8 §20.1）：只看每个 isolate 的**前 N 条**用户连接。
//
// 为什么不是全局成功率：低流量客户端几乎每条请求都落在新 isolate，全局成功率被「已经预热
// 过」的 isolate 稀释，看不到真正的问题。仅统计前 3 条，等于直接量「用户第一眼看到什么」。
//
// 三个口径必须分开（少了任何一个都会得出错误结论）：
// - `firstTry = down > 0`：连上了。**包括** 737B 的封锁页——那也是一次成功的连通。
// - `firstPage = down >= 4096`：拿到看起来像真页面的东西。
// - `gray`：2048–4096 之间的灰带（真实的小页面与「稍大一点的拒绝页」在这里重叠）。
// 只用 firstTry 会以为「95% 都通」，只用 firstPage 会把 `example.com`（932B）判成失败。
import { cnt } from "./counter";
import type { SampleCount } from "../core/types";

/** 每个 isolate 只统计前几条用户连接 */
export const FO_LIMIT = 3;
/** 「像是真页面」的字节下限 */
export const FO_PAGE = 4096;
/** 灰带下限（2048–4096 之间单独计数） */
export const FO_GRAY = 2048;

/** 快照结构 */
export interface FirstSnap {
  /** 统计到的连接数（最多 `FO_LIMIT`） */
  samples: SampleCount;
  /** `down > 0` 的条数 */
  first: number;
  /** `down >= FO_PAGE` 的条数 */
  page: number;
  /** 落在灰带的条数 */
  gray: number;
  /** 超过上限后跳过的条数（用来看 isolate 到底跑了多少流量） */
  skip: number;
  /** `first / n`（0 表示还没有样本） */
  firstTry: number;
  /** `page / n` */
  firstPage: number;
}

/**
 * 功能：每个 isolate 的前 N 条用户连接质量统计（只累计，不清零）。
 */
export class FirstObs {
  private samples = 0;
  private first = 0;
  private page = 0;
  private gray = 0;
  private skip = 0;

  /**
   * 功能：记一次用户连接的结束状态。
   * @param {number} down 下行字节数（0 表示一个字节都没收到）
   * @returns {void}
   */
  note(down: number): void {
    const d = Number.isFinite(down) ? Math.max(0, Math.round(down)) : 0;
    // 上限之后只计数不取样：否则「isolate 跑了 200 条」和「3 条」的快照会长得一样
    if (this.samples >= FO_LIMIT) {
      this.skip += 1;
      if (this.skip === 1) cnt("ftSkip");
      return;
    }
    this.samples += 1;
    if (d > 0) this.first += 1;
    if (d >= FO_PAGE) this.page += 1;
    else if (d >= FO_GRAY) this.gray += 1;
  }

  /**
   * 功能：当前快照（`/health` 用）。
   * @returns {FirstSnap} 计数与两个比率
   */
  snap(): FirstSnap {
    const samples = this.samples;
    return {
      samples,
      first: this.first,
      page: this.page,
      gray: this.gray,
      skip: this.skip,
      firstTry: samples ? Math.round((this.first / samples) * 1000) / 1000 : 0,
      firstPage: samples ? Math.round((this.page / samples) * 1000) / 1000 : 0,
    };
  }

  /** 功能：清空（单测用）。@returns {void} */
  clear(): void {
    this.samples = 0;
    this.first = 0;
    this.page = 0;
    this.gray = 0;
    this.skip = 0;
  }
}

/** 进程内唯一实例 */
export const FO = new FirstObs();
