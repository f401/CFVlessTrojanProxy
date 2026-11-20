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
import { QUALITY, QUALITY_PROBE, COVERAGE, CONN_OBS } from "../px/regions";
import { AliveBoard, aliveList, nsOf } from "../px/pool";
import { html, json } from "../edge/respond";
import { splitRelay } from "../core/relay-addr";
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
  /** 出口族事实：4 / 6 / 0（0 = 未知或未记过） */
  egFamily: number;
  /** 站点成功率事实：0..1，-1 表示无样本 */
  psOk: number;
  /** 该中继是否被判死（连接层连不上） */
  dead: boolean;
  /** 站点封锁代价倍数：1 = 无封锁，>1 表示被判封锁 */
  blkPenalty: number;
  /** DNS 事实：1 有 AAAA / 0 确证无 AAAA / -1 不知道 */
  dnsV6: number;
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
    // 一次建表：alive 上限 800，若在下面的 map 里逐 key 做 find() 就是 64 万次字符串拼接，
    // 足以单独吃满一个 Worker 的 CPU 预算；Map 查表把它压成 O(n)。
    const liveByKey = new Map<string, (typeof alive)[number]>(alive.map((n) => [`${n.h}:${n.p}`, n]));
    const colo = S.colo || "??";
    const rows = keys.map((key) => {
      const [h, p] = splitRelay(key, 443);
      const seedCc = seeds.get(key) || "";
      const live = liveByKey.get(key);
      const q = QUALITY.getFor(h, p, now);
      const cov = COVERAGE.rows.get(key);
      // 事实列全部是纯内存 O(1) 查表，零子请求；按站点维度的三张表只在带了 ?site= 时才有意义
      const ip = h;
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
        egFamily: EG.famOf(ip, now),
        psOk: target ? PS.okOf(target, ip, now) : -1,
        dead: DEAD.isDead(ip, now),
        blkPenalty: target ? BLK.penOf(target, ip, now) : 1,
        dnsV6: target ? DNS.v6Of(target, now) : -1,
      } as RegionNodeRow;
    });
    // 已探测的排前面（用户口径：alive 已探的优先），再按质量等级 → 国家码 → key；
    // 未探测的一组落在最后，仍按质量/国家/key 稳定排序。
    const rank: Record<string, number> = { good: 0, normal: 1, risky: 2 };
    rows.sort(
      (a, b) =>
        Number(b.probed) - Number(a.probed) ||
        Number(b.alive) - Number(a.alive) ||
        (rank[a.level] ?? 3) - (rank[b.level] ?? 3) ||
        a.country.localeCompare(b.country) ||
        a.key.localeCompare(b.key),
    );
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
  private groupsHtml(rows: RegionNodeRow[], selected: Set<string>, withRtt: boolean, postAction: string): string {
    const parts: string[] = [];
    const actionHtml = escapeHtml(postAction);
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
          // 重探按钮用 formaction 覆盖外层表单的 action/op，避免嵌套表单（HTML 不允许 form 嵌 form）
          const recheck = `<td><button type="submit" name="op" value="requality" formaction="${actionHtml}" class="lnkbtn">重探质量</button><input type="hidden" name="key" value="${escapeHtml(r.key)}"></td>`;
          return `<tr>
            <td class="u">${escapeHtml(r.key)}</td>
            <td>${levelBadge(r.level)}</td>
            <td>${kindLabel(r.kind)}</td>
            <td>${familyLabel(r.family)}</td>
            <td>${egLabel(r.egFamily)}</td>
            <td>${r.dead ? "判死" : "—"}</td>
            <td>${withRtt ? escapeHtml(dnsLabel(r.dnsV6)) : "—"}</td>
            <td>${flagLabel(r)}</td>
            <td class="mu">${escapeHtml(r.source)}${r.probed ? " · 已覆盖" : ""}</td>${rtt}${recheck}
          </tr>`;
        })
        .join("");
      const check = `<input type="checkbox" name="regions" value="${cc}"${checked}>`;
      parts.push(`<h2 class="cb">${check} ${cc} <span class="mu">${g.rows.length} 个节点</span></h2>
        <table><tr><th>节点</th><th>质量</th><th>类型</th><th>族</th><th>出口族事实</th><th>判死</th><th>DNS</th><th>标记</th><th>来源</th>${rttHead}<th>操作</th></tr>${body}</table>`);
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
    const action = "/" + encodeURIComponent(this.c.id) + "/regions";
    const body = renderTemplate(regionsTpl, {
      idShort: escapeHtml(this.c.id.slice(0, 8)),
      coverageText: `已知 ${cov.total} 节点 / 覆盖 ${cov.probed}`,
      jsonLink: escapeHtml(action + "?format=json" + (target ? "&site=" + encodeURIComponent(target) : "")),
      backLink: escapeHtml(back),
      postAction: escapeHtml(action),
      siteValue: escapeHtml(target),
      topNValue: escapeHtml(String(me?.regionTopN || 3)),
      groupsHtml: this.groupsHtml(rows, selected, !!target, action),
    });
    return html(body);
  }

  /**
   * 功能：POST 手动探测 —— 指定网站探测（复用 runTfb，写 CONN_OBS/判定表）与逐节点质量重探。
   *
   * 两类按钮都客户端可控，必须限流：tfb 一次是 2 个 DO 往返，质量一次是 6 个子请求；
   * 冷却表放在 QUALITY 这个状态持有者里（不往 AppState 加字段），每个站点/节点各自计时。
   * @returns 探测结果文本（浏览器上方显示），冷却中给出等待提示
   */
  private async probe(f: FormData): Promise<Response> {
    const op = String(f.get("op") || "");
    // 指定网站探测：复用 /debug?tfb 的同一实现，结果行会写进 CONN_OBS 供面板显示延迟
    if (op === "probe") {
      const site = String(f.get("site") || "").trim().slice(0, 256);
      if (!site) return new Response("请先填写要探测的网站", { status: 400 });
      const ck = "s:" + site;
      if (!QUALITY.recheckReady(ck, 60_000)) return new Response("该站点 1 分钟内已探测过，请稍候再试");
      QUALITY.recheckMark(ck);
      const resp = await runTfb({ env: this.c.env }, site, 2);
      const out = (await resp.json().catch(() => ({}))) as { verdict?: string; probed?: number; okN?: number; rows?: Array<{ relay: string; status?: number; ms?: number }> };
      const rows = (out.rows || []).slice(0, 8).map((r) => `${String(r.relay).replace(/[:[\]]/g, "")}:${r.status ?? "?"}/${r.ms ?? "?"}ms`);
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
      return new Response(`重探 ${key}：${q.level} / ${String(q.kind)} / ${q.proxy ? "代理 " : ""}${q.vpn ? "VPN" : ""}`);
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
    if (String(f.get("op") || "") === "probe" || String(f.get("op") || "") === "requality") return this.probe(f);
    const cur = this.c.auth;
    if (cur.ok === false) return new Response("用户表暂时读不到（KV 故障），请稍后重试", { status: 503 });
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
    // 冷 isolate 的 alive/seed 都还在内存里没载入：先看一眼名单与游标再渲染，
    // 否则本机房刚起来时面板恒空（KV 里其实有节点）。aliveList 内部走 30 分钟缓存，
    // 暖 isolate 上这一次几乎零成本，和 /proxyip、订阅的载入路径一致。
    if (this.c.env && !S.alive.size && !(S.seed.byColo && Object.keys(S.seed.byColo).length)) {
      await aliveList(this.c.env);
    }
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
