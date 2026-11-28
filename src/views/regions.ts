import { IpFamily } from "../core/enums";
import type { IpKind } from "../core/enums";
import { splitRelay } from "../core/relay-addr";
import { escapeHtml, renderTemplate } from "./panel";
import regionsTpl from "./html/regions.html";

/** 单个节点在浏览器里的展示行 */
export interface RegionNodeRow {
  key: string;        // host:port 键（订阅 `?node=` 用这个值）
  country: string;    // 国家码，空 = 未知地区
  family: IpFamily;   // v4 / v6
  alive: boolean;     // 是否在本 isolate 存活表
  source: string;     // 来源：alive / seed / 两者
  kind: IpKind;       // 质量种类，unknown = 未探过
  level: string;      // good / normal / risky
  proxy: boolean;     // 是否代理
  vpn: boolean;       // 是否 VPN
  org: string;        // IP 所属组织（客观属性，随质量表跨 isolate 传播）
  reach: number;      // 连通实测：1=可用 / -1=黑洞 / 0=未测（本 isolate CONN_OBS，不跨 isolate）
  probed: boolean;    // 覆盖账本里记过探测
  rtt: number | null; // 目标站点延迟（毫秒，null = 没测）
  egFamily: number;   // 出口族事实 4/6/0（0=未知）
  psOk: number;       // 站点成功率 0..1，-1=无样本
  dead: boolean;      // 是否被判死（连接层连不上）
  blkPenalty: number; // 封锁代价倍数，1=无封锁
  dnsV6: number;      // DNS 事实 1=有 AAAA/0=无/-1=不知道
}

/** 功能：把质量等级渲染成带文字徽章（不只靠颜色）；@param level 质量等级；@returns 已转义 HTML */
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

/** 功能：线路类型枚举翻译成中文标签并附原始值；@param kind 线路类型；@returns 已转义 HTML */
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

/** 功能：地址族可读标签；@param f 地址族枚举；@returns "IPv4" 或 "IPv6" */
export function familyLabel(f: IpFamily): string {
  return f === IpFamily.IPv6 ? "IPv6" : "IPv4";
}

/** 功能：把国家码渲染成探测结果里的方括号前缀（查不到就不显示，避免每行都挂「??」）。；@param cc 两位国家码或空串；@returns "[US] " 或空串 */
export function ccTag(cc: string): string {
  return cc ? "[" + cc + "] " : "";
}

/** 功能：代理/VPN 标记（只标记、不降级 —— 与 IpLevel 的判定口径一致）。；@param r 节点展示行；@returns "代理 VPN" / "—" */
export function flagLabel(r: RegionNodeRow): string {
  const flags: string[] = [];
  if (r.proxy) flags.push("代理");
  if (r.vpn) flags.push("VPN");
  return flags.length ? escapeHtml(flags.join(" ")) : "—";
}

/** 功能：出口族事实的可读标签（0 = 未知）。；@param f 出口族 4 / 6 / 0；@returns 可读文本 */
export function egLabel(f: number): string {
  return f === 4 ? "v4" : f === 6 ? "v6" : "—";
}

/**
 * 功能：站点成功率事实的可读标签，-1 表示无样本。
 * @param p 0..1 的成功率或 -1
 * @returns 可读文本
 */
export function psLabel(p: number): string {
  return p < 0 ? "—" : Math.round(p * 100) + "%";
}

/**
 * 功能：DNS AAAA 事实标签（1 有 / 0 无 / -1 不知道）。
 * @param v DNS 事实值
 * @returns 可读文本
 */
export function dnsLabel(v: number): string {
  return v === 1 ? "有" : v === 0 ? "无" : "—";
}

/**
 * 功能：把节点行按国家码分组，组按码字典序、组内沿用传入顺序（调用方已按质量排好）。
 * @param rows 节点展示行
 * @returns 分组数组（地区码可能为空，渲染时用「未知」占位）
 */
