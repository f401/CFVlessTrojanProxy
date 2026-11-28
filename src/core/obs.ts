import { NODE_MEMORY } from "./node-memory";
import { cnt } from "./counter";
import type { SampleCount } from "../core/types";
import { pcts } from "./hist";

// ---- 并入自 src\core\firstobs.ts ----
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

// ---- 并入自 src\core\latobs.ts ----
// 延迟观测：把「成功率上去了但变慢了」这件事变成可读的数字。
//
// 为什么需要单独一个：只看成功率会有选择偏倚 —— 失败页往往只要几十毫秒，
// 成功率一高，慢样本占比就变大，整体 p95 会「因为变好而变慢」。所以必须同时有：
//   - `p95all`：全部连接的 p95（含失败页，反映用户体感的上限）
//   - `p95ok` ：只算拿到内容的连接（判断「真正的页面」变慢没有）
//   - `good3s`：既成功又 ≤3 秒的比例（唯一能直接对用户承诺的口径）
//
// 只保留当前 10 分钟窗口、最多 256 个样本：这些数字是给人看的诊断量，
// 不是选路依据，没必要为了精度吃掉 isolate 内存，也不需要跨 isolate 共享。

/** 一个样本：是否拿到内容 + 整条连接耗时 */
interface LatSample {
  ok: boolean;
  ms: number;
}

/** 窗口长度：10 分钟；跨窗后从头累积 */
const WIN = 600_000;
/** 样本上限：256 条（p95 在 256 条上已经足够稳） */
const MAX = 256;

/**
 * 功能：三类延迟指标的窗口统计器。
 * @returns {LatObs} 进程内单例由 `LAT` 提供
 */
export class LatObs {
  private rows: LatSample[] = [];
  private win = 0;
  private skip = 0;

  /**
   * 功能：记录一条已结束的连接。
   * @param ok 是否拿到内容（完整响应，不是「2xx」）
   * @param ms 整条连接耗时（毫秒）
   * @returns {void}
   */
  note(ok: boolean, ms: number): void {
    if (!(ms >= 0)) return;
    const w = Math.floor(Date.now() / WIN);
    if (w !== this.win) {
      this.win = w;
      this.rows = [];
      this.skip = 0;
    }
    if (this.rows.length >= MAX) {
      // 满了就只计数不再采样：否则窗口后半段全是慢请求，p95 会随流量升高而漂移
      this.skip += 1;
      return;
    }
    this.rows.push({ ok, ms });
  }

  /**
   * 功能：取当前窗口的三类指标。
   * @returns {{ n: number, skip: number, p50: number, p95all: number, p95ok: number, good3s: number }} 指标快照
   */
  snap(): { n: number; skip: number; p50: number; p95all: number; p95ok: number; good3s: number } {
    const n = this.rows.length;
    if (!n) return { n: 0, skip: this.skip, p50: 0, p95all: 0, p95ok: 0, good3s: 0 };
    const all = this.rows.map((r) => r.ms).sort((a, b) => a - b);
    const ok = this.rows
      .filter((r) => r.ok)
      .map((r) => r.ms)
      .sort((a, b) => a - b);
    const at = (arr: number[], q: number): number => (arr.length ? (arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] as number) : 0);
    const good = this.rows.filter((r) => r.ok && r.ms <= 3000).length;
    return {
      n,
      skip: this.skip,
      p50: at(all, 0.5),
      p95all: at(all, 0.95),
      p95ok: at(ok, 0.95),
      good3s: Math.round((good / n) * 1000) / 1000,
    };
  }

  /** 功能：清空（测试与调试端点用） @returns {void} */
  clear(): void {
    this.rows = [];
    this.win = 0;
    this.skip = 0;
  }
}

/** 进程内唯一的延迟窗口 */
export const LAT = new LatObs();

// ---- 并入自 src\core\node-snapshot.ts ----
/** 每个节点的紧凑快照（供 Meter DO 跨 isolate 展示） */
export function spdSnapshot() {
  const out: Record<string, NodeSnap> = {};
  // 按累计下行挑前 16 个：真正在跑的大流量节点经常不在 Map 的前 16 位
  const rows = [...NODE_MEMORY.stats.entries()]
    .filter(([k, s]) => NODE_MEMORY.alive.has(k) && ((s.trafficOkW || 0) + (s.trafficFailW || 0) > 0 || (s.bytesDown || 0) > 0))
    .sort((a, b) => (b[1].bytesDown || 0) - (a[1].bytesDown || 0))
    .slice(0, 16);
  for (const [k, s] of rows) {
    const n = (s.trafficOkW || 0) + (s.trafficFailW || 0);
    const q = pcts(s);
    out[k] = {
      med: Math.round(q.p50 || 0),
      p90: Math.round(q.p90 || 0),
      cap: Math.round(q.cap || 0),
      n: Math.round(n),
      ts: Math.round(s.trafficOkW || 0),
      tf: Math.round(s.trafficFailW || 0),
      at: s.at || 0,
    };
  }
  return out;
}

// ---- 门面（对外导出面保持不变） ----
// 观测汇总：首字节 / 页面大小分类、真实连接延迟分布、节点速度快照。
//
// 这三块都是「本 isolate 攒下来的观测样本」：`FirstObs` 记入口首字节与页面大小分类，
// `LatObs` 记真实连接（不是探活）的延迟分布，`spdSnapshot()` 把节点速度表摊成快照
// 交给面板与上报。它们共用 5 分钟窗口与「只统计真实连接」这条纪律，所以住在一个文件里。
//
// 纪律（违反任意一条都会让面板数字撒谎）：
// 1) 探活 RTT 不进这里 —— 探活是 ClientHello→ServerHello（40ms 量级），真实首字节含 TLS
//    握手（400ms 量级）；混进来会让 CUSUM 把刚扫出来的中继冻 60 秒（7.185 修过三次）。
// 2) 窗口只往前推，不因样本少回退。
// 3) `clear()` 只清本观察器，不动其他领域所有者。
