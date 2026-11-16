// 测试专用出口：只在 dist/_test.js 里存在，生产包不含此文件
export { sha224Bytes, toHex, VERSION, shadowRate, secretPwd, eachLimit, withTimeout } from "./core/util";
export { trimAged, dropExpired } from "./core/hostmem";
export { aesKey, b64d, b64e, seal, unseal } from "./store/crypto";
export { factsOut, freshTop } from "./store/factout";
export { detectProtocol, parseVLESS, parseTrojan, loadUsers, normAtyp, readAddr } from "./proxy/protocol";
export { checkTarget, isPrivateHost, isV4Literal, nat64FromV4 } from "./proxy/dial";
export { isPxHost, pxHostList } from "./core/hosts";
export { isCfIp } from "./core/net";
export { isCfHost } from "./proxy/dial";
export {
  renderClash,
  renderSingbox,
  renderLinks,
  orderNodes,
  nodeLabel,
  tagOf,
  loadNodes,
  COLO_CITY,
  trojanPasswordOf,
  edgeCount,
} from "./views/sub";
export { regionEntries } from "./views/sub-common";
export { SUBVIEW, SubscriptionView } from "./views/subview";
export { ROUTES, RouteTable } from "./routes/table";
export { PAGES, PageView } from "./views/pageview";
export { loadRtt, rttLearn, rttMark } from "./nodes/metrics";
export { subHeaders, effectiveQuota } from "./core/quota";
export { S } from "./core/state";
export { SC } from "./core/const";
export { SEL } from "./px/selector";
export { dwellOf } from "./px/selector";
export { SEEDS } from "./px/seed";
export { Connection } from "./proxy/connection";
export {
  nsGet,
  nsSpeed,
  nsProbe,
  nsProbeFail,
  nsStall,
  nsLatency,
  nsOk,
  nsFail,
  nsSiteFail,
  nsEmptyClose,
  pFailFast,
  pcts,
  p90Of,
  capOf,
  costOf,
  scoreParts,
  invalidateRank,
  effView,
  ageFactor,
  candsFor,
  bestFor,
  nextNode,
  availOf,
  pFailOf,
  emptyCloseSuspect,
  freezeNode,
  isFrozen,
} from "./nodes/score";
export { nsOf, pxGet, flushPx, noteProbe, probeBadSkip, bumpProbeBad, sweepProbeBad } from "./px/pool";
export { POOL, Pool } from "./px/pool";
export { DIALER, Dialer } from "./proxy/dialer";
export { ATTACHER, Attacher } from "./proxy/attacher";
export { REGION, RegionPicker } from "./proxy/region";
export { spdSnapshot } from "./core/node-snapshot";
export { cnt, cntDelta, cntUnsend, cntView } from "./core/counter";
export { CRONLOCK, CronLock } from "./core/lock";
export {
  logErr,
  errDup,
  hostNodeMark,
  hostDirectMark,
  diagVerdict,
  hostRank,
  hostScore,
  hostKey,
  hostUntried,
  errKind,
  errCount,
  errHist,
} from "./nodes/metrics";
export { ERRS } from "./nodes/errlog";
export { tlsHello, probeProxy, probeSni, refillPool, chunks, srcNote, srcRank, srcHealth, poolSources, POOL_SOURCES, POOL_ENOUGH, SOURCES } from "./px/probe";
export { regionListAsync } from "./px/regions";
export { PEND, clSnapshot, nodeSnapGet, primaryId, flushSnap, usageSnapWrite, readStats, restorePick } from "./store/index";
export { doFetch, meterGet } from "./store/meter-client";
export { runCron } from "./routes/cron";
export { renderStatsHtml } from "./views/panel";
export { statsNodeRows } from "./nodes/stats-rows";
export { randomPwd } from "./edge/auth";

export { renderAdmin } from "./views/panel";
export { RL_MEM, adminAuthed, rlReset, rlTake, sha256Hex, sessionToken } from "./edge/auth";
export { html, CSP_STATIC } from "./edge/respond";
export { wsToStream } from "./proxy/ws-in";
export { VT_TTL_MS, vSet, vSetState, vState, vOk, vBad, vDead, vAll, vClear, vImport } from "./route/verdict";
export { vtDelta, vtLoad, vtAck, vtNack } from "./route/verdictsync";
export { recordTraffic } from "./route/observe";
export { DIRECT, chanKey, nodeKeyOf } from "./route/channel";
export { decide, shadow, policyOn } from "./route/policy";
export { pxDecision } from "./proxy/pxhook";
export { HOOK } from "./core/hook";
export { SUB_FIXED, SUB_FIXED_N, planRound, planView } from "./route/budget";
export { chanPref, prefsOf, prefsJson, PREFS } from "./route/prefs";
export { HEALTH, RelayHealth, ipOf } from "./route/relay-health";
export { STORE, Store } from "./store/store";
export { VT, VerdictTable } from "./route/verdict";
export { JUDGE, Judge } from "./route/judge";
export { POLICY, Policy } from "./route/policy";
export { recordBlock, recordPass } from "./route/observe";
export { runTfb, tfVerdict, tfClass, tfEscalate, tfBlockOk, tfRemember, pickFresh } from "./route/tfb";
export { TFB, TfbBook } from "./route/tfbbook";
export { RELPERF, REL_TTL, relCost, relCostFor, relCostMode, relNote, relSnap } from "./route/relperf";
export { EG, EG_BIG, EG_TINY, EG_TTL, EgFacts, egCounts, egDerive } from "./route/egfacts";
export { CAP, CAP_MAX, CAP_TTL, CapFacts, capFactor } from "./route/capfacts";
export { ALIVE_TARGET, srcStat } from "./px/aliveplan";
export { FACT_ALL, factList, factOn, factParse } from "./route/factflags";
export { factMul } from "./route/factmul";
export { PS, PS_TTL, psBest, psFactor, psNote, psOk, psPrior, psSnap } from "./route/psfacts";
export { DEAD, DEAD_N, deadNote, isDead } from "./route/deadfacts";
export { FO, FirstObs, FO_GRAY, FO_LIMIT, FO_PAGE } from "./core/firstobs";
export { LAT, LatObs } from "./core/latobs";
export { DNS, DnsFacts, DNS_TTL } from "./route/dnsfacts";
export { BLK, BLK_BATCH, BLK_GAP, BLK_MIN, BLK_PEN, blkPen } from "./route/blkfacts";
export { FACT_TTL, PAGE_ABS, mergeAt, mergeBlk } from "./core/facts";
export { mergeFacts } from "./store/factmerge";
export type { FactTables } from "./store/factmerge";
export { BLK_TTL, BIG_PEER, BIG_WIN, DEAD_TTL, TINY_ABS, WRITE_GAP, commitFact, factKey, isTiny } from "./route/commitfact";
export { FACT, FactShadow, shadowCtx, shadowObs } from "./route/factshadow";
/** 四类事实的门面（OOP 收口后唯一的上行/合并入口） */
export { FACTS, FactsStore } from "./route/factsstore";
/** tunnelfetch 探针（出口族对照实验用） */
export { probeTf } from "./core/tf";
export { probeHttp80, splitRelay } from "./core/http80";
export { cfHttpCode, refreshCfHttp } from "./proxy/cfverdict";

export { handleDns, trojanUdpFrame } from "./proxy/dns";
export { handleUpgrade } from "./proxy/session";


