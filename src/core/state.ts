/** isolate 的入口标识；业务状态由各领域所有者独立持有。 */
export class IsolateContext {
  /** 当前入口域名（CF 头里的 host；没带时沿用上次值） */
  site = "";
  /** 当前机房码（判断跨机房不可比、面板显示都用它） */
  colo = "";

  /** 功能：记录入口与机房，缺少机房时沿用已知值。@param site 入口域名。@param colo 机房码。@returns 无 */
  capture(site: string, colo?: string): void {
    this.site = site;
    this.colo = colo || this.colo || "??";
  }
}

/** 当前 isolate 的入口元数据，不包含预算或业务状态。 */
export const ISOLATE = new IsolateContext();
