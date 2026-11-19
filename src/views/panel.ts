import { loadNodes, pickProtos, COLO_CITY } from "./sub-common";
import { P_T, VERSION } from "../core/util";
import { effectiveQuota } from "../core/quota";
import panelTpl from "./html/panel.html";
import statsTpl from "./html/stats.html";

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

/**
 * 功能：把 HTML 模板里的 `{{name}}` 占位符替换成调用方算好的值。
 *
 * 为什么把 HTML 搬进 .html 文件再在构建期读成字符串：模板本来就是标记语言，
 * 塞在 JS 模板字面量里既没有语法高亮，也把 `${}` 插值与 CSS/JS 的 `{}` 混在一起，
 * 一处少转义就会把请求里的站点名拼进页面。现在静态结构住在 .html 里，
 * 所有插值集中成 `{{name}}`，转义由调用方在传值前显式做（escapeHtml），
 * 这里只做机械替换、不猜内容、不做二次转义。
 *
 * @param tpl 构建期读进来的模板字符串
 * @param vars 占位符名到已转义字符串的映射
 * @returns 替换后的 HTML；没在 vars 里的占位符原样保留，便于发现漏传
 */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole));
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

  return renderTemplate(statsTpl, {
    idShort: id.slice(0, 8),
    today: fmtBytes((s.todayUp || 0) + (s.todayDown || 0)),
    up: fmtBytes(s.up),
    down: fmtBytes(s.down),
    totalRow: `${fmtBytes(usedBytes)}${total ? ` / ${fmtBytes(total)}（${usedPercent}%）` : ""}`,
    conns: String(s.conns),
    first: s.firstSeen ? new Date(s.firstSeen).toISOString().replace("T", " ").slice(0, 19) : "-",
    last: s.lastSeen ? new Date(s.lastSeen).toISOString().replace("T", " ").slice(0, 19) : "-",
    bar: total ? `<div class="bar"><i style="width:${usedPercent}%"></i></div>` : "",
    rttRows: rttRows || "<tr><td colspan=5>暂无数据</td></tr>",
    nodeRows: nodeRowsHtml || "<tr><td colspan=6>暂无数据</td></tr>",
    errRows: errRows || "<tr><td colspan=2>无</td></tr>",
  });
}

