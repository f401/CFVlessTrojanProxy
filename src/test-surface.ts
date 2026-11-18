// 测试专用出口：只在 dist/_test.js 里存在，生产包不含此文件
// `core/util.ts` 在 7.299 合回单个文件：字节编解码、SHA-224、WS 常量、三个超时预算、
// 并发闸、环境解析、协议名与错误文本都还在原处，只是不再各占一个文件。
export {
  P_T,
  P_V,
  SHADOW_DEFAULT,
  VERSION,
  WS_MAX_BUFFER,
  eachLimit,
  errMsg,
  secretPwd,
  sha224Bytes,
  sha224Mix,
  sha224Pad,
  sha224Words,
  SHA_H224,
  enc,
  shadowRate,
  toHex,
  toU8,
  uuidFromBytes,
  withTimeout,
} from "./core/util";
export { trimAged, dropExpired } from "./core/hostmem";
export { aesKey, b64d, b64e, seal, unseal } from "./store/crypto";
export { factsOut, freshTop } from "./store/factout";
export { MeterState } from "./store/meter-state";
export { MeterEndpoints } from "./store/meter";
export { FirstFrame, parseVLESS, parseTrojan, loadUsers, normAtyp, readAddr, UserIndex } from "./proxy/protocol";
export { DOH_ENDPOINTS, checkTarget, isPrivateHost, isV4Literal, nat64FromV4 } from "./proxy/dial";
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
export { SubscriptionView } from "./views/sub";
export { RouteTable } from "./routes/table";
export { PageView } from "./views/panel";
export { loadRtt, rttLearn, rttMark } from "./nodes/metrics";
export { HOSTS, HostProfile, siteKey } from "./nodes/metrics";
export { subHeaders, effectiveQuota } from "./core/quota";
export { S } from "./core/state";
export { EMPTY_CLOSE_BAD, NodeStatsTable, TEN_MB, ZERO_STAT } from "./nodes/stat";
export { SC } from "./core/const";
export { SEL, Selector } from "./px/selector";
export { FailBook } from "./px/failbook";
export { Rotation, dwellOf } from "./px/selector";
export { PICK, PickPath } from "./px/pickpath";
export { ThompsonPicker } from "./px/ts";
export { SitePick, PathPrefs } from "./px/pickpath";
export { SeedStore } from "./px/seed";
export { Connection } from "./proxy/connection";
export { CAGG_MAX, ConnSettle, type SettleView } from "./proxy/conn-settle";
export { FLOW_TICK_MS, NODE_EMIT_GAP_MS, NODE_WIN_MS, SITE_WIN_MS, SampleWindow, ClientFlow } from "./proxy/connection";
export { SAMPLE_MIN_BYTES, SAMPLE_STD_BYTES, SITE_MIN_BYTES, TRANSFER_ENOUGH, kbsOf, sampleWeight, stalledWindow } from "./proxy/conn-settle";
export {
  pFailFast,
  pcts,
  p90Of,
  capOf,
  costOf,
  scoreParts,
  effView,
  ageFactor,
  availOf,
  pFailOf,
  emptyCloseSuspect,
  freezeNode,
  isFrozen,
  usable,
  CANDS,
  CandidateBoard,
  ScoreModel,
} from "./nodes/score";
export { commitPool, ensurePool, nsOf, pxGet, flushPx, noteProbe, bumpProbeBad } from "./px/pool";
export { ALIVE_MAX, AliveBoard, ProbeCooldown, PoolScan, SEED_COLD_N, aliveList, cronScan } from "./px/pool";
export { ScanAlive, ScanHouse, ScanProbe, probeBatch, probeOne } from "./px/scan";
export type { ProbeHit } from "./px/scan";
export { DIALER, Dialer } from "./proxy/dialer";
export { SOCKET_DIALER, SocketDialer } from "./proxy/socket-dialer";
export { MeterDiagnostics } from "./store/meter-diagnostics";
export { Attacher } from "./proxy/attacher";
export { RegionPicker } from "./proxy/region";
export { cnt, cntDelta, cntUnsend, cntView } from "./core/counter";
export { CronLock } from "./core/lock";
export {
  logErr,
  hostNodeMark,
  hostDirectMark,
  diagVerdict,
  hostScore,
  hostKey,
  HN_MAX_HOSTS,
  HN_MAX_NODES,
  errKind,
  errCount,
} from "./nodes/metrics";
export { ERRS } from "./nodes/errlog";
export { BUDGET_CAPS, BUDGET_KINDS, BudgetExhausted, BudgetLedger, isBudgetExhausted } from "./core/budget-ledger";
export { BudgetedIO } from "./core/budgeted-io";
export { REFILL_MAX, tlsHello, probeProxy, probeSni, refillPool, chunks, poolSources, POOL_SOURCES, POOL_ENOUGH, SOURCES, pxPolicy, RawProbe } from "./px/probe";
export { regionListAsync } from "./px/regions";
export { PEND, RESTORE_MAX, getSnap, kvGetStrict, nodeSnapGet, flushSnap, usageSnapWrite, readStats, restorePick } from "./store/index";
export { doFetch, meterGet } from "./store/meter-client";
export { runCron } from "./routes/cron";
export { ProxyipView, proxyip } from "./routes/proxyip";
export { AdminView, admin } from "./routes/admin";
export { SubscriptionRoutes, subscription } from "./routes/subscription";
export { debug, DEBUG, DebugActions, DebugMeterProbes, DebugTables, DebugSuite } from "./routes/debug";
export {
  DebugBench,
  DebugDiag,
  DebugNets,
  DebugProbe,
  DebugTf,
} from "./routes/debug-nets";
export { renderStatsHtml } from "./views/panel";
export { PanelView, renderHtml } from "./views/panel";
export { statsNodeRows } from "./nodes/stats-rows";
export { randomPwd } from "./edge/auth";

