import { PEND } from "../store/pend";
import { METER_CLIENT } from "../store/meter-client";
import { KV_WRITES } from "../store/kv";
import { NODE_MEMORY } from "../core/node-memory";
import { ENTRY_MEMORY, ERROR_MEMORY } from "../core/client-memory";
import { USAGE_MEMORY } from "../store/usage-memory";
import { P_T, VERSION } from "../core/util";
import { ERRS, HOSTS } from "../nodes/metrics";
import { cntView } from "../core/counter";
import { FACT } from "../route/factshadow";
import { json, forbidden } from "../edge/respond";
import type { RouteCtx } from "../edge/types";
import { PS } from "../route/psfacts";
import { EG } from "../route/egfacts";
import { DEAD } from "../route/deadfacts";
import { FO, LAT } from "../core/obs";
import { DNS } from "../route/dnsfacts";
import { egCounts } from "../route/egfacts";
import { SOURCES } from "../px/probe";
import { CAP } from "../route/capfacts";
import { ALIVE_TARGET } from "../core/const";
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
    statEntries: USAGE_MEMORY.rows.size,
    rttBuckets: ENTRY_MEMORY.rows.size,
    hostPrefs: HOSTS.nodes.size,
    candidates: NODE_MEMORY.candidateCount,
    errors: ERROR_MEMORY.rows.length,
    errsByKind: ERRS.hist(),
    errsDup: ERRS.dropped(),
cf: FACT.snap(),
    eg: EG.snap(),
    ps: PS.snap(),
    dead: DEAD.snap(),
    first: FO.snap(),
    lat: LAT.snap(),
    dns: DNS.snap(),
    cap: CAP.snap(),
    src: SOURCES.stat(),
    facts: factList(c.env),
    // short 是唯一的「池子够不够」判据：低于目标时 cron 那套扫描已经在满预算跑（7.179）
    relays: (() => { const ips = [...NODE_MEMORY.alive.values()].map((x) => String(x.h || "")).filter(Boolean); const c = egCounts(ips); return { alive: ips.length, target: ALIVE_TARGET, short: ips.length < ALIVE_TARGET, eg4: c.v4, eg6: c.v6, egUnk: c.unk }; })(),
    blk: BLK.snap(),
    colo: (c.cf && c.cf.colo) || "",
    cnt: cntView(),
    kvWrites: KV_WRITES.writes,
    doCalls: METER_CLIENT.calls,
    pendSize: PEND.rows.size,
    pendMs: PEND.intervalMs,
    kvLastWrite: KV_WRITES.status,
    version: VERSION,
  });
}

