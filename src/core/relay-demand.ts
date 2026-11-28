import { BoundedMap } from "./table";
import { SC } from "./const";

/** 需重采样的站点到期表；代理与判定层共用有界协议。 */
export class RelayDemand extends BoundedMap<string, number> {
  /** 功能：以最早到期优先淘汰，容量与探测账本同源。 */
  constructor() {
    super({ max: SC.PX_MAX, timeOf: (until) => until });
  }

  /** 功能：登记后立即裁剪，防止遗漏外部裁剪。@param host 站点名。@param until 到期时间。@returns 当前表 */
  override set(host: string, until: number): this {
    super.set(host, until);
    this.prune(Date.now(), false);
    return this;
  }
}

/** 中继重采样需求的 isolate 所有者。 */
export const RELAY_DEMAND = new RelayDemand();
