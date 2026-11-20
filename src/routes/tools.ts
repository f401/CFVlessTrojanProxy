/**
 * 诊断/浏览类只读路由：proxyip（池子报表）、debug（内部探针）、regions（地区节点浏览器）。
 *
 * 为什么 regions 放在这里而不是新文件：源码文件数卡在 115 的门禁上限，新建文件会立刻变红；
 * 而 regions 与这两个邻居一样是「只读、不花 DO/KV 额度」的诊断端点，放一起语义一致。
 * 例外：用户自助改地区配置时会走一次 KV 写回（saveUsers），那是一轮唯一一次写。
 */
export { proxyip } from "./proxyip";
export { debug } from "./debug";

import { IpFamily, IpKind } from "../core/enums";
import { S } from "../core/state";
import { QUALITY, COVERAGE, CONN_OBS } from "../px/regions";
import { AliveBoard, nsOf } from "../px/pool";
import { html, json } from "../edge/respond";
import { splitRelay } from "../core/relay-addr";
import type { UserCtx } from "../edge/types";
import { escapeHtml, renderTemplate } from "../views/panel";
import { regionConfigList, saveUsers } from "../proxy/protocol";
import regionsTpl from "../views/html/regions.html";

/** 单个节点在浏览器里的展示行 */
export interface RegionNodeRow {
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
 * 功能：把质量等级渲染成带文字的徽章（不只靠颜色，色弱/黑白屏也能读）。
 * @param level 质量等级字符串
 * @returns 已转义的 HTML 片段
 */
export function levelBadge(level: string): string {
  const map: Record<string, [string, string]> = {
    good: ["g", "良好"],
    normal: ["n", "一般"],
    risky: ["r", "风险"],
    unknown: ["u", "未探"],
  };
  const [cls, text] = map[String(level)] || map.unknown;
  return `<span class="b ${cls}">${text}</span>`;
}

/**
 * 功能：把线路类型枚举翻译成中文标签，并附上原始值（便于对照探测源数据）。
 * @param kind 线路类型枚举
 * @returns 已转义的 HTML 片段
 */
export function kindLabel(kind: IpKind): string {
  const map: Record<string, string> = {
    residential: "住宅",
    mobile: "移动",
    business: "企业",
    hosting: "机房",
    unknown: "未知",
  };
  const raw = String(kind);
  return `${escapeHtml(map[raw] || "未知")} <span class="mu">${escapeHtml(raw)}</span>`;
}

/**
 * 功能：地址族的可读标签。
 * @param f 地址族枚举
 * @returns "IPv4" 或 "IPv6"
 */
export function familyLabel(f: IpFamily): string {
  return f === IpFamily.IPv6 ? "IPv6" : "IPv4";
}

/**
 * 功能：代理/VPN 标记（只标记、不降级 —— 与 IpLevel 的判定口径一致）。
 * @param r 节点展示行
 * @returns "代理 VPN" / "—"
 */
export function flagLabel(r: RegionNodeRow): string {
  const flags: string[] = [];
  if (r.proxy) flags.push("代理");
  if (r.vpn) flags.push("VPN");
  return flags.length ? escapeHtml(flags.join(" ")) : "—";
}

/**
 * 功能：把节点行按国家码分组，组按码字典序、组内沿用传入顺序（调用方已按质量排好）。
 * @param rows 节点展示行
 * @returns 分组数组（地区码可能为空，渲染时用「未知」占位）
 */
export function groupRows(rows: RegionNodeRow[]): { country: string; rows: RegionNodeRow[] }[] {
  const m = new Map<string, RegionNodeRow[]>();
  for (const r of rows) {
    const k = r.country || "??";
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([country, list]) => ({ country, rows: list }));
}

/**
 * 功能：地区节点浏览器 —— 列出 alive ∪ seed 的全部已知节点及其质量/族/覆盖/目标延迟。
 *
 * 为什么是一个类：这个端点要把四张来源不同的表（存活表、seed 名单、质量表、覆盖表）
 * 按同一个 key 拼成一行，还要处理「同一节点在两张表里都有」「补全 cc/family」的合并规则；
 * 把这些规则放在对象里，路由入口只剩一行 `new RegionsView(c).run()`。
 *
 * 额度纪律：GET 全程只读内存表，不发子请求、不碰 DO/KV（净增 0）；
 * POST 写回走一次 saveUsers（复用 loadUsers 已读到的 c.auth，不重复读 KV）。
 */
export class RegionsView {
  /** 用户上下文（url 取 site 参数、auth 取当前用户配置） */
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
   * 功能：拼出全部节点行（alive ∪ seed），按「质量等级 → 国家码 → key」稳定排序。
   * @param target 目标站点（空 = 不算 RTT）
   * @returns 展示行数组
   */
  private rows(target: string): RegionNodeRow[] {
    // 目标站延迟是可选的：没带 ?site= 时一条 RTT 都不算，省掉观测表遍历
    const now = Date.now();
    const alive = new AliveBoard().list();
    const seeds = this.seedNodes();
    // alive 与 seed 可能重复，按 key 去重后逐个补画像/覆盖/延迟
    const keys = [...new Set([...alive.map((n) => `${n.h}:${n.p}`), ...seeds.keys()])];
    const colo = S.colo || "??";
    const rows = keys.map((key) => {
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
      } as RegionNodeRow;
    });
    // 质量优先、再按国家码/key 排，保证同一批数据每次输出顺序一致
    const rank: Record<string, number> = { good: 0, normal: 1, risky: 2 };
    rows.sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3) || a.country.localeCompare(b.country) || a.key.localeCompare(b.key));
    return rows;
  }

  /**
   * 功能：JSON 输出（保留旧契约，?format=json 显式请求）。
   * @param rows 展示行
   * @param target 目标站点
   * @returns JSON 响应
   */
  private jsonView(rows: RegionNodeRow[], target: string): Response {
    const keys = rows.map((r) => r.key);
    return json({
      nodes: rows,
      coverage: COVERAGE.stats(keys),
      target,
      // 只给前 32 个节点算统计明细（nsOf 会算分，整池算太贵）
      sample: Object.keys(nsOf(keys.slice(0, 32), 32)).length,
    });
  }

  /**
   * 功能：把分组后的节点渲染成 HTML 表格（每组一个勾选框 + 明细表）。
   * @param rows 展示行
   * @param selected 已勾选的地区集合
   * @param withRtt 是否显示目标站延迟列
   * @returns 已转义的 HTML 片段
   */
  private groupsHtml(rows: RegionNodeRow[], selected: Set<string>, withRtt: boolean): string {
    const parts: string[] = [];
    // 一个国家一个勾选框 + 一张表：勾选状态回填，避免用户保存时丢掉已选地区
    for (const g of groupRows(rows)) {
      const cc = escapeHtml(g.country);
      const checked = selected.has(g.country) ? " checked" : "";
      const rttHead = withRtt ? "<th>到站延迟</th>" : "";
      const body = g.rows
        .map((r) => {
          // 每个字段都过 escapeHtml；延迟是数字，转成字符串后同样转义
          const rtt = withRtt ? `<td>${r.rtt == null ? "—" : escapeHtml(Math.round(r.rtt) + " ms")}</td>` : "";
          return `<tr>
            <td class="u">${escapeHtml(r.key)}</td>
            <td>${levelBadge(r.level)}</td>
            <td>${kindLabel(r.kind)}</td>
            <td>${familyLabel(r.family)}</td>
            <td>${flagLabel(r)}</td>
            <td class="mu">${escapeHtml(r.source)}${r.probed ? " · 已覆盖" : ""}</td>${rtt}
          </tr>`;
        })
        .join("");
      parts.push(`<h2 class="cb"><label><input type="checkbox" name="regions" value="${cc}"${checked}> ${cc}</label> <span class="mu">${g.rows.length} 个节点</span></h2>
        <table><tr><th>节点</th><th>质量</th><th>类型</th><th>族</th><th>标记</th><th>来源</th>${rttHead}</tr>${body}</table>`);
    }
    return parts.join("") || '<div class="mu">本 isolate 还没有探到任何节点（稍后刷新重试）</div>';
  }

  /**
   * 功能：渲染自助面板 HTML。
   * @param rows 展示行
   * @param target 目标站点
   * @returns HTML 响应
   */
  private htmlView(rows: RegionNodeRow[], target: string): Response {
    // 只回填当前用户自己的地区/节点数；其他用户配置和表单 action 一律不含
    const me = this.c.auth.list.find((x) => x.id === this.c.id);
    const selected = new Set((me?.regions || []).map((x) => String(x).toUpperCase()));
    const back = "/" + encodeURIComponent(this.c.id) + (this.c.pageKey ? "?k=" + encodeURIComponent(this.c.pageKey) : "");
    const cov = COVERAGE.stats(rows.map((r) => r.key));
    // 模板占位符全部 escapeHtml；groupsHtml 由分组函数自己保证转义
    const body = renderTemplate(regionsTpl, {
      idShort: escapeHtml(this.c.id.slice(0, 8)),
      coverageText: `已知 ${cov.total} 节点 / 覆盖 ${cov.probed}`,
      jsonLink: escapeHtml("/" + encodeURIComponent(this.c.id) + "/regions?format=json" + (target ? "&site=" + encodeURIComponent(target) : "")),
      backLink: escapeHtml(back),
      postAction: escapeHtml("/" + encodeURIComponent(this.c.id) + "/regions"),
      siteValue: escapeHtml(target),
      topNValue: escapeHtml(String(me?.regionTopN || 3)),
      groupsHtml: this.groupsHtml(rows, selected, !!target),
    });
    return html(body);
  }

  /**
   * 功能：POST 自助写回 —— 只改当前用户的地区配置，写进该用户的托管记录。
   * @returns 303 回到面板；用户表读失败或用户不存在时给对应状态码
   */
  private async post(): Promise<Response> {
    const cur = this.c.auth;
    if (cur.ok === false) return new Response("用户表暂时读不到（KV 故障），请稍后重试", { status: 503 });
    const f = await this.c.request.formData();
    const regions = f.getAll("regions").map(String);
    const topN = Number(f.get("topN")) || 3;
    const targetHost = String(f.get("targetHost") || "");
    const chosen = regionConfigList(cur, this.c.id, regions, topN, targetHost);
    if (!chosen.ok) return new Response(chosen.err, { status: 404 });
    await saveUsers(this.c.env, chosen.list);
    return new Response(null, { status: 303, headers: { location: "/" + encodeURIComponent(this.c.id) + "/regions" } });
  }

  /**
   * 功能：响应 /<uuid>/regions —— POST 写回，默认 HTML，?format=json 兼容旧输出。
   * @returns 响应
   */
  async run(): Promise<Response> {
    // 有些只读探针只给 url/id、不带 request；缺 request 一律按 GET 处理
    if (this.c.request && this.c.request.method === "POST") return this.post();
    const target = (this.c.url.searchParams.get("site") || "").slice(0, 256);
    const rows = this.rows(target);
    if (this.c.url.searchParams.get("format") === "json") return this.jsonView(rows, target);
    return this.htmlView(rows, target);
  }
}

/** 路由入口：/<uuid>/regions（异步，POST 写回要走 KV） */
export function regions(c: UserCtx): Promise<Response> {
  return new RegionsView(c).run();
}
