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
