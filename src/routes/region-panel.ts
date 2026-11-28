/**
 * 地区节点面板：控制器（渲染 / 分页 / 探测动作 / 自助写回）与它的展示缓存。
 * 从 `routes/tools.ts` 抽出来的原因：那个文件同时挂着 proxyip 与 debug 的再导出，
 * 面板逻辑占了大半篇幅，改动时看不出「这一改会影响谁」。
 */
import { POOL_MEMORY } from "../px/pool-memory";
import { ISOLATE } from "../core/state";
import { SEED_STORE } from "../px/seed";
import { NODE_MEMORY } from "../core/node-memory";
import { IpFamily, IpKind } from "../core/enums";
import { QUALITY, qualityOf, COVERAGE, CONN_OBS } from "../px/regions";
import { aliveList, ensurePool, nsOf, AliveBoard } from "../px/pool";
import { SOCKS } from "../px/selector";
import { geoLabel, probeSni } from "../px/probe";
import { html } from "../edge/respond";
import { splitRelay, relayIpOf } from "../core/relay-addr";
import { CONNECT_MS } from "../core/util";
import type { UserCtx } from "../edge/types";
import { renderRegionsPage, levelBadge, kindLabel, ccTag } from "../views/regions";
import type { RegionNodeRow } from "../views/regions";
import { regionConfigList, saveUsers } from "../proxy/protocol";
import { runTfb } from "../route/tfb";
import { EG } from "../route/egfacts";
import { PS } from "../route/psfacts";
import { DEAD } from "../route/deadfacts";
import { BLK } from "../route/blkfacts";
import { DNS } from "../route/dnsfacts";

/** 地区页面单槽类型化缓存；行与 JSON 分开，均允许 30 秒展示陈旧。 */
export class RegionPageCache {
  /** 节点行缓存（30 秒）：站点相关列在渲染前才补算 */
  rows: { t: number; rows: RegionNodeRow[] } | null = null;
  /** JSON 文本缓存（5 秒）：同一份结果不重复序列化 */
  json: { t: number; key: string; text: string } | null = null;
  /** 功能：在寿命内返回基础行，站点投影由调用方复制。@param now 当前时间。@returns 行或 null */
  freshRows(now: number): RegionNodeRow[] | null {
    return this.rows && now - this.rows.t < 30000 ? this.rows.rows : null;
  }
  /** 功能：按目标与条数命中序列化缓存。@param key 请求键。@param now 当前时间。@returns JSON 或 null */
  freshJson(key: string, now: number): string | null {
    return this.json && this.json.key === key && now - this.json.t < 30000 ? this.json.text : null;
  }
}
/** 地区展示缓存所有者，不保存用户上下文或口令。 */
export const REGION_CACHE = new RegionPageCache();

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

/** 功能：从存活表/seed 名单里查一个通道（IP / host:port / direct）的国家码，给探测结果标注出口国家。；@param relay 通道名："direct" / 纯 IP / host:port；@returns 两位大写国家码；查不到返回空串 */
export function countryOf(relay: string): string {
  if (relay === "direct") return String(ISOLATE.colo || "").toUpperCase();
  const [host] = splitRelay(relay, 443);
  // 展示优先真实 ISO 码：alive.cc / seed 桶键是机场码，不能当出口国家
  const iso = QUALITY.getIso(host);
  if (iso) return iso;
  // 先按完整 key 命中，再按 host 扫存活表（探测结果可能只带 IP 不带端口）
  const exact = NODE_MEMORY.alive.get(relay) || NODE_MEMORY.alive.get(host + ":443");
  if (exact?.cc) return String(exact.cc).toUpperCase();
  for (const node of NODE_MEMORY.alive.values()) {
    if (node.h === host && node.cc) return String(node.cc).toUpperCase();
  }
  const byColo = (SEED_STORE.document && SEED_STORE.document.byColo) || {};
  for (const [cc, bucket] of Object.entries(byColo)) {
    for (const n of bucket?.nodes || []) {
      if ((n.h === host || n.k === relay) && (n.cc || cc)) return String(n.cc || cc).toUpperCase();
    }
  }
  return "";
}
/** RFC 5737 文档地址段：不浪费子请求查、也避免测试假 IP 污染展示缓存 */
function isDocIp(h: string): boolean {
  return /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(h);
}

