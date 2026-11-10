import { Connection } from "./proxy/connection";
import { diagVerdict, hostDirectMark, hostKey, hostNodeMark, hostRank, hostScore, hostUntried, logErr, rttLearn } from "./nodes/metrics";
import { checkTarget, isPrivateHost } from "./proxy/dial";

import { detectProtocol, loadUsers, parseTrojan, parseVLESS } from "./proxy/protocol";
import { nsOf, pxGet } from "./px/pool";
import { tlsHello } from "./px/probe";
import { availOf, bestFor, candsFor, capOf, costOf, emptyCloseSuspect, freezeNode, nsFail, nsGet, nsOk, nsSpeed, p90Of, pFailOf, pcts } from "./nodes/score";
import { SEEDS } from "./px/seed";
import { SEL } from "./nodes/selector";
import { S } from "./core/state";
import { COLO_CITY, loadNodes, nodeLabel, orderNodes, renderClash, renderLinks, renderSingbox, tagOf, trojanPasswordOf } from "./views/sub";
import { VERSION, sha224Bytes, toHex } from "./core/util";

// 测试专用出口：只在 dist/_test.js 里存在，生产包不含此文件
export { sha224Bytes, toHex, VERSION } from "./core/util";
export { detectProtocol, parseVLESS, parseTrojan, loadUsers } from "./proxy/protocol";
export { checkTarget, isPrivateHost } from "./proxy/dial";
export { renderClash, renderSingbox, renderLinks, orderNodes, nodeLabel, tagOf, loadNodes, COLO_CITY, trojanPasswordOf } from "./views/sub";
export { loadRtt, rttLearn } from "./nodes/metrics";
export { subHeaders, effectiveQuota } from "./core/quota";
export { S } from "./core/state";
export { SEL } from "./nodes/selector";
export { SEEDS } from "./px/seed";
export { Connection } from "./proxy/connection";
export { nsGet, nsSpeed, nsOk, nsFail, nsSiteFail, nsEmptyClose, pFailFast, pcts, p90Of, capOf, costOf, scoreParts, effView, ageFactor, candsFor, bestFor, availOf, pFailOf, emptyCloseSuspect, freezeNode } from "./nodes/score";
export { nsOf, pxGet, spdSnapshot } from "./px/pool";
export { logErr, hostNodeMark, hostDirectMark, diagVerdict, hostRank, hostScore, hostKey, hostUntried } from "./nodes/metrics";
export { tlsHello } from "./px/probe";
export { nodeSnapGet, primaryId, flushSnap } from "./store/index";
export { renderStatsHtml } from "./views/panel";

export { renderAdmin } from "./views/panel";
export { adminAuthed, sessionToken } from "./views/auth";
