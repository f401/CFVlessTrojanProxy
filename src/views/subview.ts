import { renderLinks } from "./sub-links";
import { renderSingbox } from "./sub-singbox";
import { renderClash } from "./sub";

/** 订阅输出格式：Clash/Mihomo YAML、sing-box JSON、纯链接列表 */
export type SubKind = "clash" | "singbox" | "links";

export interface SubViewIn {
  env: Env;
  url: URL;
  id: string;
  host: string;
  learned: Record<string, RttEntry>;
  regions: string[];
  auth: Auth;
}

/**
 * 订阅视图（P6-1）：把「同一份节点清单按不同客户端格式渲染」收成一个对象。
 * 三种格式共享入参，差别只在序列化方式，所以用一张分派表，而不是三处 if。
 */
export class SubscriptionView {
  /** 按格式渲染；未知格式回落到 clash（历史行为） */
  render(o: SubViewIn, kind: SubKind): string {
    const pick = this.table()[kind] || this.table().clash;
    return pick(o);
  }

  private table(): Record<SubKind, (o: SubViewIn) => string> {
    return {
      clash: (o) => renderClash(o.env, o.url, o.id, o.host, o.learned, o.regions, o.auth),
      singbox: (o) => renderSingbox(o.env, o.url, o.id, o.host, o.learned, o.regions, o.auth),
      links: (o) => renderLinks(o.env, o.url, o.id, o.host, o.learned, o.regions, o.auth),
    };
  }
}

/** 进程内唯一实例 */
export const SUBVIEW = new SubscriptionView();
