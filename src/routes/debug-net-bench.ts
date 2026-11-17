import { errMsg } from "../core/util";
import { json } from "../edge/respond";

/**
 * 出口测速：Worker 自己到源站有多快（只花一次子请求，不占 `connect()` 名额）。
 */
export class DebugBench {
  /**
   * 出口测速：Worker 自己到源站有多快。
   * @param url 请求 URL（`?bench=<url>&bytes=<n>`）
   * @returns 命中时返回测速结果，否则 `null`
   */
  async bench(url: URL): Promise<Response | null> {
    const benchUrl = String(url.searchParams.get("bench") || "").slice(0, 300);
    if (!benchUrl) return null;
    // 夹在 64KB 与 32MB 之间：太小测不出吞吐，太大会把这次调用拖到超时
    const cap = Math.max(
      64 * 1024,
      Math.min(32 * 1024 * 1024, Number(url.searchParams.get("bytes") || 4_000_000) || 4_000_000),
    );
    const t0 = Date.now();
    let got = 0;
    let first = 0;
    let status = 0;
    let err = "";
    let aborted = false;
    const ac = new AbortController();
    // 源站很慢时不能把这次调用拖死：20 秒后中止，已读到的字节照样报出来
    const timer = setTimeout(() => {
      aborted = true;
      ac.abort();
    }, 20000);
    try {
      const r = await fetch(benchUrl, { signal: ac.signal });
      status = r.status;
      if (r.body) {
        const rd = r.body.getReader();
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          if (value && value.length) {
            got += value.length;
            if (!first) first = Date.now();
            if (got >= cap) break;
          }
        }
        try {
          rd.cancel();
        } catch (e) {
          // 取消失败无所谓：连接本来就要丢
        }
      }
    } catch (e) {
      err = errMsg(e).slice(0, 80);
    }
    clearTimeout(timer);
    // 用「从发起到读完」的总时长算速率：cf 里同网源站会把整段 body 一次性缓冲好，
    // 只按「首字节到末字节」算会得到 3.9 GB/s 这种假数字。ttfb 单独报。
    const total = Math.max(1, Date.now() - t0);
    return json({
      bench: benchUrl,
      status,
      kb: Math.round(got / 1024),
      ms: total,
      kbs: Math.round(got / 1024 / (total / 1000)),
      ttfb: first ? first - t0 : 0,
      aborted,
      err,
    });
  }
}

/** DebugBench 的单例（无状态，可安全共享） */
export const BENCH = new DebugBench();
