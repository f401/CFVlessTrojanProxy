import { escapeHtml } from "./html";
import { loadNodes, pickProtos } from "./sub-common";
import { P_T, VERSION } from "../core/util";

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
${link("/debug?host=x.com", "查某域名的 A / AAAA 解析结果", "DEBUG")}
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
<li><b>默认出口</b>：直连，出口是 Cloudflare 边缘 IP；连不上（Cloudflare 托管站点如 x.com）才降级到 proxyip。</li>
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
 * 从请求头里取指定 cookie 的值。
 * @param {Request} req 请求
 * @param {string} name cookie 名
 * @returns {string} 值，没有则空串
 */

/**
 * 计算字符串的 SHA-256，输出十六进制。
 * @param {string} str 原文
 * @returns {Promise<string>} 64 位十六进制
 */

/**
 * 用 adminKey 派生会话 token（不存任何明文）。
 * @param {object} env Worker 环境
 * @returns {Promise<string>} token
 */

/**
 * 校验管理端请求是否已登录（cookie 或 URL 上的 key）。
 * @param {Request} request 请求
 * @param {URL} url 请求 URL
 * @param {object} env Worker 环境
 * @returns {Promise<boolean>} 是否通过
 */

/**
 * 登录限流：命中则返回 false。
 * @param {string} ip 客户端 IP
 * @param {number} limit 单位时间内的最大次数
 * @returns {boolean} 是否允许本次请求
 */

/**
 * 清空某个 IP 的失败计数（登录成功后调用）。
 * @param {string} ip 客户端 IP
 * @returns {void}
 */

/**
 * 生成一次性随机串（用于登录表单防重放）。
 * @returns {string} 32 位十六进制
 */

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
 * 生成强随机密码（用于新建用户）。
 * @param {number} [n] 长度
 * @returns {string} 密码
 */

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

export { renderAdmin } from "./panel-admin";
export { renderStatsHtml } from "./panel-stats";
