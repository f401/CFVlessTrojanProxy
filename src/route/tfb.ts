import type { RouteCtx } from "../edge/types";
import { S } from "../core/state";
import { withTimeout } from "../core/util";
import { vSet } from "./verdict";

/** 兜底中继：本 isolate 还没跑过 cron 时 S.alive 为空，用几个已知可用的顶一下。 */
const SEED = ["185.253.117.147", "45.136.117.194", "91.215.154.80"];

/** IP 级封锁探测：探 1–3 条中继，把结果写进判定表。
 *  判据：某条中继回 403 而另一条回 200 → 该通道被封（chan）；全部 403 → 站点/出口层可疑，只当旁证。 */
export async function runTfb(c: RouteCtx, host: string, n: number, list = ""): Promise<Response> {
  const own = [...S.alive.values()].map((x) => x.h);
  const ips = (list ? list.split(",") : own.length ? own : SEED)
    .map((x) => x.trim().split(":")[0])
    .filter((h, i, arr) => h && arr.indexOf(h) === i)
    .slice(0, Math.max(1, Math.min(3, n)));
  const q =
    "https://meter/tfb?h=" + encodeURIComponent(host) + "&r=" + encodeURIComponent(ips.map((x) => x + ":443").join(","));
  const stub = c.env.METER.get(c.env.METER.idFromName("tf-probe"));
  const r = (await withTimeout(stub.fetch(q), 20000)) as Response | undefined;
  const body = r
    ? ((await withTimeout(r.json(), 5000)) as { rows?: Array<{ relay: string; ok: boolean; status?: number; ms?: number }> })
    : { rows: [] };
  const rows = body.rows || [];
  for (const row of rows) vSet(host, "r:" + row.relay.split(":")[0], Number(row.status || 0), Number(row.ms || 0), 1);
  const okN = rows.filter((x) => x.ok && x.status === 200).length;
  const badN = rows.filter((x) => x.status === 403).length;
  return Response.json({
    host,
    probed: rows.length,
    okN,
    badN,
    verdict: okN > 0 && badN > 0 ? "chan" : badN >= 2 ? "suspect" : okN > 0 ? "ok" : "unknown",
    rows,
  });
}