export function groupRows(rows: RegionNodeRow[]): { country: string; rows: RegionNodeRow[] }[] {
  const groups = new Map<string, RegionNodeRow[]>();
  // 所有国家都分桶（含未探过的），每个桶都要有勾选框：冷 isolate 里大部分节点没探过，
  // 若把未探的单独扔掉勾选框，用户就没法选地区了。已探/未探的先后用「组」和「行」两级排序表达。
  for (const r of rows) {
    const k = r.country || "??";
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  // rows() 已按 probed/alive/质量 排好，这里组内顺序原样保留；
  // 组级排序：有已探节点的国家在前，全未探的国家在后，各自按国家码字典序。
  return [...groups.entries()]
    .sort((a, b) => {
      const pa = a[1].some((r) => r.probed) ? 1 : 0;
      const pb = b[1].some((r) => r.probed) ? 1 : 0;
      return pb - pa || a[0].localeCompare(b[0]);
    })
    .map(([country, list]) => ({ country, rows: list }));
}

/** 功能：把分组节点渲染成表格；@param rows 展示行；@param selected 已选地区；@param pinnedSelected 已选节点；@param withRtt 显示延迟；@returns HTML */
export function renderRegionGroups(rows: RegionNodeRow[], selected: Set<string>, pinnedSelected: Set<string>, withRtt: boolean): string {
  const parts: string[] = [];
  // 每国一个勾选框+表：回填勾选，避免保存时丢掉已选地区
  for (const g of groupRows(rows)) {
    // 每个国家（含全未探的国家）都给勾选框：冷 isolate 里也必须能选地区
    const cc = escapeHtml(g.country);
    const checked = selected.has(g.country) ? " checked" : "";
    const rttHead = withRtt ? "<th>到站延迟</th><th>成功率</th><th>封锁</th>" : "";
    const body = g.rows
      .map((r) => {
        // 每个字段都过 escapeHtml；延迟是数字，转成字符串后同样转义
        const rtt = withRtt
          ? `<td>${r.rtt == null ? "—" : escapeHtml(Math.round(r.rtt) + " ms")}</td><td>${escapeHtml(psLabel(r.psOk))}</td><td>${r.blkPenalty > 1 ? "封锁" : "—"}</td>`
          : "";
        // type=button + data-key 避开 submit 竞态；value 带 key，网站走 checkSite 字段
        const recheck = `<td><button type="button" name="op" value="requality" data-probe="1" data-key="${escapeHtml(r.key)}" class="lnkbtn">重探质量</button></td>`;
        const nodecheck = `<td><button type="button" name="op" value="nodecheck:${escapeHtml(r.key)}" data-probe="1" class="lnkbtn">测连通</button></td>`;
        const pinnedChecked = pinnedSelected.has(r.key) ? " checked" : ""; // 回填已 pin；保存后进手动组
        const [exitIp] = splitRelay(r.key, 443); // 出站 IP 单独成列，便于确认出口地址
        return `<tr data-node="${escapeHtml(r.key)}" data-probed="${r.probed ? 1 : 0}" data-reach="${r.reach > 0 ? 1 : r.reach < 0 ? -1 : 0}" data-cc="${escapeHtml(g.country)}" data-search="${escapeHtml((r.key + " " + r.country + " " + r.org + " " + r.source).toLowerCase())}">
          <td><input type="checkbox" name="pinnedNodes" value="${escapeHtml(r.key)}"${pinnedChecked}></td>
          <td class="u">${escapeHtml(r.key)}</td>
          <td>${escapeHtml(r.country || "—")}</td>
          <td class="ipx">${escapeHtml(exitIp)}</td>
          <td data-cell="org">${escapeHtml(r.org || "—")}</td>
          <td data-cell="level">${levelBadge(r.level)}</td>
          <td data-cell="kind">${kindLabel(r.kind)}</td>
          <td>${familyLabel(r.family)}</td>
          <td>${egLabel(r.egFamily)}</td>
          <td>${r.dead ? "判死" : "—"}</td>
          <td>${withRtt ? escapeHtml(dnsLabel(r.dnsV6)) : "—"}</td>
          <td>${flagLabel(r)}</td>
          <td class="mu" data-cell="source">${escapeHtml(r.source)}${r.probed ? " · 已覆盖" : ""}${r.reach > 0 ? " · 可用" : r.reach < 0 ? " · 黑洞" : ""}</td>${rtt}${recheck}${nodecheck}
        </tr>`;
      })
      .join("");
    const check = `<input type="checkbox" name="regions" value="${cc}"${checked}>`;
    const probedN = g.rows.filter((r) => r.probed).length;
    const groupBadge = probedN ? `<span class="b g">已知 ${probedN}</span>` : `<span class="b u">未探测</span>`;
    parts.push(`<h2 class="cb cgroup" data-cc="${cc}"><button type="button" class="group-toggle" aria-label="展开或折叠 ${cc} 节点" aria-expanded="true"><span class="caret">▾</span></button>${check} ${cc} ${groupBadge} <span class="mu">${g.rows.length} 个节点</span></h2>
      <div class="tw"><table><tr><th>选</th><th>节点</th><th>国家</th><th>出站 IP</th><th>组织</th><th>质量</th><th>类型</th><th>族</th><th>出口族</th><th>判死</th><th>DNS</th><th>标记</th><th>来源</th>${rttHead}<th>操作</th><th>连通测试</th></tr>${body}</table></div>`);
  }
  return parts.join("") || '<div class="empty">本 isolate 还没有探到任何节点 · <a href="?rebuild=1">重建池子</a> 或稍后刷新</div>';
}

/** 地区页只读输入：展示层不读取状态表，也不触发网络或持久化写入。 */
interface RegionsPageInput {
  rows: RegionNodeRow[];
  userId: string;
  pageKey: string;
  regions: string[];
  pinnedNodes: string[];
  target: string;
  topN: number;
  page: number;
  pages: number;
  total: number;
  coveredCount: number;
  socksCount: number;
  socksOk: number;
}

/**
 * 功能：渲染地区页，保留分页之外的已选项及页面口令；不更改选路和事实状态。
 * @param input 当前用户配置、分页节点和覆盖计数
 * @returns 已安全插值的 HTML
 */
export function renderRegionsPage(input: RegionsPageInput): string {
  // 已选值全量来自当前用户；隐藏项只补当前页没有的值，避免重复提交与跨页丢失。
  const selected = new Set(input.regions.map(value => value.toUpperCase()));
  const pinned = new Set(input.pinnedNodes);
  const visibleCountries = new Set(input.rows.map(row => row.country || "??"));
  const visibleNodes = new Set(input.rows.map(row => row.key));
  const preserved: string[] = [];
  for (const [name, values, visible] of [
    ["regions", selected, visibleCountries], ["pinnedNodes", pinned, visibleNodes],
  ] as const) {
    for (const value of values) {
      if (!visible.has(value)) preserved.push(`<input type="hidden" name="${name}" value="${escapeHtml(value)}">`);
    }
  }
  // 所有表单、分页和 JSON 链接使用同一个构造器，避免 pageKey 在跳转时丢失。
  const action = "/" + encodeURIComponent(input.userId) + "/regions";
  const link = (params: Record<string, string>): string => {
    const query = new URLSearchParams(params);
    if (input.pageKey) query.set("k", input.pageKey);
    const suffix = query.toString();
    return action + (suffix ? "?" + suffix : "");
  };
  const siteParams: Record<string, string> = input.target ? { site: input.target } : {};
  return renderTemplate(regionsTpl, {
    idShort: escapeHtml(input.userId.slice(0, 8)),
    coverageText: `本页已知 ${input.rows.length} 节点 / 覆盖 ${input.coveredCount}`,
    jsonLink: escapeHtml(link({ format: "json", ...siteParams })),
    backLink: escapeHtml("/" + encodeURIComponent(input.userId) + (input.pageKey ? "?k=" + encodeURIComponent(input.pageKey) : "")),
    postAction: escapeHtml(link({})),
    siteValue: escapeHtml(input.target),
    topNValue: String(input.topN),
    pageInfo: `第 ${input.page}/${input.pages} 页 · 共 ${input.total} 节点`,
    prevHref: escapeHtml(link({ page: String(input.page - 1), ...siteParams })),
    nextHref: escapeHtml(link({ page: String(input.page + 1), ...siteParams })),
    hasPrev: input.page > 1 ? "1" : "",
    hasNext: input.page < input.pages ? "1" : "",
    groupsHtml: renderRegionGroups(input.rows, selected, pinned, !!input.target),
    preservedSelection: preserved.join(""),
    s5Text: escapeHtml(`通用出口（公共 SOCKS5）：${input.socksCount} 条 · 已验证 ${input.socksOk} 条`),
  });
}
