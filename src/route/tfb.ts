import type { RouteCtx } from "../edge/types";
import { S } from "../core/state";
import { withTimeout } from "../core/util";
import { vSet, vSetState } from "./verdict";

/** 兜底中继：本 isolate 还没跑过 cron 时 S.alive 为空，用几个已知可用的顶一下。 */
const SEED = ["185.253.117.147", "45.136.117.194", "91.215.154.80"];

const stub0 = (c: RouteCtx) => c.env.METER.get(c.env.METER.idFromName("tf-probe"));

/** IP 级封锁探测：探 1–3 条中继，按 consensus 写判定表。
 *  · 全部 200        → ok（站点可达）
 *  · 200 与 403 并存 → 403 的那些通道判被封（这才是「IP 级」证据）
 *  · 全部 403        → 站点层面的拒绝（业务 403 常见形态），**不写任何封禁**，只记 suspect
 *  · 全部失败        → unknown（中继或网络问题，不冤枉任何一方）
 */
/** 判定收敛：200 与 403 并存才升级为 IP 级封锁证据；全 403 说明是站点级，不写封禁。 */
export function tfVerdict(rows: Array<{ ok: boolean; status?: number }>): "ok" | "chan" | "site" | "unknown" {
  const okN = rows.filter((x) => x.ok && x.status === 200).length;
  const badN = rows.filter((x) => (x.status || 0) >= 400).length;
  return okN > 0 && badN > 0 ? "chan" : okN > 0 ? "ok" : badN > 0 ? "site" : "unknown";
}

export async function runTfb(c: RouteCtx, host: string, n: number, list = ""): Promise<Response> {
  const own = [...S.alive.values()].map((x) => x.h);
  const ips = (list ? list.split(",") : own.length ? own : SEED)
    .map((x) => x.trim().split(":")[0])
    .filter((h, i, arr) => h && arr.indexOf(h) === i)
    .slice(0, Math.max(1, Math.min(3, n)));
  // 直连也算一条通道：DO 的出口族与中继不同，常常正好一个 403 一个 200（真混采样）
  const dq = "https://meter/tf?h=" + encodeURIComponent(host) + "&r=";
  const dres = (await withTimeout(stub0(c).fetch(dq), 8000)) as Response | undefined;
  const direct = dres ? ((await withTimeout(dres.json(), 4000)) as { ok: boolean; status?: number; ms?: number }) : { ok: false };
  const q =
    "https://meter/tfb?h=" + encodeURIComponent(host) + "&r=" + encodeURIComponent(ips.map((x) => x + ":443").join(","));
  const stub = stub0(c);
  const r = (await withTimeout(stub.fetch(q), 20000)) as Response | undefined;
  const body = r
    ? ((await withTimeout(r.json(), 5000)) as { rows?: Array<{ relay: string; ok: boolean; status?: number; ms?: number }> })
    : { rows: [] };
  const rows = (body.rows || []) as Array<{ relay: string; ok: boolean; status?: number; ms?: number }>;
  if (direct.ok || (direct as { status?: number }).status) rows.unshift({ relay: "direct", ok: !!direct.ok, status: direct.status, ms: direct.ms });
  const okN = rows.filter((x) => x.ok && x.status === 200).length;
  const badN = rows.filter((x) => (x.status || 0) >= 400).length;
  const verdict = tfVerdict(rows);
  for (const row of rows) {
    const ip = row.relay.split(":")[0];
    if (verdict === "chan" && row.status === 403) vSetState(host, ip === "direct" ? "d" : "r:" + ip, 2, 1);
    else if (row.ok && row.status === 200) vSet(host, ip === "direct" ? "d" : "r:" + ip, 200, Number(row.ms || 0), 1);
  }
  return Response.json({ host, probed: rows.length, okN, badN, verdict, rows });
}
