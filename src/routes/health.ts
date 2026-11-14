import { P_T, VERSION } from "../core/util";
import { S } from "../core/state";
import { errDup, errHist } from "../nodes/metrics";
import { EDGE_ERR, edgeRank } from "../route/edge";
import { cntView } from "../core/counter";
import { FACT } from "../route/factshadow";
import { json, forbidden } from "../edge/respond";
import type { RouteCtx } from "../edge/types";
import { PS } from "../route/psfacts";
import { EG } from "../route/egfacts";
import { DEAD } from "../route/deadfacts";
import { FO } from "../core/firstobs";
import { BLK } from "../route/blkfacts";

/** /health：进程自述。带 pageKey 时要求 ?k= */
export function health(c: RouteCtx): Response {
  if (c.pageKey && !c.keyOk) return forbidden();
  // 只报计数与版本，不回显任何凭据；这些数字就是线上排障的全部入口
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
    errsDup: errDup(),
cf: FACT.snap(),
    eg: EG.snap(),
    ps: PS.snap(),
    dead: DEAD.snap(),
    first: FO.snap(),
    blk: BLK.snap(),
    edge: { seen: S.edge.size, ranked: edgeRank(8).length, err: EDGE_ERR.s },
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

