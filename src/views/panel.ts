import { escapeHtml, fmtBytes } from "./html";
import { loadNodes, pickProtos, COLO_CITY } from "./sub-common";
import { P_T, VERSION } from "../core/util";
import { effectiveQuota } from "../core/quota";

// ---- 并入自 panel-admin.ts ----
/**
 * 渲染管理面板（用户列表 + 用量 + 增删操作）。
 * @param {URL} url 请求 URL
 * @param {Array<object>} users 用户列表
 * @param {Map<string,object>} statsMap 用量表
 * @returns {string} HTML
 */
export function renderAdmin(
  url: URL,
  users: { list: UserRec[] },
  statsMap: Record<string, { up: number; down: number; todayUp: number; todayDown: number }>,
  pageKey = "",
) {
  // 用 ?k=adminKey 直接打开面板时，表单 POST 也必须带同一个 k
  const ak = url.searchParams.get("k") || "";
  const opAction = "/admin/op" + (ak ? "?k=" + encodeURIComponent(ak) : "");
  const rows = users.list
    .map((u: UserRec) => {
      // 没读到用量与「用量为 0」是两件事：前者显示「—」，别编一个 0 出来
      const s = statsMap[u.id];
      const has = !!s;
      const used = has ? fmtBytes((s.up || 0) + (s.down || 0)) : "—";
      const today = has ? fmtBytes((s.todayUp || 0) + (s.todayDown || 0)) : "—";
      const dis = u.enabled === false;
      const ops = u.managed
        ? `<form method="post" action="${escapeHtml(opAction)}" style="display:inline">
             <input type="hidden" name="id" value="${u.id}">
             <button name="op" value="toggle">${dis ? "启用" : "禁用"}</button>
             <button name="op" value="reset">重置密码</button>
             <button name="op" value="del" onclick="return confirm('确定删除？')">删除</button>
           </form>`
        : `<span class="mu">环境变量，不可改</span>`;
      // 控制页/订阅都要带 pageKey（设了访问口令时）
      const kq = pageKey ? "?k=" + encodeURIComponent(pageKey) : "";
      const base = url.origin + "/" + encodeURIComponent(u.id);
      const panelHref = base + kq;
      const subClash = base + "/cl" + kq;
      const subSb = base + "/sb" + kq;
      const subTy = base + "/ty" + kq;
      return `<tr class="${dis ? "off" : ""}">
        <td class="u">${escapeHtml(u.id)}</td>
        <td class="u">${u.pwd ? escapeHtml(u.pwd) : "<span class='mu'>—</span>"}</td>
        <td>${escapeHtml(u.note || "")}</td>
        <td>${dis ? "已禁用" : "正常"}</td>
        <td>${today}</td>
        <td>${used}</td>
        <td class="lnk">
          <a class="btn" href="${escapeHtml(panelHref)}" target="_blank" rel="noreferrer">打开</a>
          <button data-copy="${escapeHtml(subClash)}" title="复制 Clash 订阅">cl</button>
          <button data-copy="${escapeHtml(subSb)}" title="复制 sing-box 订阅">sb</button>
          <button data-copy="${escapeHtml(subTy)}" title="复制明文链接订阅">ty</button>
        </td>
        <td>${ops}</td>
      </tr>`;
    })
    .join("");

  const total = users.list.filter((x) => x.enabled !== false).length;
  // 有谁没读到：在标题下给一句说明，否则「—」会被当成坏了
  const missing = users.list.filter((u: UserRec) => !statsMap[u.id]).length;
  const missNote = missing
    ? `<div class="mu" style="font-size:12.5px;margin:-10px 0 14px">其中 ${missing} 个用户这次没读到用量（本次预算或 DO 抖动），用量列显示「—」</div>`
    : "";

  return `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>用户管理</title>
<style>
body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:0;padding:20px;max-width:1000px;color:#1f2328}
h1{font-size:18px;margin:0 0 4px}
.sub{color:#6b7280;font-size:13px;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
td,th{border:1px solid #e3e6ea;padding:7px 9px;text-align:left;vertical-align:top}
th{background:#fafbfc}
.u{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
.mu{color:#9ca3af}
tr.off td{opacity:.5}
button{padding:3px 8px;font-size:12px;margin:1px;border:1px solid #d1d5db;background:#fff;border-radius:4px;cursor:pointer}
button:hover{background:#f3f4f6}
.lnk{white-space:nowrap}
a.btn{display:inline-block;padding:3px 8px;font-size:12px;border:1px solid #d1d5db;border-radius:4px;color:#1f2328;text-decoration:none;background:#fff}
a.btn:hover{background:#f3f4f6}
.add{margin:16px 0;padding:12px;border:1px solid #e3e6ea;border-radius:8px;background:#fafbfc}
input[type=text]{padding:5px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:13px}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px}
</style>
<h1>用户管理</h1>
<div class="sub">共 ${users.list.length} 个用户，启用 ${total} 个 · 数据存于 KV，面板改动立即生效</div>
${missNote}

<form class="add" method="post" action="${escapeHtml(opAction)}">
  <input type="hidden" name="op" value="add">
  备注：<input type="text" name="note" placeholder="例如：朋友A" size="18">
  <button type="submit">新增用户（自动生成 UUID + 密码）</button>
</form>

<table>
<tr><th>UUID</th><th>Trojan 密码</th><th>备注</th><th>状态</th><th>今日</th><th>累计</th><th>入口</th><th>操作</th></tr>
${rows || '<tr><td colspan="8" class="mu">还没有用户</td></tr>'}
</table>

<div class="sub" style="margin-top:18px">
新增后把 UUID / 密码发给对方：控制页 <code>${url.origin}/&lt;uuid&gt;</code>，订阅 <code>/&lt;uuid&gt;/cl</code>。
每行「打开」直达该用户控制页，cl/sb/ty 按钮复制对应订阅地址（含访问口令）。
</div>
<script>
(function () {
  /**
   * 功能：生成一次性的提示条 HTML（成功/失败样式）。
   * @param msg 文本（会被转义）
   * @param bad 是否为错误样式
   * @returns HTML 片段
   */
  function flash(b, t) {
    var old = b.getAttribute("data-label") || b.textContent;
    b.textContent = t;
    setTimeout(function () { b.textContent = old; }, 1200);
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("button[data-copy]") : null;
    if (!b) return;
    var text = b.getAttribute("data-copy");
    /**
     * 功能：浏览器端小函数：复制成功后提示「已复制」（内联进页面，服务端不执行）。
     * @returns 无
     */
    function done() { flash(b, "已复制"); }
    /**
     * 功能：出错时的兜底响应（保留提示，不抛给用户 500）。
     * @param msg 提示文本
     * @returns 响应
     */
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta); done();
      } catch (err) { window.prompt("手动复制：", text); }
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  });
})();
</script>
</body></html>`;
}

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

