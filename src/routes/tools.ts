/**
 * 诊断/浏览类只读路由：proxyip（池子报表）、debug（内部探针）、regions（地区节点浏览器）。
 *
 * 为什么 regions 放在这里而不是新文件：源码文件数卡在 115 的门禁上限，新建文件会立刻变红；
 * 而 regions 与这两个邻居一样是「只读、不花 DO/KV 额度」的诊断端点，放一起语义一致。
 */
export { proxyip } from "./proxyip";
export { debug } from "./debug";

import { IpFamily, IpKind } from "../core/enums";
import { S } from "../core/state";
import { QUALITY, COVERAGE, CONN_OBS } from "../px/regions";
import { AliveBoard, nsOf } from "../px/pool";
import { json } from "../edge/respond";
import { splitRelay } from "../core/relay-addr";
import type { UserCtx } from "../edge/types";

/** 单个节点在浏览器里的展示行 */
interface RegionNodeRow {
  /** host:port 键（订阅 `?node=` 用的就是这个值） */
  key: string;
  /** 国家码（可能为空 = 未知地区） */
  country: string;
  /** 地址族 v4 / v6 */
  family: IpFamily;
  /** 是否在本 isolate 存活表里 */
  alive: boolean;
  /** 来源（存活表 / seed 跨 isolate 名单 / 两者） */
  source: string;
  /** 质量种类枚举（unknown 表示还没探过） */
  kind: IpKind;
  /** 质量等级 good / normal / risky */
  level: string;
  /** 是否代理 / VPN */
  proxy: boolean;
  vpn: boolean;
  /** 是否在覆盖账本里记过探测 */
  probed: boolean;
  /** 目标站点延迟（毫秒，null = 没测过） */
  rtt: number | null;
}

/**
 * 功能：地区节点浏览器 —— 列出 alive ∪ seed 的全部已知节点及其质量/族/覆盖/目标延迟。
 *
 * 为什么是一个类：这个端点要把四张来源不同的表（存活表、seed 名单、质量表、覆盖表）
 * 按同一个 key 拼成一行，还要处理「同一节点在两张表里都有」「补全 cc/family」的合并规则；
 * 把这些规则放在对象里，路由入口只剩一行 `new RegionsView(c).run()`。
 *
 * 额度纪律：全程只读内存表，不发子请求、不碰 DO/KV（净增 0）。
 */
export class RegionsView {
  /** 用户上下文（url 取 site 参数） */
  private readonly c: UserCtx;
  /** 构造时保存上下文，不做任何 I/O */
  constructor(c: UserCtx) {
    this.c = c;
  }

  /**
   * 功能：把 host 归到地址族（字面量 IPv6 带冒号，其余按 v4）。
   * @param h 主机（IP 字面量或域名）
   * @returns 地址族枚举
   */
  private familyOf(h: string): IpFamily {
    return h.includes(":") ? IpFamily.IPv6 : IpFamily.IPv4;
  }

  /**
   * 功能：把 seed 的 byColo 分桶摊平成 `key → 国家码` 的映射（跨 isolate 的已知节点）。
   * @returns key 到 cc 的表
   */
  private seedNodes(): Map<string, string> {
    const out = new Map<string, string>();
    const byColo = (S.seed && S.seed.byColo) || {};
    for (const [cc, bucket] of Object.entries(byColo)) {
      for (const n of bucket?.nodes || []) {
        const k = n.k || `${n.h}:${n.p}`;
        if (!out.has(k)) out.set(k, String(n.cc || cc).toUpperCase());
      }
    }
    return out;
  }

  /**
   * 功能：响应 GET /<uuid>/regions。
   * @returns JSON：节点清单 + 覆盖率统计
   */
  run(): Response {
    const { url } = this.c;
    const now = Date.now();
    // 目标站点由用户传入（任意 URL/域名），不带就只列节点、不算目标延迟
    const target = (url.searchParams.get("site") || "").slice(0, 256);
    const alive = new AliveBoard().list();
    const seeds = this.seedNodes();
    const keys = [...new Set([...alive.map((n) => `${n.h}:${n.p}`), ...seeds.keys()])];
    const colo = S.colo || "??";
    const rows: RegionNodeRow[] = keys.map((key) => {
      // 用共享解析器拆 host:port，避免内联 lastIndexOf 误伤 IPv6（第 265 组门禁）
      const [h, p] = splitRelay(key, 443);
      const seedCc = seeds.get(key) || "";
      const live = alive.find((n) => `${n.h}:${n.p}` === key);
      const q = QUALITY.getFor(h, p, now);
      const cov = COVERAGE.rows.get(key);
      return {
        key,
        country: String((live?.cc || seedCc) || "").toUpperCase(),
        family: this.familyOf(h),
        alive: !!live,
        source: live && seedCc ? "alive+seed" : live ? "alive" : "seed",
        kind: q?.kind ?? IpKind.Unknown,
        level: q?.level ?? "normal",
        proxy: q?.proxy ?? false,
        vpn: q?.vpn ?? false,
        probed: !!cov,
        rtt: target ? CONN_OBS.rttOf(colo, key, target, now) : null,
      };
    });
    // Good 优先、Risky 排后，其余按 cc/key 稳定排序，让用户一眼看到可优选节点
    const rank: Record<string, number> = { good: 0, normal: 1, risky: 2 };
    rows.sort((a, b) => (rank[a.level] - rank[b.level]) || a.country.localeCompare(b.country) || a.key.localeCompare(b.key));
    return json({
      nodes: rows,
      coverage: COVERAGE.stats(keys),
      target,
      // 只给前 32 个节点算统计明细（nsOf 会算分，整池算太贵）
      sample: Object.keys(nsOf(keys.slice(0, 32), 32)).length,
    });
  }
}

/** 路由入口：/<uuid>/regions（同步渲染，包成 Promise 对齐其它路由签名） */
export function regions(c: UserCtx): Promise<Response> {
  return Promise.resolve(new RegionsView(c).run());
}
