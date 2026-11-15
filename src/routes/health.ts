import { P_T, VERSION } from "../core/util";
import { S } from "../core/state";
import { errDup, errHist } from "../nodes/metrics";
import { cntView } from "../core/counter";
import { FACT } from "../route/factshadow";
import { json, forbidden } from "../edge/respond";
import type { RouteCtx } from "../edge/types";
import { PS } from "../route/psfacts";
import { EG } from "../route/egfacts";
import { DEAD } from "../route/deadfacts";
import { FO } from "../core/firstobs";
import { LAT } from "../core/latobs";
import { DNS } from "../route/dnsfacts";
import { egCounts } from "../route/egfacts";
import { CAP } from "../route/capfacts";
import { ALIVE_TARGET, srcStat } from "../px/aliveplan";
import { factList } from "../route/factflags";
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
    lat: LAT.snap(),
    dns: DNS.snap(),
    cap: CAP.snap(),
    src: srcStat(),
    facts: factList(c.env),
    // short 是唯一的「池子够不够」判据：低于目标时 cron 那套扫描已经在满预算跑（7.179）
    relays: (() => { const ips = [...S.alive.values()].map((x) => String(x.h || "")).filter(Boolean); const c = egCounts(ips); return { alive: ips.length, target: ALIVE_TARGET, short: ips.length < ALIVE_TARGET, eg4: c.v4, eg6: c.v6, egUnk: c.unk }; })(),
    blk: BLK.snap(),
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

