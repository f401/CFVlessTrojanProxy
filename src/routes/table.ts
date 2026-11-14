import type { UserCtx } from "../edge/types";
import { logs } from "./logs";
import { subscription } from "./subscription";
import { debug, proxyip } from "./tools";

/** 用户级路由定义：谁匹配、处理前要准备什么、交给谁 */
export interface SubRoute {
  name: string;
  /** 能匹配的子路径（空串 = 裸 /<uuid>） */
  subs: string[];
  /** 处理前把本 isolate 的增量推给 DO，并跳过统计读缓存 */
  stats: boolean;
  /** 处理前加载 RTT 学习表与地区列表（只有订阅/统计需要） */
  rtt: boolean;
  handle: (c: UserCtx, sub: string) => Response | Promise<Response>;
}

const TABLE: SubRoute[] = [
  {
    name: "subscription",
    subs: ["", "cl", "pcl", "sb", "psb", "ty", "pty", "stats"],
    stats: true,
    rtt: true,
    handle: (c, sub) => subscription(c, sub === "" ? "page" : sub),
  },
  { name: "logs", subs: ["logs"], stats: false, rtt: false, handle: (c) => logs(c) },
  { name: "proxyip", subs: ["proxyip"], stats: false, rtt: false, handle: (c) => proxyip(c) },
  { name: "debug", subs: ["debug"], stats: false, rtt: false, handle: (c) => debug(c) },
];

/**
 * 路由表（P6-2）：把 `/<uuid>/<sub>` 的分派从 switch 换成一张表。
 * 以后加路由只改这张表，`src/index.ts` 不再长（组装根只做「按表分发」）。
 */
export class RouteTable {
  /** 按子路径查表；未命中返回 undefined（调用方回 404） */
  route(sub: string): SubRoute | undefined {
    return TABLE.find((r) => r.subs.includes(sub));
  }

  /** 表里注册的路由名（调试与测试用） */
  names(): string[] {
    return TABLE.map((r) => r.name);
  }

  /** 该子路径是否需要「先推增量、跳缓存」 */
  needsStats(sub: string): boolean {
    return this.route(sub)?.stats === true;
  }

  /** 该子路径是否需要 RTT/地区数据 */
  needsRtt(sub: string): boolean {
    return this.route(sub)?.rtt === true;
  }
}

/** 进程内唯一实例 */
export const ROUTES = new RouteTable();