/**
 * 功能：控制面板视图 —— 八个分区各产一组占位符，整页骨架住在 panel.html。
 *
 * 为什么改成「类 + 模板」：旧版把 121 行 HTML 塞在一个函数里 —— 静态样式、六个独立分区、
 * 四个共享闭包混在一起，改一处要在大字符串里找位置，站点名/地区名靠手写 escapeHtml 兜底。
 * 现在静态结构与 CSS 住在 .html 文件（有语法高亮、能单独比对），每个分区只算自己那几个
 * 「已经转义好的值」，组装交给 renderTemplate。页面里所有插值在传值前都必须过 escapeHtml。
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
   * @param env 环境变量
   * @param url 当前 URL（决定协议与口令）
   * @param id 用户 id
   * @param host 站点域名
   * @param key 管理密钥（写进页面里的链接）
   * @param info 面板数据（缺数据时给空壳，模板里每个字段都有兜底文案）
   * @returns 无（构造即完成派生量计算）
   */
  constructor(env: Env, url: URL, id: string, host: string, key: string, info: PanelInfo | null) {
    this.url = url;
    this.id = id;
    this.host = host;
    this.key = key;
    this.info = info || ({} as PanelInfo);
    this.base = `${url.origin}/${id}`;
    this.protos = pickProtos(env, url, Boolean(this.info[P_T + "Pwd"]));
    this.regions = this.info.regions || [];
    // 节点数 = 手动节点 × 协议数 + 地区节点 × 协议数（客户端实际会看到的条目数）
    this.nodeCount = loadNodes(env, host).length * this.protos.length + this.regions.length * this.protos.length;
  }

  /**
   * 功能：渲染整页 —— 八个分区各交一组占位符值，一次性套进模板。
   * @returns 完整 HTML
   */
  render(): string {
    return renderTemplate(panelTpl, {
      ...this.header(),
      ...this.identity(),
      ...this.subscriptions(),
      ...this.statusTable(),
      ...this.monitor(),
      ...this.params(),
      ...this.behaviour(),
      ...this.footer(),
    });
  }

  /**
   * 功能：把口令拼进链接 —— 路径里已经有 ? 时必须用 &。
   * @param path 相对路径（可带查询串）
   * @returns 带口令的路径
   */
  private withKey(path: string): string {
    return this.key ? path + (path.includes("?") ? "&k=" : "?k=") + encodeURIComponent(this.key) : path;
  }

  /**
   * 功能：一行「键 → 值」。
   * @param k 键名
   * @param v 已转义的值
   * @param mono 是否用等宽字体（UUID / 节点地址用）
   * @returns tr 片段
   */
  private row(k: string, v: string, mono = false): string {
    return `<tr><td class="k">${k}</td><td class="${mono ? "u" : ""}">${v}</td></tr>`;
  }

  /**
   * 功能：一条带本站前缀的链接（挂在用户 id 下）。
   * @param path 相对路径
   * @param desc 说明
   * @param tag 左侧标签（YAML / JSON / ACTION …）
   * @returns tr 片段
   */
  private link(path: string, desc: string, tag: string): string {
    const p = this.withKey(path);
    return `<tr><td class="t">${tag || "GET"}</td><td class="u"><a href="${this.base}${p}" target="_blank">${this.base}${p}</a></td><td class="d">${desc}</td></tr>`;
  }

  /**
   * 功能：一条根路径链接（健康检查这类不在用户 id 下的端点）。
   * @param path 相对路径
   * @param desc 说明
   * @param tag 左侧标签
   * @returns tr 片段
   */
  private topLink(path: string, desc: string, tag: string): string {
    const p = this.withKey(path);
    return `<tr><td class="t">${tag || "GET"}</td><td class="u"><a href="${this.url.origin}${p}" target="_blank">${this.url.origin}${p}</a></td><td class="d">${desc}</td></tr>`;
  }

  /**
   * 功能：页头占位符（站点名与版本号）。
   * @returns host / version 两个值
   */
  private header(): Record<string, string> {
    return { host: escapeHtml(this.host), version: VERSION };
  }

  /**
   * 功能：身份分区占位符（UUID / 密码 / 协议）。
   * @returns idRow / pwdRow / protoRow
   */
  private identity(): Record<string, string> {
    return {
      idRow: this.row("UUID", this.id, true),
      pwdRow: this.row("密码", escapeHtml(String(this.info[P_T + "Pwd"] || "（未配置）")), true),
      protoRow: this.row("协议", this.protos.join(" + "), false),
    };
  }

  /**
   * 功能：订阅分区占位符（三种格式的导入链接）。
   * @returns clRow / sbRow / tyRow
   */
  private subscriptions(): Record<string, string> {
    return {
      clRow: this.link("/cl", "Clash / mihomo / Clash Verge Rev", "YAML"),
      sbRow: this.link("/sb", "sing-box（含 TUN 入站）", "JSON"),
      tyRow: this.link("/ty", "Base64 分享串（v2rayN / Shadowrocket）", "B64"),
    };
  }

  /**
   * 功能：状态分区占位符（节点数、地区、当前节点、用量）。
   * @returns 状态表九行的值
   */
  private statusTable(): Record<string, string> {
    return {
      nodeCountRow: this.row("节点数", this.nodeCount + " 个（含地区节点 " + this.regions.length * this.protos.length + " 个）", false),
      regionRow: this.row("地区出口", escapeHtml(this.regions.length ? this.regions.join(" / ") : "暂无可用的地区 proxyip"), false),
      coloRow: this.row("本机房", escapeHtml(this.info.colo + "　|　" + (this.info.funnel || "-")), false),
      curTputRow: this.row("当前节点 · 吞吐优先", escapeHtml(this.info.curTput || "（未定）"), true),
      curLatRow: this.row("当前节点 · 速率优先", escapeHtml(this.info.curLat || "（未定）"), true),
      aliveRow: this.row("备用节点", (this.info.aliveCount || 0) + " 个", false),
      usedRow: this.row("用量", (this.info.used || "0 B") + " / " + (this.info.quota || "不限"), false),
      todayRow: this.row("今日", this.info.today || "0 B", false),
      expireRow: this.row("到期", escapeHtml(this.info.expire || "长期"), false),
    };
  }

  /**
   * 功能：监控与调试分区占位符（健康、用量、日志、池子、探测端点）。
   * @returns 监控表八行的值
   */
  private monitor(): Record<string, string> {
    return {
      healthRow: this.topLink("/health", "服务健康：UUID 数、池子大小、错误数、当前机房", "GET"),
      statsRow: this.link("/stats", "用量 JSON（上行/下行/连接数）", "JSON"),
      statsHtmlRow: this.link("/stats?format=html", "用量看板：进度条 + 各入口实测 RTT/机房 + 最近错误", "HTML"),
      logsRow: this.link("/logs", "最近 50 条异常（仅当前 isolate）", "JSON"),
      poolRow: this.link("/proxyip", "代理池状态：当前节点、备选（含国家）、黑名单、轮换策略", "JSON"),
      refreshRow: this.link("/proxyip?refresh=1", "手动触发一轮扫描（验 20 个候选，约 20–40 秒）", "ACTION"),
      debugHostRow: this.link("/debug?host=example.com", "查某域名的 A / AAAA 解析结果", "DEBUG"),
      debugProbeRow: this.link("/debug?probe=1.2.3.4:443", "单点探测某个候选 proxyip 是否可用", "DEBUG"),
    };
  }

  /**
   * 功能：参数分区占位符 —— 这一分区全是静态文本，已在模板里，这里不提供值。
   * @returns 空映射（保留方法是为了分区结构与旧版一一对应）
   */
  private params(): Record<string, string> {
    return {};
  }

  /**
   * 功能：行为说明分区占位符（切换策略由面板数据决定，其余是模板静态文本）。
   * @returns policy 的值
   */
  private behaviour(): Record<string, string> {
    return { policy: escapeHtml(this.info.policy || "失败 5 次才换，切换后驻留 6 小时") };
  }

  /**
   * 功能：页脚占位符 —— 静态文本已在模板里，这里不提供值。
   * @returns 空映射
   */
  private footer(): Record<string, string> {
    return {};
  }
}


/**
 * 功能：渲染控制面板（薄入口 —— 路由与单测都从这里进）。
 * @param env 环境变量
 * @param url 当前 URL
 * @param id 用户 id
 * @param host 站点域名
 * @param key 管理密钥
 * @param info 面板数据
 * @returns 完整 HTML 字符串
 */
export function renderHtml(env: Env, url: URL, id: string, host: string, key: string, info: PanelInfo) {
  return new PanelView(env, url, id, host, key, info).render();
}

/* ---------- 会话与登录（挑战-应答，密码不出现在任何请求里） ---------- */

/* ==================================================================
 * §8b  用户管理面板（登录 + 增删改）
 * ================================================================== */