export { renderAdmin, renderAdminHint, renderLogin } from "./routes/admin";
export { RATE_LIMIT, RateLimiter, adminAuthed, sha256Hex, sessionToken } from "./edge/auth";
export { html, CSP_STATIC } from "./edge/respond";
export { UploadStream, WS_UP_QUEUE_MAX, wsToStream } from "./proxy/ws-in";
export { pipeBack } from "./proxy/tunnel";
export { VT_TTL_MS } from "./route/verdict";
export { vtDelta, vtLoad, vtAck, vtNack } from "./route/verdictsync";
export { recordTraffic } from "./route/observe";
export { DIRECT, chanKey, nodeKeyOf } from "./route/channel";
export { pxDecision } from "./proxy/pxhook";
export { HOOK } from "./core/hook";
export { DNS_BATCH, SHARE_PEND, SHARE_SNAP, TFB_CALLS, SUB_FIXED, SUB_FIXED_N, planRound, planView } from "./route/budget";
export { Prefs } from "./route/prefs";
export { HEALTH, RelayHealth, ipOf } from "./route/relay-health";
export { RelayLedger } from "./route/relay-ledger";
export { VT, VerdictTable } from "./route/verdict";
export { JUDGE, Judge } from "./route/judge";
export { POLICY, Policy } from "./route/policy";
export { decideCf } from "./route/policy";
export { rankOf } from "./route/policy";
export { FactRegistry, type FactEffect } from "./route/fact-registry";
export { PolicyWiring } from "./route/policy-wiring";
export { recordBlock, recordPass } from "./route/observe";
export { runTfb, tfVerdict, tfClass, tfEscalate, tfBlockOk, tfRemember, pickFresh } from "./route/tfb";
export { TFB, TfbBook } from "./route/tfbbook";
export { RELPERF, REL_SAMPLE_TTL, RelPerfTable, relCostFor, relCostOf, relNote } from "./route/relperf";
export { Mode, St } from "./core/enums";
export { BoundedMap, TimedMarks } from "./core/table";
export { EG, EG_BIG, EG_TINY, EG_TTL, EgFacts, egCounts, egDerive } from "./route/egfacts";
export { CAP, CAP_MAX, CAP_TTL, CapFacts } from "./route/capfacts";
export { ALIVE_TARGET } from "./core/const";
export { FACT_ALL, factList, factOn, factParse } from "./route/factflags";
export { factMul } from "./route/factmul";
export { PS, PS_BATCH, PS_TTL, PsFacts, psPrior } from "./route/psfacts";
export { DEAD, DEAD_N, DeadFacts } from "./route/deadfacts";
export { FO, FirstObs, FO_GRAY, FO_LIMIT, FO_PAGE, LAT, LatObs, spdSnapshot } from "./core/obs";
export { DNS, DnsFacts, DNS_TTL } from "./route/dnsfacts";
export { BLK, BLK_BATCH, BLK_DELTA_MAX, BLK_GAP, BLK_MIN, BLK_PEN, BlkFacts } from "./route/blkfacts";
export { FACT_TTL, PAGE_ABS, mergeAt, mergeBlk } from "./core/facts";
export { MeterAdd } from "./store/meteradd";
export { FactMerger } from "./store/factmerge";
export type { FactTables } from "./store/factmerge";
export { BLK_TTL, BIG_PEER, BIG_WIN, DEAD_TTL, TINY_ABS, WRITE_GAP, commitFact, factKey, isTiny } from "./route/commitfact";
export { FACT, FactShadow, shadowCtx, shadowObs } from "./route/factshadow";
/** 四类事实的门面（OOP 收口后唯一的上行/合并入口） */
export { FactsStore } from "./route/factsstore";
/** 探测传输层：抽象与三个实现（userland TLS / 运行时 fetch / 明文 HTTP·80）同住 `core/transport.ts` */
export {
  GATEWAY_TRANSPORT,
  GatewayFetchTransport,
  HTTP80_TRANSPORT,
  Http80Transport,
  TRANSPORTS,
  TUNNEL_TRANSPORT,
  TransportRegistry,
  TunnelFetchTransport,
  probeTf,
} from "./core/transport";
export { relayIpOf, splitRelay } from "./core/relay-addr";
export { parseProxyIp } from "./proxy/dial";
export { cfHttpCode, refreshCfHttp } from "./proxy/cfverdict";

export { handleDns, trojanUdpFrame } from "./proxy/dns";
export { ProxySession, handleUpgrade } from "./proxy/session";



export { CONNECT_MS, FIRST_UP_MS, UP_STALL_MS } from "./core/util";
