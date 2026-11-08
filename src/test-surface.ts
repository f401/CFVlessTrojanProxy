import { Connection } from "./connection";
import { diagVerdict, hostDirectMark, hostKey, hostNodeMark, hostRank, hostScore, hostUntried, logErr, rttLearn } from "./metrics";
import { checkTarget, isPrivateHost } from "./net";
import { effectiveQuota, subHeaders } from "./panel";
import { detectProtocol, loadUsers, parseTrojan, parseVLESS } from "./proto";
import { nsOf, pxGet } from "./px";
import { tlsHello } from "./px-probe";
import { availOf, bestFor, candsFor, capOf, costOf, emptyCloseSuspect, freezeNode, nsFail, nsGet, nsOk, nsSpeed, p90Of, pFailOf, pcts } from "./px-score";
import { SEEDS } from "./px-seed";
import { SEL } from "./selector";
import { S } from "./state";
import { COLO_CITY, loadNodes, nodeLabel, orderNodes, renderClash, renderLinks, renderSingbox, tagOf, trojanPasswordOf } from "./sub";
import { VERSION, sha224Bytes, toHex } from "./util";

// 测试专用出口：只在 dist/_test.js 里存在，生产包不含此文件
export { sha224Bytes, toHex, VERSION } from "./util";
export { detectProtocol, parseVLESS, parseTrojan, loadUsers } from "./proto";
export { checkTarget, isPrivateHost } from "./net";
export { renderClash, renderSingbox, renderLinks, orderNodes, nodeLabel, tagOf, loadNodes, COLO_CITY, trojanPasswordOf } from "./sub";
export { rttLearn } from "./metrics";
export { subHeaders, effectiveQuota } from "./panel";
export { S } from "./state";
export { SEL } from "./selector";
export { SEEDS } from "./px-seed";
export { Connection } from "./connection";
export { nsGet, nsSpeed, nsOk, nsFail, pcts, p90Of, capOf, costOf, candsFor, bestFor, availOf, pFailOf, emptyCloseSuspect, freezeNode } from "./px-score";
export { nsOf, pxGet } from "./px";
export { logErr, hostNodeMark, hostDirectMark, diagVerdict, hostRank, hostScore, hostKey, hostUntried } from "./metrics";
export { tlsHello } from "./px-probe";
