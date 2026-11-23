/**
 * 诊断/浏览类只读路由：proxyip（池子报表）、debug（内部探针）、regions（地区节点浏览器）。
 */
export { proxyip } from "./proxyip";
export { debug } from "./debug";

import { IpFamily, IpKind } from "../core/enums";
import { S } from "../core/state";
import { QUALITY, QUALITY_PROBE, COVERAGE, CONN_OBS } from "../px/regions";
import { AliveBoard, aliveList, ensurePool, nsOf } from "../px/pool";
import { geoLabel } from "../px/probe";
import { html, json } from "../edge/respond";
import { splitRelay, relayIpOf } from "../core/relay-addr";
import type { UserCtx } from "../edge/types";
import { escapeHtml, renderTemplate } from "../views/panel";
import { regionConfigList, saveUsers } from "../proxy/protocol";
import { runTfb } from "../route/tfb";
import { EG } from "../route/egfacts";
import { PS } from "../route/psfacts";
import { DEAD } from "../route/deadfacts";
import { BLK } from "../route/blkfacts";
import { DNS } from "../route/dnsfacts";
import regionsTpl from "../views/html/regions.html";

/** RFC 5737 文档地址段：不浪费子请求查、也避免测试假 IP 污染展示缓存 */
function isDocIp(h: string): boolean {
  return /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(h);
}

/** 给展示层补真实 ISO 国家码：alive.cc/seed 存的是 CF 机场码，按出口 IP 批量查真实码回填 */
async function ensureIsoCountries(): Promise<number> {
  // 只查 IPv4 出口（v6 字面量含冒号，第三方源对它的字段不稳定），alive ∪ seed 去重
  const hosts = new Set<string>();
  for (const n of S.alive.values()) if (n.h && !n.h.includes(":")) hosts.add(n.h);
  const byColo = (S.seed && S.seed.byColo) || {};
  for (const bucket of Object.values(byColo)) {
    for (const n of bucket?.nodes || []) if (n.h && !n.h.includes(":")) hosts.add(n.h);
  }
  // 已缓存/负缓存内的都不重查（否则每 GET 重发 ip-api，1102 累积源）；geoLabel 单次≤100 IP，超出下轮补。
  const need = [...hosts].filter((h) => QUALITY.isoNeeded(h) && !isDocIp(h)).slice(0, 100);
  if (!need.length) return 0;
  for (const h of need) QUALITY.markIsoTried(h);
  const iso = await geoLabel(need);
  let n = 0;
  // 结果写进展示专用表，绝不碰选路用的 alive.cc（那边存的是 CF 机场码）
  for (const [h, cc] of Object.entries(iso)) { QUALITY.noteIso(h, cc); n++; }
  return n;
}

/**
 * 功能：根据单节点探测的状态码与响应字节，得出「连通 / 被 ban」的诊断结论。
* @param status HTTP 状态码（0 = 无应答）
* @param bytes 响应字节数
* @returns 中文结论
 */
export function nodeCheckConclusion(status: number, bytes: number): string {
  if (status >= 200 && status < 400) return "连通正常";
  if (status === 403 && bytes > 0 && bytes <= 2048) return "疑似被 ban（小响应 403，族拒绝）";
  if (status >= 400) return "HTTP " + status + "（可能被拒绝或业务 403）";
  return "无应答（连不上或超时）";
}

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

/**
 * 功能：从存活表/seed 名单里查一个通道（IP / host:port / direct）的国家码，给探测结果标注出口国家。
* @param relay 通道名："direct" / 纯 IP / host:port
* @returns 两位大写国家码；查不到返回空串
 */