// ---- 门面（对外导出面保持不变） ----
/**
 * 功能：渲染控制面板（用量、节点、判定、日志等分区的 HTML）。
 * @param env 环境变量
 * @param url 当前 URL（决定高亮的分区）
 * @param id 用户 id
 * @param host 站点域名
 * @param key 管理密钥（写进页面内的链接）
 * @param info 面板数据
 * @returns HTML 字符串
 */
export function renderHtml(env: Env, url: URL, id: string, host: string, key: string, info: PanelInfo) {
  const base = `${url.origin}/${id}`;
  // 路径里已经有 ? 时必须用 &，否则 /stats?format=html?k=xxx 会把 format 的值
  // 变成 "html?k=xxx"，页面退化成 JSON，k 也不会被解析。
  const withKey = (path: string) =>
    key ? path + (path.includes("?") ? "&k=" : "?k=") + encodeURIComponent(key) : path;
  const i = info || {};

  const protos = pickProtos(env, url, Boolean(i[P_T + "Pwd"]));
  const regions = i.regions || [];
  const nodeCount = loadNodes(env, host).length * protos.length + regions.length * protos.length;

  const row = (k: string, v: string, mono = false) =>
    `<tr><td class="k">${k}</td><td class="${mono ? "u" : ""}">${v}</td></tr>`;

  const link = (path: string, desc: string, tag: string) => {
    const p = withKey(path);
    return `<tr><td class="t">${tag || "GET"}</td><td class="u"><a href="${base}${p}" target="_blank">${base}${p}</a></td><td class="d">${desc}</td></tr>`;
  };

  const topLink = (path: string, desc: string, tag: string) => {
    const p = withKey(path);
    return `<tr><td class="t">${tag || "GET"}</td><td class="u"><a href="${url.origin}${p}" target="_blank">${url.origin}${p}</a></td><td class="d">${desc}</td></tr>`;
  };

  return `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(host)}</title>
<style>
:root{--bd:#e3e6ea;--bg:#fafbfc;--tx:#1f2328;--mu:#6b7280;--ac:#2563eb}
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
li{margin:3px 0}
</style>

<h1>${escapeHtml(host)}<span class="badge">VLESS + Trojan</span></h1>
<div class="sub">同一 WebSocket 端点，按首帧自动识别协议 · 出口默认 Cloudflare，失败降级 proxyip · v${VERSION}</div>

<h2>身份</h2>
<table>
${row("UUID", id, true)}
${row("密码", escapeHtml(String(i[P_T + "Pwd"] || "（未配置）")), true)}
${row("WS 路径", "<code>/?ed=2560</code>", false)}
${row("协议", protos.join(" + "), false)}
</table>

<h2>订阅（导入客户端用这个）</h2>
<table>
<tr><th>类型</th><th>链接</th><th>说明</th></tr>
${link("/cl", "Clash / mihomo / Clash Verge Rev", "YAML")}
${link("/sb", "sing-box（含 TUN 入站）", "JSON")}
${link("/ty", "Base64 分享串（v2rayN / Shadowrocket）", "B64")}
</table>
<div class="note">别名：<code>/pcl</code> = <code>/cl</code>，<code>/psb</code> = <code>/sb</code>，<code>/pty</code> = <code>/ty</code>。
加 <code>?proto=vless</code> 或 <code>?proto=trojan</code> 只导出单一协议。</div>

<h2>状态</h2>
<table>
${row("节点数", nodeCount + " 个（含地区节点 " + regions.length * protos.length + " 个）", false)}
${row("地区出口", escapeHtml(regions.length ? regions.join(" / ") : "暂无可用的地区 proxyip"), false)}
${row("本机房", escapeHtml(i.colo + "　|　" + (i.funnel || "-")), false)}
${row("当前节点 · 吞吐优先", escapeHtml(i.curTput || "（未定）"), true)}
${row("当前节点 · 速率优先", escapeHtml(i.curLat || "（未定）"), true)}
${row("备用节点", (i.aliveCount || 0) + " 个", false)}
${row("用量", (i.used || "0 B") + " / " + (i.quota || "不限"), false)}
${row("今日", i.today || "0 B", false)}
${row("到期", escapeHtml(i.expire || "长期"), false)}
</table>

<h2>监控与调试</h2>
<table>
<tr><th>方法</th><th>链接</th><th>说明</th></tr>
${topLink("/health", "服务健康：UUID 数、池子大小、错误数、当前机房", "GET")}
${link("/stats", "用量 JSON（上行/下行/连接数）", "JSON")}
${link("/stats?format=html", "用量看板：进度条 + 各入口实测 RTT/机房 + 最近错误", "HTML")}
${link("/logs", "最近 50 条异常（仅当前 isolate）", "JSON")}
${link("/proxyip", "代理池状态：当前节点、备选（含国家）、黑名单、轮换策略", "JSON")}
${link("/proxyip?refresh=1", "手动触发一轮扫描（验 20 个候选，约 20–40 秒）", "ACTION")}
${link("/debug?host=example.com", "查某域名的 A / AAAA 解析结果", "DEBUG")}
${link("/debug?probe=1.2.3.4:443", "单点探测某个候选 proxyip 是否可用", "DEBUG")}
</table>

<h2>参数</h2>
<table>
${row("?ed=2560", "早期数据长度，把首包塞进 WS 握手，省 1 个 RTT", false)}
${row("?proto=", "<code>vless</code> / <code>trojan</code> / <code>both</code>（订阅用）", false)}
${row("?rg=", "强制地区出口，如 <code>rg=de</code>、<code>rg=nl</code>（数据面用）", false)}
${row("?ip=", "入口标签，仅用于 RTT 统计，不影响功能", false)}
${row("?k=", "页面口令（配置了 pageKey 才生效）", false)}
</table>

<h2>行为说明</h2>
<div class="note">
<ul>
<li><b>默认出口</b>：直连，出口是 Cloudflare 边缘 IP；连不上（Cloudflare 托管站点如 X）才降级到 proxyip。</li>
<li><b>地区出口</b>：路径带 <code>&amp;rg=xx</code> 时跳过直连，直接用该国 proxyip，出口即该国 IP。</li>
<li><b>切换策略</b>：<code>${i.policy || "失败 5 次才换，切换后驻留 6 小时"}</code>，能通就一直用，不主动跳 IP。</li>
<li><b>鉴权</b>：UUID（VLESS）/ 密码（Trojan），两者共用同一套统计。</li>
</ul>
</div>

<div class="sub" style="margin-top:22px">path 里的 <code>ed=2560</code> 不要去掉；换客户端只改订阅链接即可。</div>
</body></html>`;
}