/** 给展示层补真实 ISO 国家码：alive.cc/seed 存的是 CF 机场码，按出口 IP 批量查真实码回填 */
async function ensureIsoCountries(): Promise<number> {
  // 只查 IPv4 出口（v6 字面量含冒号，第三方源对它的字段不稳定），alive ∪ seed 去重
  const hosts = new Set<string>();
  for (const n of NODE_MEMORY.alive.values()) if (n.h && !n.h.includes(":")) hosts.add(n.h);
  const byColo = (SEED_STORE.document && SEED_STORE.document.byColo) || {};
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
    const byColo = (SEED_STORE.document && SEED_STORE.document.byColo) || {};
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
  private rows(): RegionNodeRow[] {
    // 重建 1600 行 + ICU 排序逼近 10ms CPU（TTL 到期即 1102）；缓存 30 秒、命中只看寿命，后台 probe 改 alive 不重建动失效）。
    const now = Date.now();
    let rows = REGION_CACHE.freshRows(now);
    if (!rows) {
      const alive = new AliveBoard().list();
      const seeds = this.seedNodes();
      const keys = [...new Set([...alive.map((n) => `${n.h}:${n.p}`), ...seeds.keys(), ...POOL_MEMORY.rows.map((x) => `${x.h}:${x.p}`)])];
      // alive 上限 800，逐 key find() 是 64 万次拼接；Map 压成 O(n)。
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
          org: q?.org || "",
          reach: 0,
          probed: !!cov || !!q,
          rtt: null,
          egFamily: EG.famOf(ip, now),
          psOk: -1,
          dead: DEAD.isDead(ip, now),
          blkPenalty: 1,
          dnsV6: -1,
        } as RegionNodeRow;
      });
      // 已探测在前，再按质量等级 → 国家 → key 排序。
      const rank: Record<string, number> = { good: 0, normal: 1, risky: 2 };
      rows.sort(
        (a, b) =>
          Number(b.probed) - Number(a.probed) ||
          Number(b.alive) - Number(a.alive) ||
          (rank[a.level] ?? 3) - (rank[b.level] ?? 3) ||
          (a.country < b.country ? -1 : a.country > b.country ? 1 : 0) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
      REGION_CACHE.rows = { t: now, rows };
    }
    return rows;
  }

  /** 功能：给要渲染的那几行补上站点相关列；@param rows 切片后的行；@param target 站点；@returns 同一批行 */
  private decorate(rows: RegionNodeRow[], target: string): RegionNodeRow[] {
    // 只补切片：整表 1600 行 × 5 次查表就是 1102 的来源之一
    const now = Date.now();
    const coloNow = ISOLATE.colo || "??";
    const v6 = target ? DNS.v6Of(target, now) : -1;
    // 基础行由缓存共享；派生站点字段写入新对象，避免本次展示污染下一次请求。
    return rows.map((r) => {
      const ip = relayIpOf(r.key);
      const reachRow = CONN_OBS.get(coloNow, r.key, "@reach", now);
      return { ...r, reach: reachRow ? (reachRow.ok ? 1 : -1) : 0,
        rtt: target ? CONN_OBS.rttOf(coloNow, r.key, target, now) : null,
        psOk: target ? PS.okOf(target, ip, now) : -1,
        blkPenalty: target ? BLK.penOf(target, ip, now) : 1, dnsV6: v6 };
    });
  }

  /** 功能：JSON 输出（?format=json 显式请求，?limit= 可收窄）；@param rows 展示行；@param target 站点；@returns JSON 响应 */
  private jsonView(rows: RegionNodeRow[], target: string): Response {
    const keys = rows.map((r) => r.key);
    const text = JSON.stringify({ // 紧凑序列化：带缩进的 650 KB 光 stringify 就吃满免费版 CPU
      nodes: rows,
      coverage: COVERAGE.stats(keys),
      target,
      sample: Object.keys(nsOf(keys.slice(0, 32), 32)).length, // 只算前 32 个（nsOf 会算分，整池太贵）
      s5: SOCKS.snap(), // 通用出口（公共 SOCKS5）：能到任意站点，与 CF 中继是两回事
    });
    return new Response(text, { headers: { "content-type": "application/json;charset=utf-8" } });
  }

  /** 功能：渲染自助面板 HTML；@param rows 展示行；@param target 站点；@returns HTML 响应 */
  private htmlView(rows: RegionNodeRow[], target: string, page: number, pages: number, total: number): Response {
    // 查询编排只组装当前用户的只读数据；HTML 与安全转义由视图层负责。
    const me = this.c.auth.list.find((x) => x.id === this.c.id);
    const cov = COVERAGE.stats(rows.map((r) => r.key));
    const socks = SOCKS.snap();
    return html(renderRegionsPage({ rows, target, page, pages, total, userId: this.c.id,
      pageKey: this.c.pageKey || "", regions: me?.regions || [], pinnedNodes: me?.pinnedNodes || [],
      topN: me?.regionTopN || 3, coveredCount: cov.probed, socksCount: socks.n, socksOk: socks.ok }));
  }

  /** 功能：POST 手动探测，指定网站走 runTfb、逐节点走质量重探；@returns 结果文本或等待提示 */
  private async probe(f: FormData): Promise<Response> {
    const op = String(f.get("op") || "");
    // POST 可能落到没 GET 过的 isolate：先惰性载入 alive/seed（aliveList 带 30 分钟缓存）。
    if (this.c.env && !NODE_MEMORY.alive.size && !(SEED_STORE.document.byColo && Object.keys(SEED_STORE.document.byColo).length)) {
      await aliveList(this.c.env);
    }
    if (this.c.env && !POOL_MEMORY.rows.length) await ensurePool(this.c.env); // 冷 isolate 池空则载入，否则「列全池」只剩 alive
    await ensureIsoCountries();
    if (op === "socks") { // 公共 SOCKS5 池：refill=1 先抓列表，再实测验证若干条（每条一次 connect）
      if (String(f.get("refill") || "") === "1") await SOCKS.refill(this.c.env);
      if (!SOCKS.snap().n) return new Response("公共代理池为空：请先抓取列表");
      const r = await SOCKS.verify(this.c.budget);
      return new Response(`公共代理：共 ${SOCKS.snap().n} 条，本轮验证成功 ${r.ok}、失败 ${r.bad}`);
    }
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
      const q = await qualityOf(key, h, this.c.budget, fam);
      // 质量只查 IP 情报不拨节点；补一次拨号（扣 connect 不占 sub），黑洞节点当场暴露
      const [rh, rp] = splitRelay(key, 443);
      const sn = await probeSni(rh, rp, "www.cloudflare.com", CONNECT_MS, this.c.budget);
      const reachable = !!sn.hs && !sn.err;
      CONN_OBS.note(ISOLATE.colo || "??", key, "@reach", reachable ? 200 : 0, sn.hs || 0, fam, Date.now());
      const tags = [String(q.level), String(q.kind), q.proxy ? "代理" : "", q.vpn ? "VPN" : ""].filter(Boolean);
      const cc = ccTag(countryOf(key));
      // 面板按钮带 json=1：返回结构化结果供前端回填表格对应行，不跳转；文本路径保持不变（兼容旧测试/脚本）
      if (String(f.get("json") || "") === "1") {
        return Response.json({ ok: true, key, cc, org: q.org || "", reachable, reachMs: sn.hs || 0, level: String(q.level), kind: String(q.kind), proxy: !!q.proxy, vpn: !!q.vpn, label: tags.join(" / "), badge: levelBadge(String(q.level)), kindHtml: kindLabel(q.kind as IpKind) });
      }
      return new Response(`重探 ${cc}${key}：${tags.join(" / ")}`);
    }
    // 对指定节点测用户输入的网站：钉一条中继跑 runTfb 看连通与被 ban；只诊断展示，runTfb 内部仍按「两批共识 + 有 2xx」写判定
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
    if (opRaw === "probe" || opRaw === "requality" || opRaw === "socks" || opRaw.startsWith("nodecheck:")) return this.probe(f);
    const cur = this.c.auth;
    if (cur.ok === false) return new Response("用户表暂时读不到（KV 故障），请稍后重试", { status: 503 });
    const regions = f.getAll("regions").map(String);
    const topN = Number(f.get("topN")) || 3;
    const targetHost = String(f.get("targetHost") || "");
    const pinnedNodes = f.getAll("pinnedNodes").map(String);
    const chosen = regionConfigList(cur, this.c.id, regions, topN, targetHost, pinnedNodes);
    if (!chosen.ok) return new Response(chosen.err, { status: 404 });
    await saveUsers(this.c.env, chosen.list);
    // 保存后的跳转仍需页面口令，否则配置成功却落到 403；保留无口令部署的原地址。
    const suffix = this.c.pageKey ? "?k=" + encodeURIComponent(this.c.pageKey) : "";
    return new Response(null, { status: 303, headers: { location: "/" + encodeURIComponent(this.c.id) + "/regions" + suffix } });
  }

  /**
   * 功能：响应 /<uuid>/regions —— POST 写回，默认 HTML，?format=json 兼容旧输出。
   * @returns 响应
   */
  async run(): Promise<Response> {
    // 有些只读探针只给 url/id、不带 request；缺 request 一律按 GET 处理
    if (this.c.request && this.c.request.method === "POST") {
      // 不在 POST 入口清整表缓存：重建 1600 行会累积触发 1102；四个站点相关列本就渲染时补算，节点列表/静态列靠 30 秒 TTL 自然过期。
      return this.post();
    }
    // 冷 isolate 先载名单再渲染，否则面板恒空；aliveList 自带 30 分钟缓存，暖 isolate 几乎零成本
    if (this.c.env && !NODE_MEMORY.alive.size && !(SEED_STORE.document.byColo && Object.keys(SEED_STORE.document.byColo).length)) {
      await aliveList(this.c.env);
    }
    if (this.c.env && !POOL_MEMORY.rows.length) await ensurePool(this.c.env); // 冷 isolate 池空则载入，否则「列全池」只剩 alive
    // JSON 只回原始行、不带补码出来的国家名：冷 isolate 上这张表要发一次 ip-api 子请求（实测 3 并发 42% 吃 503）
    const wantJson = this.c.url.searchParams.get("format") === "json";
    if (!wantJson) await ensureIsoCountries();
    const target = (this.c.url.searchParams.get("site") || "").slice(0, 256);
    const rows = this.rows(); // 建表与排序；站点相关列交给 decorate() 只补切片
    if (this.c.url.searchParams.get("format") === "json") {
      // 默认只回前 200 行：全量 1600 行序列化后仍近 400KB，3 并发实测 98% 被 1102 杀掉；
      // 需要全量的调用方显式写 ?limit=0，面板走 HTML 分页不受影响。
      const rawLimit = this.c.url.searchParams.get("limit");
      const limit = rawLimit === null ? 200 : Math.max(0, Number(rawLimit) || 0);
      const jkey = target + "|" + limit;
      const nowJson = Date.now();
      const hitJson = REGION_CACHE.freshJson(jkey, nowJson);
      // 序列化结果同样缓存 30 秒：行缓存省掉了重建，但 650 KB 的 stringify 与覆盖率统计每次都要重算
      if (hitJson !== null) {
        return new Response(hitJson, { headers: { "content-type": "application/json;charset=utf-8" } });
      }
      const respJson = this.jsonView(this.decorate(limit > 0 ? rows.slice(0, limit) : rows, target), target);
      const bodyJson = await respJson.text();
      REGION_CACHE.json = { t: nowJson, key: jkey, text: bodyJson };
      return new Response(bodyJson, { headers: respJson.headers });
    }
    // 全池可达 1600 条：服务端分页，避免一次性渲染数 MB HTML；JSON 仍返回全量
    const size = 40, pages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(pages, Math.max(1, Number(this.c.url.searchParams.get("page")) || 1));
    return this.htmlView(this.decorate(rows.slice((page - 1) * size, page * size), target), target, page, pages, rows.length);
  }
}