export function countryOf(relay: string): string {
  if (relay === "direct") return String(S.colo || "").toUpperCase();
  const [host] = splitRelay(relay, 443);
  // 展示优先真实 ISO 码：alive.cc / seed 桶键是机场码，不能当出口国家
  const iso = QUALITY.getIso(host);
  if (iso) return iso;
  // 先按完整 key 命中，再按 host 扫存活表（探测结果可能只带 IP 不带端口）
  const exact = S.alive.get(relay) || S.alive.get(host + ":443");
  if (exact?.cc) return String(exact.cc).toUpperCase();
  for (const node of S.alive.values()) {
    if (node.h === host && node.cc) return String(node.cc).toUpperCase();
  }
  const byColo = (S.seed && S.seed.byColo) || {};
  for (const [cc, bucket] of Object.entries(byColo)) {
    for (const n of bucket?.nodes || []) {
      if ((n.h === host || n.k === relay) && (n.cc || cc)) return String(n.cc || cc).toUpperCase();
    }
  }
  return "";
}

/**
 * 功能：把国家码渲染成探测结果里的方括号前缀（查不到就不显示，避免每行都挂「??」）。
 * @param cc 两位国家码或空串
 * @returns "[US] " 或空串
 */
export function ccTag(cc: string): string {
  return cc ? "[" + cc + "] " : "";
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
 * 功能：出口族事实的可读标签（0 = 未知）。
 * @param f 出口族 4 / 6 / 0
 * @returns 可读文本
 */
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

/**
 * 功能：地区节点浏览器 —— 列出 alive ∪ seed 的全部已知节点及其质量/族/覆盖/目标延迟。
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
    // 重建 1600 行 + ICU 排序在 CF 上逼近 10ms CPU（TTL 到期即 1102）；缓存 30 秒且命中只看寿命，后台 probe 改 alive 也不触发重建（面板允许短暂陈旧，POST 探测会主动失效）。
    const now = Date.now();
    const aliveSig = [...S.alive.keys()].join(",");
    const poolSig = S.pool.map((x) => `${x.h}:${x.p}`).join(",");
    const seedSig = Object.values(S.seed?.byColo || {}).map((c) => (c.nodes || []).map((n) => n.k).join(",")).join("|");
    const key = `${aliveSig}|${poolSig}|${seedSig}`; void key; // 指纹仅作写回标记，不参与命中：后台 probe 改 alive 让 key 每次变 → 每次重建 → 1102
    const cache = S.regionRowsCache;
    let rows = cache && now - cache.t < 30000 ? (cache.rows as RegionNodeRow[]) : null;
    if (!rows) {
      const alive = new AliveBoard().list();
      const seeds = this.seedNodes();
      const keys = [...new Set([...alive.map((n) => `${n.h}:${n.p}`), ...seeds.keys(), ...S.pool.map((x) => `${x.h}:${x.p}`)])];
      // alive 上限 800，逐 key find() 是 64 万次拼接；Map 查表把它压成 O(n)。
      const liveByKey = new Map<string, (typeof alive)[number]>(alive.map((n) => [`${n.h}:${n.p}`, n]));
      rows = keys.map((key) => {
        const [h, p] = splitRelay(key, 443), ip = h, seedCc = seeds.get(key) || "", live = liveByKey.get(key);
        const q = QUALITY.getFor(h, p, now), cov = COVERAGE.rows.get(key), isoCc = QUALITY.getIso(h);
        return {
          key,
          country: String(isoCc || live?.cc || seedCc || "").toUpperCase(),
          family: this.familyOf(h),
          alive: !!live,
          source: live && seedCc ? "alive+seed" : live ? "alive" : "seed",
          kind: q?.kind ?? IpKind.Unknown,
          level: q?.level ?? "normal",
          proxy: q?.proxy ?? false,
          vpn: q?.vpn ?? false,
          probed: !!cov || !!q,
          rtt: null,
          egFamily: EG.famOf(ip, now),
          psOk: -1,
          dead: DEAD.isDead(ip, now),
          blkPenalty: 1,
          dnsV6: -1,
        } as RegionNodeRow;
      });
      // 已探测在前，再按质量等级 → 国家 → key 稳定排序。
      const rank: Record<string, number> = { good: 0, normal: 1, risky: 2 };
      rows.sort(
        (a, b) =>
          Number(b.probed) - Number(a.probed) ||
          Number(b.alive) - Number(a.alive) ||
          (rank[a.level] ?? 3) - (rank[b.level] ?? 3) ||
          (a.country < b.country ? -1 : a.country > b.country ? 1 : 0) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
      S.regionRowsCache = { t: now, key, rows };
    }
    // 四个站点相关列按 target 补算：换 site 只走 4 次 O(1) 查表，不重建 1600 行。
    const coloNow = S.colo || "??";
    const v6 = target ? DNS.v6Of(target, now) : -1;
    for (const r of rows) {
      const ip = target ? relayIpOf(r.key) : "";
      r.rtt = target ? CONN_OBS.rttOf(coloNow, r.key, target, now) : null;
      r.psOk = target ? PS.okOf(target, ip, now) : -1;
      r.blkPenalty = target ? BLK.penOf(target, ip, now) : 1;
      r.dnsV6 = v6;
    }
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
  * @param pinnedSelected 已勾选的具体节点（host:port 键，回填用）
  * @param withRtt 是否显示目标站延迟列
  * @returns 已转义的 HTML 片段
   */
  private groupsHtml(rows: RegionNodeRow[], selected: Set<string>, pinnedSelected: Set<string>, withRtt: boolean, postAction: string): string {
    const parts: string[] = [];
    // 探测按钮是 type="button" + 面板脚本 fetch，不再需要 formaction；postAction 由 htmlView 走 postActionJson 传给脚本
    void postAction;
    // 一个国家一个勾选框 + 一张表：勾选状态回填，避免用户保存时丢掉已选地区
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
          // type="button" + 自带 data-key：submit 竞态会 abort fetch（NetworkError），共享隐藏 key 只会拿到第一行
          const recheck = `<td><button type="button" name="op" value="requality" data-probe="1" data-key="${escapeHtml(r.key)}" class="lnkbtn">重探质量</button></td>`;
          // 对指定节点测用户在「节点连通测试」框里填的网站：按钮 value 带节点 key，网站走表单的 checkSite 字段
          const nodecheck = `<td><button type="button" name="op" value="nodecheck:${escapeHtml(r.key)}" data-probe="1" class="lnkbtn">测连通</button></td>`;
          // 具体节点勾选：回填已 pin 的行；保存后订阅里单独成组（只进手动组，不改默认选路）
          const pinnedChecked = pinnedSelected.has(r.key) ? " checked" : "";
          // 出站 IP 单独成列：key 就是 host:port，抽 host 出来高亮，便于一眼确认出口地址
          const [exitIp] = splitRelay(r.key, 443);
          return `<tr data-node="${escapeHtml(r.key)}" data-probed="${r.probed ? 1 : 0}">
            <td><input type="checkbox" name="pinnedNodes" value="${escapeHtml(r.key)}"${pinnedChecked}></td>
            <td class="u">${escapeHtml(r.key)}</td>
            <td>${escapeHtml(r.country || "—")}</td>
            <td class="ipx">${escapeHtml(exitIp)}</td>
            <td data-cell="level">${levelBadge(r.level)}</td>
            <td data-cell="kind">${kindLabel(r.kind)}</td>
            <td>${familyLabel(r.family)}</td>
            <td>${egLabel(r.egFamily)}</td>
            <td>${r.dead ? "判死" : "—"}</td>
            <td>${withRtt ? escapeHtml(dnsLabel(r.dnsV6)) : "—"}</td>
            <td>${flagLabel(r)}</td>
            <td class="mu" data-cell="source">${escapeHtml(r.source)}${r.probed ? " · 已覆盖" : ""}</td>${rtt}${recheck}${nodecheck}
          </tr>`;
        })
        .join("");
      const check = `<input type="checkbox" name="regions" value="${cc}"${checked}>`;
      // 已知地区按国家分组后，组头直接标出该国有多少节点探过（已知），还是全未探测
      const probedN = g.rows.filter((r) => r.probed).length;
      const groupBadge = probedN ? `<span class="b g">已知 ${probedN}</span>` : `<span class="b u">未探测</span>`;
      parts.push(`<h2 class="cb cgroup">${check} ${cc} ${groupBadge} <span class="mu">${g.rows.length} 个节点</span></h2>
        <table><tr><th>选</th><th>节点</th><th>国家</th><th>出站 IP</th><th>质量</th><th>类型</th><th>族</th><th>出口族事实</th><th>判死</th><th>DNS</th><th>标记</th><th>来源</th>${rttHead}<th>操作</th><th>连通测试</th></tr>${body}</table>`);
    }
    return parts.join("") || '<div class="mu">本 isolate 还没有探到任何节点（稍后刷新重试）</div>';
  }

  /**
   * 功能：渲染自助面板 HTML。
  * @param rows 展示行
  * @param target 目标站点
  * @returns HTML 响应
   */
  private htmlView(rows: RegionNodeRow[], target: string, page: number, pages: number, total: number): Response {
    // 只回填当前用户自己的地区/节点数；其他用户配置和表单 action 一律不含
    const me = this.c.auth.list.find((x) => x.id === this.c.id);
    const selected = new Set((me?.regions || []).map((x) => String(x).toUpperCase()));
    const pinnedSelected = new Set((me?.pinnedNodes || []).map((x) => String(x)));
    const back = "/" + encodeURIComponent(this.c.id) + (this.c.pageKey ? "?k=" + encodeURIComponent(this.c.pageKey) : "");
    const cov = COVERAGE.stats(rows.map((r) => r.key));
    // 模板占位符全部 escapeHtml；groupsHtml 由分组函数自己保证转义
    const action = "/" + encodeURIComponent(this.c.id) + "/regions";
    const body = renderTemplate(regionsTpl, {
      idShort: escapeHtml(this.c.id.slice(0, 8)),
      coverageText: `已知 ${cov.total} 节点 / 覆盖 ${cov.probed}`,
      jsonLink: escapeHtml(action + "?format=json" + (target ? "&site=" + encodeURIComponent(target) : "")),
      backLink: escapeHtml(back),
      postAction: escapeHtml(action),
      // 给面板脚本 fetch 用：JSON 字符串字面量（含引号），action 由 UUID 构造不含引号，安全
      postActionJson: JSON.stringify(action),
      siteValue: escapeHtml(target),
      topNValue: escapeHtml(String(me?.regionTopN || 3)),
      pageInfo: `第 ${page}/${pages} 页 · 共 ${total} 节点`,
      prevHref: escapeHtml(action + "?page=" + (page - 1) + (target ? "&site=" + encodeURIComponent(target) : "")),
      nextHref: escapeHtml(action + "?page=" + (page + 1) + (target ? "&site=" + encodeURIComponent(target) : "")),
      hasPrev: page > 1 ? "1" : "",
      hasNext: page < pages ? "1" : "",
      groupsHtml: this.groupsHtml(rows, selected, pinnedSelected, !!target, action),
    });
    return html(body);
  }

  /**
   * 功能：POST 手动探测 —— 指定网站探测（复用 runTfb，写 CONN_OBS/判定表）与逐节点质量重探。
  * @returns 探测结果文本（浏览器上方显示），冷却中给出等待提示
   */
  private async probe(f: FormData): Promise<Response> {
    const op = String(f.get("op") || "");
    // 探测结果要给每个节点标国家码，而国家码只在本机 alive/seed 内存里。
    // POST 可能落到没 GET 过的 isolate（那里 S.alive/S.seed 是空的），先惰性载入，
    // 和 GET 路径一致；aliveList 带 30 分钟缓存，暖 isolate 几乎零成本。
    if (this.c.env && !S.alive.size && !(S.seed.byColo && Object.keys(S.seed.byColo).length)) {
      await aliveList(this.c.env);
    }
    if (this.c.env && !S.pool.length) await ensurePool(this.c.env); // 冷 isolate 池空则载入，否则「列全池」只剩 alive
    await ensureIsoCountries();
    // 指定网站探测：复用 /debug?tfb 的同一实现，结果行会写进 CONN_OBS 供面板显示延迟
    if (op === "probe") {
      const site = String(f.get("site") || "").trim().slice(0, 256);
      if (!site) return new Response("请先填写要探测的网站", { status: 400 });
      // 勾选节点批量探测：nodes 是逗号分隔的 host:port；没勾就回退全池自动挑（原行为）。最多 12 条守 DO 预算
      const picked = f.getAll("nodes").map(String).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean).slice(0, 12);
      const list = picked.join(",");
      const n = picked.length || 2;
      const ck = "s:" + site + (list ? "|" + list : "");
      if (!QUALITY.recheckReady(ck, 60_000)) return new Response("该站点 1 分钟内已探测过，请稍候再试");
      QUALITY.recheckMark(ck);
      const resp = await runTfb({ env: this.c.env }, site, n, list, Math.min(12, Math.max(3, n)));
      const out = (await resp.json().catch(() => ({}))) as { verdict?: string; probed?: number; okN?: number; rows?: Array<{ relay: string; status?: number; ms?: number }> };
      // 只去 IPv6 的方括号，不能把 host:port 的冒号也删掉（否则出现 45.136.117.194443 这种粘连）；
      // 每行前置出口国家码（从存活表/seed 查，零子请求），让「探测完显示国家」在结果里可见
      const rows = (out.rows || []).slice(0, 8).map((r) => {
        const relay = String(r.relay);
        const cc = ccTag(countryOf(relay));
        return `${cc}${relay.replace(/[[\]]/g, "")}:${r.status ?? "?"}/${r.ms ?? "?"}ms`;
      });
      return new Response(`探测 ${site}：${out.verdict || "?"} ${out.okN ?? 0}/${out.probed ?? 0} 成功\n` + rows.join("\n"));
    }
    // 逐节点质量重探：复用 QualityProbe.qualityOf（6 源合并），缓存 3 天，手动可强制刷新
    if (op === "requality") {
      const key = String(f.get("key") || "").trim().slice(0, 256);
      if (!key) return new Response("缺少节点", { status: 400 });
      const qk = "q:" + key;
      if (!QUALITY.recheckReady(qk, 60_000)) return new Response("该节点 1 分钟内已重探过，请稍候再试");
      QUALITY.recheckMark(qk);
      const [h] = splitRelay(key, 443);
      const fam = h.includes(":") ? IpFamily.IPv6 : IpFamily.IPv4;
      const q = await QUALITY_PROBE.qualityOf(key, h, this.c.budget, fam);
      // 标签拼成数组再过滤空值：proxy/vpn 都否定时不能留下悬空的「 / 」（用户看到的"奇怪东西"）
      const tags = [String(q.level), String(q.kind), q.proxy ? "代理" : "", q.vpn ? "VPN" : ""].filter(Boolean);
      const cc = ccTag(countryOf(key));
      // 面板按钮带 json=1：返回结构化结果供前端回填表格对应行，不跳转；文本路径保持不变（兼容旧测试/脚本）
      if (String(f.get("json") || "") === "1") {
        return Response.json({ ok: true, key, cc, level: String(q.level), kind: String(q.kind), proxy: !!q.proxy, vpn: !!q.vpn, label: tags.join(" / "), badge: levelBadge(String(q.level)), kindHtml: kindLabel(q.kind as IpKind) });
      }
      return new Response(`重探 ${cc}${key}：${tags.join(" / ")}`);
    }
    // 对指定节点测用户输入的网站：钉一条中继跑 runTfb，看连通与是否被 ban。
    // 只做诊断展示，不额外写封禁（runTfb 内部仍按「两批共识 + 有 2xx」的硬规则写判定表）。
    if (op.startsWith("nodecheck:")) {
      const key = op.slice("nodecheck:".length).trim().slice(0, 256);
      const site = String(f.get("checkSite") || "").trim().slice(0, 256);
      if (!key || !site) return new Response("缺少节点或网站", { status: 400 });
      const ck = "nc:" + key + ":" + site;
      if (!QUALITY.recheckReady(ck, 60_000)) return new Response("该节点对该站 1 分钟内已测过，请稍候再试");
      QUALITY.recheckMark(ck);
      const resp = await runTfb({ env: this.c.env }, site, 1, key);
      const out = (await resp.json().catch(() => ({}))) as {
        verdict?: string;
        rows?: Array<{ relay: string; ok: boolean; status?: number; bytes?: number; ms?: number }>;
      };
      const ip = relayIpOf(key);
      const row = (out.rows || []).find((r) => relayIpOf(String(r.relay)) === ip);
      const status = row?.status || 0;
      const bytes = row?.bytes || 0;
      // 737B「IPv6」这类族拒绝是小响应 403；业务 403 通常是整页，靠 body 大小只做诊断标签
      const conclusion = nodeCheckConclusion(status, bytes);
      const cc = ccTag(countryOf(key));
      return new Response("节点 " + cc + key + " → " + site + "\n结论：" + conclusion + "\n状态码：" + (status || "无") + " 字节：" + (bytes || "无") + " 耗时：" + (row?.ms ?? "无") + "ms\n判定：" + (out.verdict || "?"));
    }
    return new Response("未知操作", { status: 400 });
  }

  /**
   * 功能：POST 自助写回 —— 只改当前用户的地区配置，写进该用户的托管记录。
   * @returns 303 回到面板；用户表读失败或用户不存在时给对应状态码
   */
  private async post(): Promise<Response> {
    const f = await this.c.request.formData();
    // 探测类 POST 不改用户配置，也不依赖用户表可读性；单独分派
    const opRaw = String(f.get("op") || "");
    if (opRaw === "probe" || opRaw === "requality" || opRaw.startsWith("nodecheck:")) return this.probe(f);
    const cur = this.c.auth;
    if (cur.ok === false) return new Response("用户表暂时读不到（KV 故障），请稍后重试", { status: 503 });
    const regions = f.getAll("regions").map(String);
    const topN = Number(f.get("topN")) || 3;
    const targetHost = String(f.get("targetHost") || "");
    const pinnedNodes = f.getAll("pinnedNodes").map(String);
    const chosen = regionConfigList(cur, this.c.id, regions, topN, targetHost, pinnedNodes);
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
    if (this.c.request && this.c.request.method === "POST") {
      S.regionRowsCache = null; // 探测/写配置改了事实，下一次 GET 必须重建行，不能被 5 秒缓存挡住
      return this.post();
    }
    // 冷 isolate 的 alive/seed 都还在内存里没载入：先看一眼名单与游标再渲染，
    // 否则本机房刚起来时面板恒空（KV 里其实有节点）。aliveList 内部走 30 分钟缓存，
    // 暖 isolate 上这一次几乎零成本，和 /proxyip、订阅的载入路径一致。
    if (this.c.env && !S.alive.size && !(S.seed.byColo && Object.keys(S.seed.byColo).length)) {
      await aliveList(this.c.env);
    }
    if (this.c.env && !S.pool.length) await ensurePool(this.c.env); // 冷 isolate 池空则载入，否则「列全池」只剩 alive
    await ensureIsoCountries();
    const target = (this.c.url.searchParams.get("site") || "").slice(0, 256);
    const rows = this.rows(target);
    if (this.c.url.searchParams.get("format") === "json") return this.jsonView(rows, target);
    // 全池可达 1600 条：服务端分页，避免一次性渲染数 MB HTML；JSON 仍返回全量
    const size = 40, pages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(pages, Math.max(1, Number(this.c.url.searchParams.get("page")) || 1));
    return this.htmlView(rows.slice((page - 1) * size, page * size), target, page, pages, rows.length);
  }
}

/** 路由入口：/<uuid>/regions（异步，POST 写回要走 KV） */
export function regions(c: UserCtx): Promise<Response> {
  return new RegionsView(c).run();
}
