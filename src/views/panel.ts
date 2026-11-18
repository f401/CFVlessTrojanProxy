import { loadNodes, pickProtos, COLO_CITY } from "./sub-common";
import { P_T, VERSION } from "../core/util";
import { effectiveQuota } from "../core/quota";

// ---- 并入自 html.ts ----
/* HTML 小工具：转义与字节格式化 */

/**
 * 功能：把字节数格式化成人类可读形式（KB/MB/GB，保留一位小数）。
 * @param n 字节数
 * @returns 字符串
 */
export function fmtBytes(n: number) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/**
 * 功能：HTML 转义（面板与错误页所有插值都必须过它）。
 * @param s 任意值（会先 String 化）
 * @returns 转义后的字符串
 */
export function escapeHtml(s: unknown) {
  const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, (c) => MAP[c]);
}

// ---- 并入自 pageview.ts ----
interface StatsIn {
  env: Env;
  id: string;
  stats: StatsView;
  learned: Record<string, RttEntry>;
  nodeRows: StatsNodeRow[];
  errs: ErrItem[];
}

/**
 * 页面视图（P6-3）：面板 / 统计 / 登录 / 管理台都从这一个对象出。
 * 序列化全在 views 层，routes 只负责取数与包 header。
 */
export class PageView {
  /** 用户面板（/<uuid>/page） */
  panel(env: Env, url: URL, id: string, host: string, key: string, info: PanelInfo): string {
    return renderHtml(env, url, id, host, key, info);
  }

  /** 用量统计页（/<uuid>/stats?format=html） */
  stats(o: StatsIn): string {
    return renderStatsHtml(o.env, o.id, o.stats, o.learned, o.nodeRows, o.errs);
  }

}

// ---- 门面（对外导出面保持不变） ----
// ---- 并入自 panel-admin.ts ----
/* ==================================================================
 * §9  路由与响应
 * ================================================================== */

// ---- 并入自 panel-stats.ts ----
/**
 * 渲染用量看板（进度条 + 各入口 RTT + 最近错误）。
 * @param {object} env Worker 环境
 * @param {string} id 用户 UUID
 * @param {object} s 用量对象
 * @param {object} learned RTT 学习结果
 * @returns {string} HTML
 */
