import { RegionsView } from "./region-panel";
/**
 * 诊断/浏览类只读路由入口：proxyip（池子报表）、debug（内部探针）、regions（地区节点浏览器）。
 * 面板本体在 `./region-panel`（控制器 + 展示缓存 + 两个结论工具），这里只留路由入口与再导出。
 */
export { proxyip } from "./proxyip";
export { debug } from "./debug";
export { RegionsView, nodeCheckConclusion, countryOf } from "./region-panel";
export { levelBadge, kindLabel, familyLabel, ccTag, flagLabel, egLabel, psLabel, dnsLabel, groupRows } from "../views/regions";

import type { UserCtx } from "../edge/types";

/** 路由入口：/<uuid>/regions（异步，POST 写回要走 KV） */
export function regions(c: UserCtx): Promise<Response> {
  return new RegionsView(c).run();
}
