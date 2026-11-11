import { Connection } from "./proxy/connection";
import {
  diagVerdict,
  hostDirectMark,
  hostKey,
  hostNodeMark,
  hostRank,
  hostScore,
  hostUntried,
  logErr,
  rttLearn,
} from "./nodes/metrics";
import { checkTarget, isPrivateHost } from "./proxy/dial";

import { detectProtocol, loadUsers, parseTrojan, parseVLESS } from "./proxy/protocol";
import { nsOf, pxGet } from "./px/pool";
import { tlsHello } from "./px/probe";
import {
  availOf,
  bestFor,
  candsFor,
  nextNode,
  capOf,
  costOf,
  emptyCloseSuspect,
  freezeNode,
  nsFail,
  nsGet,
  nsOk,
  nsSpeed,
  nsProbe,
  p90Of,
  pFailOf,
  pcts,
} from "./nodes/score";
import { SEEDS } from "./px/seed";
import { SEL } from "./px/selector";
import { S } from "./core/state";
import {
  COLO_CITY,
  loadNodes,
  nodeLabel,
  orderNodes,
  renderClash,
  renderLinks,
  renderSingbox,
  tagOf,
  trojanPasswordOf,
} from "./views/sub";
import { VERSION, sha224Bytes, toHex } from "./core/util";

// 测试专用出口：只在 dist/_test.js 里存在，生产包不含此文件
export { sha224Bytes, toHex, VERSION, shadowRate, eachLimit, withTimeout } from "./core/util";
export { detectProtocol, parseVLESS, parseTrojan, loadUsers } from "./proxy/protocol";
export { checkTarget, isPrivateHost, isV4Literal, nat64FromV4 } from "./proxy/dial";
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
export { loadRtt, rttLearn, rttMark } from "./nodes/metrics";
export { subHeaders, effectiveQuota } from "./core/quota";
export { S } from "./core/state";
export { SEL } from "./px/selector";
export { dwellOf } from "./px/selector";
export { SEEDS } from "./px/seed";
export { Connection } from "./proxy/connection";
export {
  nsGet,
  nsSpeed,
  nsProbe,
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
export { nsOf, pxGet, flushPx } from "./px/pool";
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
} from "./nodes/metrics";
export { tlsHello, refillPool } from "./px/probe";
export { regionListAsync } from "./px/probe";
export { nodeSnapGet, primaryId, flushSnap, usageSnapWrite, readStats } from "./store/index";
export { runCron } from "./routes/cron";
export { renderStatsHtml } from "./views/panel";
export { randomPwd } from "./views/auth";

export { renderAdmin } from "./views/panel";
export { adminAuthed, sessionToken } from "./views/auth";
export { html, CSP_STATIC } from "./edge/respond";
export { wsToStream } from "./proxy/ws-in";