export function renderStatsHtml(
  env: Env,
  id: string,
  s: StatsView,
  learned: Record<string, RttEntry>,
  nodeRows: StatsNodeRow[],
  errs: ErrItem[],
) {
  const usedBytes = (s.up || 0) + (s.down || 0);
  const total = effectiveQuota(env, usedBytes);
  // 用量百分比：配额不可知时显示 0 而不是 100（旧版这里只有一个 `pct`，看不出是谁的百分比）
  const usedPercent = total > 0 ? Math.min(100, Math.round((usedBytes / total) * 100)) : 0;

  const rttRows = (Object.entries(learned || {}) as [string, RttEntry][])
    .sort((a, b) => a[1].rtt - b[1].rtt)
    .map(([edgeTag, row]) => {
      // 机房展示名：`COLO_CITY` 里没有的机场就只显示三字码，不要拼一个空破折号
      const cityText = row.colo
        ? `${row.colo}${(COLO_CITY as Record<string, string>)[row.colo] ? "-" + (COLO_CITY as Record<string, string>)[row.colo] : ""}`
        : "-";
      const okCount = row.ok || 0;
      const failCount = row.fail || 0;
      const sampleCount = okCount + failCount;
      const successText = sampleCount > 0 ? Math.round((okCount / sampleCount) * 100) + "% (" + okCount + "/" + sampleCount + ")" : "-";
      // 样本 ≥5 且成功率 <80% 才标红：一两次失败不足以说明入口坏了
      const alertStyle = sampleCount >= 5 && okCount / sampleCount < 0.8 ? ' style="color:#dc2626"' : "";
      return `<tr><td class="u">${escapeHtml(edgeTag)}</td><td>${escapeHtml(cityText)}</td><td>${row.rtt} ms</td><td>${row.hits}</td><td${alertStyle}>${successText}</td></tr>`;
    })
    .join("");

  const nodeRowsHtml = (nodeRows || [])
    .map(
      (n) =>
        `<tr title="${escapeHtml(n.tip)}"><td class="u">${escapeHtml(n.k)}</td><td>${escapeHtml(n.cc || "-")}</td><td>${n.ms} ms</td><td>${n.kbps}</td><td>${n.rate}</td><td><b>${Math.round(n.score)}</b></td></tr>`,
    )
    .join("");

  const errRows = (errs || [])
    .map(
      (e) =>
        `<tr><td>${new Date(e.t).toISOString().replace("T", " ").slice(0, 19)}</td><td class="u">${escapeHtml(e.m)}</td></tr>`,
    )
    .join("");

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>统计 ${id.slice(0, 8)}</title>
<style>
body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:24px;max-width:860px;color:#222}
h2{font-size:17px;margin:24px 0 8px}
table{border-collapse:collapse;width:100%;margin-bottom:6px}
td,th{border:1px solid #ddd;padding:6px 9px;text-align:left}
.u{font-family:ui-monospace,monospace;font-size:13px}
.bar{height:10px;background:#eee;border-radius:5px;overflow:hidden}
.bar>i{display:block;height:100%;background:#2f7ad6}
</style>
<h2>用量</h2>
<table>
<tr><th>今日</th><td>${fmtBytes((s.todayUp || 0) + (s.todayDown || 0))}</td></tr>
<tr><th>上行</th><td>${fmtBytes(s.up)}</td></tr>
<tr><th>下行</th><td>${fmtBytes(s.down)}</td></tr>
<tr><th>合计</th><td>${fmtBytes(usedBytes)}${total ? ` / ${fmtBytes(total)}（${usedPercent}%）` : ""}</td></tr>
<tr><th>连接数</th><td>${s.conns}</td></tr>
<tr><th>首次</th><td>${s.firstSeen ? new Date(s.firstSeen).toISOString().replace("T", " ").slice(0, 19) : "-"}</td></tr>
<tr><th>最近</th><td>${s.lastSeen ? new Date(s.lastSeen).toISOString().replace("T", " ").slice(0, 19) : "-"}</td></tr>
</table>
${total ? `<div class="bar"><i style="width:${usedPercent}%"></i></div>` : ""}
<h2>实测 RTT（按入口）</h2>
<table><tr><th>入口标签</th><th>机房</th><th>RTT</th><th>样本</th><th>成功率</th></tr>${rttRows || "<tr><td colspan=5>暂无数据</td></tr>"}</table>
<h2>节点评分（延迟 + 失败率 + 实测吞吐）</h2>
<table><tr><th>节点</th><th>地区</th><th>探测延迟</th><th>实测吞吐</th><th>成功率</th><th>评分</th></tr>${nodeRowsHtml || "<tr><td colspan=6>暂无数据</td></tr>"}</table>
<h2>最近错误</h2>
<table><tr><th>时间</th><th>内容</th></tr>${errRows || "<tr><td colspan=2>无</td></tr>"}</table>
</body>`;
}

// ---- 面板页面：一个类六个分区，组装只剩一次 join ----
/** 面板页面的静态样式（整段模板里唯一不随数据变化的部分，单独拿出来便于比对改动） */
const PANEL_CSS = `:root{--bd:#e3e6ea;--bg:#fafbfc;--tx:#1f2328;--mu:#6b7280;--ac:#2563eb}
*{box-sizing:border-box}
body{font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0;padding:20px;color:var(--tx);background:#fff;max-width:980px}
h1{font-size:19px;margin:0 0 4px}
h2{font-size:15px;margin:26px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--bd)}
.sub{color:var(--mu);font-size:13px;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:14px}
td,th{border:1px solid var(--bd);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--bg);font-weight:600}
.u{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all}
.u a{color:var(--ac);text-decoration:none}
.u a:hover{text-decoration:underline}
.k{width:150px;color:var(--mu);white-space:nowrap}
.t{width:62px;color:var(--mu);font-size:12px;white-space:nowrap}
.d{color:var(--mu);font-size:13px}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12.5px}
.badge{display:inline-block;padding:1px 7px;border-radius:10px;background:#e8f0fe;color:#1a56db;font-size:12px;margin-left:6px}
.note{background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:10px 12px;color:#374151;font-size:13.5px;margin-top:10px}
.note b{color:var(--tx)}
ul{margin:6px 0 0 18px;padding:0}
li{margin:3px 0}`;

/**
 * 功能：控制面板视图 —— 六个分区各一个方法，渲染只做组装。
 *
 * 为什么成类而不留一个大函数：121 行的模板里塞着三样东西 —— ① 静态样式、② 六个彼此独立的分区
 * （身份 / 订阅 / 状态 / 监控 / 参数 / 行为说明）、③ 四个闭包（withKey/row/link/topLink）被六个分区共用。
 * 改任何一个分区都要在 121 行里定位，而「链接要不要带口令」这种共有规则散在闭包里看不出是全局约定。
 * 现在共有规则是实例方法、分区是命名的方法，组装只剩一次 join。
 *
 * 页面里所有插值都必须过 escapeHtml（站点名、地区名、当前节点都来自请求或池子）。
 */
export class PanelView {
  private readonly url: URL;
  private readonly id: string;
  private readonly host: string;
  private readonly key: string;
  private readonly info: PanelInfo;
  private readonly base: string;
  private readonly protos: string[];
  private readonly regions: string[];
  private readonly nodeCount: number;

  /**
   * 功能：保存渲染需要的全部输入，并先算好三个派生量（基础地址、协议清单、节点数）。
   * @param {Env} env 环境变量
   * @param {URL} url 当前 URL（决定协议与口令）
   * @param {string} id 用户 id
   * @param {string} host 站点域名
   * @param {string} key 管理密钥（写进页面里的链接）
   * @param {PanelInfo | null} info 面板数据
   */
  constructor(env: Env, url: URL, id: string, host: string, key: string, info: PanelInfo | null) {
    this.url = url;
    this.id = id;
    this.host = host;
    this.key = key;
    // 缺数据时给一份空壳：模板里每个字段都有兜底文案，宁少显示不抛错
    this.info = info || ({} as PanelInfo);
    this.base = `${url.origin}/${id}`;
    this.protos = pickProtos(env, url, Boolean(this.info[P_T + "Pwd"]));
    this.regions = this.info.regions || [];
    // 节点数 = 手动节点 × 协议数 + 地区节点 × 协议数（客户端实际会看到的条目数）
    this.nodeCount = loadNodes(env, host).length * this.protos.length + this.regions.length * this.protos.length;
  }

  /**
   * 功能：渲染整页（八个片段按固定顺序用空行拼接）。
   * @returns {string} 完整 HTML
   */
  render(): string {
    return [
      this.header(),
      this.identity(),
      this.subscriptions(),
      this.statusTable(),
      this.monitor(),
      this.params(),
      this.behaviour(),
      this.footer(),
    ].join("\n\n");
  }

  /**
   * 功能：把口令拼进链接 —— 路径里已经有 ? 时必须用 &。
   * @param {string} path 相对路径（可带查询串）
   * @returns {string} 带口令的路径
   */
  private withKey(path: string): string {
    return this.key ? path + (path.includes("?") ? "&k=" : "?k=") + encodeURIComponent(this.key) : path;
  }

  /**
   * 功能：一行「键 → 值」。
   * @param {string} k 键名
   * @param {string} v 已转义的值
   * @param {boolean} [mono] 是否用等宽字体（UUID / 节点地址用）
   * @returns {string} tr 片段
   */
  private row(k: string, v: string, mono = false): string {
    return `<tr><td class="k">${k}</td><td class="${mono ? "u" : ""}">${v}</td></tr>`;
  }

  /**
   * 功能：一条带本站前缀的链接（挂在用户 id 下）。
   * @param {string} path 相对路径
   * @param {string} desc 说明
   * @param {string} tag 左侧标签（YAML / JSON / ACTION …）
   * @returns {string} tr 片段
   */
  private link(path: string, desc: string, tag: string): string {
    const p = this.withKey(path);
    return `<tr><td class="t">${tag || "GET"}</td><td class="u"><a href="${this.base}${p}" target="_blank">${this.base}${p}</a></td><td class="d">${desc}</td></tr>`;
  }

  /**
   * 功能：一条根路径链接（健康检查这类不在用户 id 下的端点）。
   * @param {string} path 相对路径
   * @param {string} desc 说明
   * @param {string} tag 左侧标签
   * @returns {string} tr 片段
   */
  private topLink(path: string, desc: string, tag: string): string {
    const p = this.withKey(path);
    return `<tr><td class="t">${tag || "GET"}</td><td class="u"><a href="${this.url.origin}${p}" target="_blank">${this.url.origin}${p}</a></td><td class="d">${desc}</td></tr>`;
  }

  /**
   * 功能：页头（head、样式、标题、副标题）。
   * @returns {string} HTML
   */
  private header(): string {
    return `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(this.host)}</title>
<style>
${PANEL_CSS}
</style>

<h1>${escapeHtml(this.host)}<span class="badge">VLESS + Trojan</span></h1>
<div class="sub">同一 WebSocket 端点，按首帧自动识别协议 · 出口默认 Cloudflare，失败降级 proxyip · v${VERSION}</div>`;
  }

  /**
   * 功能：身份分区（UUID / 密码 / WS 路径 / 协议）。
   * @returns {string} HTML
   */
  private identity(): string {
    return `<h2>身份</h2>
<table>
${this.row("UUID", this.id, true)}
${this.row("密码", escapeHtml(String(this.info[P_T + "Pwd"] || "（未配置）")), true)}
${this.row("WS 路径", "<code>/?ed=2560</code>", false)}
${this.row("协议", this.protos.join(" + "), false)}
</table>`;
  }

  /**
   * 功能：订阅分区（三种格式的导入链接）。
   * @returns {string} HTML
   */
  private subscriptions(): string {
    return `<h2>订阅（导入客户端用这个）</h2>
<table>
<tr><th>类型</th><th>链接</th><th>说明</th></tr>
${this.link("/cl", "Clash / mihomo / Clash Verge Rev", "YAML")}
${this.link("/sb", "sing-box（含 TUN 入站）", "JSON")}
${this.link("/ty", "Base64 分享串（v2rayN / Shadowrocket）", "B64")}
</table>
<div class="note">别名：<code>/pcl</code> = <code>/cl</code>，<code>/psb</code> = <code>/sb</code>，<code>/pty</code> = <code>/ty</code>。\n加 <code>?proto=vless</code> 或 <code>?proto=trojan</code> 只导出单一协议。</div>`;
  }

  /**
   * 功能：状态分区（节点数、地区、当前节点、用量）。
   * @returns {string} HTML
   */
  private statusTable(): string {
    return `<h2>状态</h2>
<table>
${this.row("节点数", this.nodeCount + " 个（含地区节点 " + this.regions.length * this.protos.length + " 个）", false)}
${this.row("地区出口", escapeHtml(this.regions.length ? this.regions.join(" / ") : "暂无可用的地区 proxyip"), false)}
${this.row("本机房", escapeHtml(this.info.colo + "　|　" + (this.info.funnel || "-")), false)}
${this.row("当前节点 · 吞吐优先", escapeHtml(this.info.curTput || "（未定）"), true)}
${this.row("当前节点 · 速率优先", escapeHtml(this.info.curLat || "（未定）"), true)}
${this.row("备用节点", (this.info.aliveCount || 0) + " 个", false)}
${this.row("用量", (this.info.used || "0 B") + " / " + (this.info.quota || "不限"), false)}
${this.row("今日", this.info.today || "0 B", false)}
${this.row("到期", escapeHtml(this.info.expire || "长期"), false)}
</table>`;
  }

  /**
   * 功能：监控与调试分区（健康、用量、日志、池子、探测端点）。
   * @returns {string} HTML
   */
  private monitor(): string {
    return `<h2>监控与调试</h2>
<table>
<tr><th>方法</th><th>链接</th><th>说明</th></tr>
${this.topLink("/health", "服务健康：UUID 数、池子大小、错误数、当前机房", "GET")}
${this.link("/stats", "用量 JSON（上行/下行/连接数）", "JSON")}
${this.link("/stats?format=html", "用量看板：进度条 + 各入口实测 RTT/机房 + 最近错误", "HTML")}
${this.link("/logs", "最近 50 条异常（仅当前 isolate）", "JSON")}
${this.link("/proxyip", "代理池状态：当前节点、备选（含国家）、黑名单、轮换策略", "JSON")}
${this.link("/proxyip?refresh=1", "手动触发一轮扫描（验 20 个候选，约 20–40 秒）", "ACTION")}
${this.link("/debug?host=example.com", "查某域名的 A / AAAA 解析结果", "DEBUG")}
${this.link("/debug?probe=1.2.3.4:443", "单点探测某个候选 proxyip 是否可用", "DEBUG")}
</table>`;
  }

  /**
   * 功能：参数分区（?ed= / ?proto= / ?rg= / ?ip= / ?k=）。
   * @returns {string} HTML
   */
  private params(): string {
    return `<h2>参数</h2>
<table>
${this.row("?ed=2560", "早期数据长度，把首包塞进 WS 握手，省 1 个 RTT", false)}
${this.row("?proto=", "<code>vless</code> / <code>trojan</code> / <code>both</code>（订阅用）", false)}
${this.row("?rg=", "强制地区出口，如 <code>rg=de</code>、<code>rg=nl</code>（数据面用）", false)}
${this.row("?ip=", "入口标签，仅用于 RTT 统计，不影响功能", false)}
${this.row("?k=", "页面口令（配置了 pageKey 才生效）", false)}
</table>`;
  }

  /**
   * 功能：行为说明分区（默认出口、地区出口、切换策略、鉴权）。
   * @returns {string} HTML
   */
  private behaviour(): string {
    return `<h2>行为说明</h2>
<div class="note">
<ul>
<li><b>默认出口</b>：直连，出口是 Cloudflare 边缘 IP；连不上（Cloudflare 托管站点如 X）才降级到 proxyip。</li>
<li><b>地区出口</b>：路径带 <code>&amp;rg=xx</code> 时跳过直连，直接用该国 proxyip，出口即该国 IP。</li>
<li><b>切换策略</b>：<code>${this.info.policy || "失败 5 次才换，切换后驻留 6 小时"}</code>，能通就一直用，不主动跳 IP。</li>
<li><b>鉴权</b>：UUID（VLESS）/ 密码（Trojan），两者共用同一套统计。</li>
</ul>
</div>`;
  }

  /**
   * 功能：页脚（收尾提示与闭合标签）。
   * @returns {string} HTML
   */
  private footer(): string {
    return `<div class="sub" style="margin-top:22px">path 里的 <code>ed=2560</code> 不要去掉；换客户端只改订阅链接即可。</div>
</body></html>`;
  }
}

/**
 * 功能：渲染控制面板（薄入口 —— 保留它是因为路由与单测都从这里进）。
 * @param env 环境变量
 * @param url 当前 URL（决定高亮的分区）
 * @param id 用户 id
 * @param host 站点域名
 * @param key 管理密钥（写进页面内的链接）
 * @param info 面板数据
 * @returns HTML 字符串
 */
export function renderHtml(env: Env, url: URL, id: string, host: string, key: string, info: PanelInfo) {
  return new PanelView(env, url, id, host, key, info).render();
}

/* ---------- 会话与登录（挑战-应答，密码不出现在任何请求里） ---------- */

/* ==================================================================
 * §8b  用户管理面板（登录 + 增删改）
 * ================================================================== */
