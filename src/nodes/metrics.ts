/**
 * 节点/站点指标的门面：入口 RTT 学习（`./rtt`）、站点画像（`./site`）、诊断结论（`./diag`）
 * 与错误账本（`./errlog`）各自成文件，这里只做转出，导出面与拆分前完全一致。
 */
export * from "./rtt";
export * from "./site";
export * from "./diag";
export { ERRS, ErrRing, errKind, errCount, errHist, logErr } from "./errlog";