/* ---------- 会话与登录（挑战-应答，密码不出现在任何请求里） ---------- */

/**
 * 渲染登录页。
 * @param {string} nonce 一次性串
 * @param {string} [err] 错误提示
 * @returns {string} HTML
 */
export function renderLogin(nonce: string, err?: string | null) {
  return `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录</title>
<style>
body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f7f8fa;color:#1f2328}
.box{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:26px 24px;width:320px;box-shadow:0 2px 12px rgba(0,0,0,.04)}
h1{font-size:17px;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d1d5db;border-radius:7px;font-size:14px}
button{margin-top:12px;width:100%;padding:9px;border:0;border-radius:7px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}
button:disabled{background:#9ca3af}
.err{color:#dc2626;font-size:13px;margin-top:10px}
.tip{color:#6b7280;font-size:12px;margin-top:14px;line-height:1.5}
</style>
<div class="box">
  <h1>管理员登录</h1>
  <form id="f" method="post" action="/admin/login">
    <input type="hidden" name="n" value="${nonce}">
    <input type="hidden" name="p" value="">
    <input id="pw" type="password" placeholder="密码" autocomplete="current-password" autofocus>
    <button id="btn" type="submit">登录</button>
  </form>
  ${err ? `<div class="err">${err}</div>` : ""}
  <div class="tip">密码只在浏览器里参与 SHA-256 计算，请求里只有哈希，且每次带随机 nonce 防重放。</div>
</div>
<script>
const f=document.getElementById('f'),pw=document.getElementById('pw'),btn=document.getElementById('btn');
f.addEventListener('submit',async e=>{
  e.preventDefault();
  if(!pw.value) return;
  btn.disabled=true; btn.textContent='校验中…';
  try{
    const data=new TextEncoder().encode(f.n.value+':'+pw.value);
    const buf=await crypto.subtle.digest('SHA-256',data);
    f.p.value=[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
    f.submit();
  }catch(err){ btn.disabled=false; btn.textContent='登录'; alert('浏览器不支持 crypto.subtle（需要 HTTPS）'); }
});
</script>
</body></html>`;
}

/* ==================================================================
 * §8b  用户管理面板（登录 + 增删改）
 * ================================================================== */


/**
 * 渲染“未配置 adminKey”的提示页。
 * @returns {string} HTML
 */
export function renderAdminHint() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要配置</title><body style="font:15px/1.6 system-ui;margin:32px;max-width:640px">
<h2>管理面板未启用</h2>
<p>请在 Worker 的环境变量里加一个 <code>adminKey</code>（随便一串足够长的随机字符），然后访问：</p>
<p><code>/admin?k=你设置的adminKey</code></p>
<p style="color:#666">建议：<code>openssl rand -hex 16</code> 生成。</p></body>`;
}


