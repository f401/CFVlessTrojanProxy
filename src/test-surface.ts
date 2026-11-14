// 测试专用出口：只在 dist/_test.js 里存在，生产包不含此文件
export { sha224Bytes, toHex, VERSION, shadowRate, eachLimit, withTimeout } from "./core/util";
export { detectProtocol, parseVLESS, parseTrojan, loadUsers } from "./proxy/protocol";
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
} from "./views/sub";
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
export { nsOf, pxGet, flushPx, noteProbe } from "./px/pool";
export { POOL, Pool } from "./px/pool";
export { DIALER, Dialer } from "./proxy/dialer";
export { ATTACHER, Attacher } from "./proxy/attacher";
export { REGION, RegionPicker } from "./proxy/region";
export { spdSnapshot } from "./core/node-snapshot";
export { cntDelta, cntUnsend, cntView } from "./core/counter";
export {
  logErr,
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
export { tlsHello, refillPool, srcNote, srcRank, srcHealth, poolSources, POOL_SOURCES } from "./px/probe";
export { regionListAsync } from "./px/regions";
export { clSnapshot, nodeSnapGet, primaryId, flushSnap, usageSnapWrite, readStats } from "./store/index";
export { runCron } from "./routes/cron";
export { renderStatsHtml } from "./views/panel";
export { statsNodeRows } from "./nodes/stats-rows";
export { randomPwd } from "./edge/auth";

export { renderAdmin } from "./views/panel";
export { adminAuthed, sessionToken } from "./edge/auth";
export { html, CSP_STATIC } from "./edge/respond";
export { wsToStream } from "./proxy/ws-in";
export { pickHosts, SWEEP_COST } from "./route/round";
export { vSet, vSetState, vState, vOk, vBad, vDead, vAll, vClear, vImport } from "./route/verdict";
export { recordProbe, recordTraffic, recordClient } from "./route/observe";
export { DIRECT, chanKey, parseChan, nodeKeyOf } from "./route/channel";
export { decide, shadow, policyOn } from "./route/policy";
export { pxDecision } from "./proxy/pxhook";
export { HOOK } from "./core/hook";
export { planRound, planView } from "./route/budget";
export { chanPref, prefsOf, prefsJson, PREFS } from "./route/prefs";
export { HEALTH, RelayHealth, ipOf, healthyRelays } from "./route/relay-health";
export { STORE, Store } from "./store/store";
export { VT, VerdictTable } from "./route/verdict";
export { JUDGE, Judge } from "./route/judge";
export { POLICY, Policy } from "./route/policy";
export { judge, queueVerify, runVerify, verifyInfo, queueLen } from "./route/verify";
export { recordBlock, recordPass } from "./route/observe";
export { runTfb, tfVerdict, tfClass, tfEscalate, pickFresh } from "./route/tfb";

export { handleDns, trojanUdpFrame } from "./proxy/dns";
export { handleUpgrade } from "./proxy/session";

