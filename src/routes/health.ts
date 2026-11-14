import { P_T, VERSION } from "../core/util";
import { S } from "../core/state";
import { errHist } from "../nodes/metrics";
import { cntView } from "../core/counter";
import { json, forbidden } from "../edge/respond";
import type { RouteCtx } from "../edge/types";

/** /health：进程自述。带 pageKey 时要求 ?k= */
export function health(c: RouteCtx): Response {
  if (c.pageKey && !c.keyOk) return forbidden();
  return json({
    ok: true,
    ts: Date.now(),
    uuids: c.auth.uuids.size,
    [P_T]: c.auth.trojan.size,
    statEntries: S.stats.size,
    rttBuckets: S.rtt.size,
    hostPrefs: S.hostNode.size,
    candidates: S.candN,
    errors: S.errs.length,
    errsByKind: errHist(),
    colo: (c.cf && c.cf.colo) || "",
    cnt: cntView(),
    kvWrites: S.kvw,
    doCalls: S.doCalls,
    pendSize: S.pend.size,
    pendMs: S.pendMs,
    kvLastWrite: S.kvStat,
    version: VERSION,
  });
}
