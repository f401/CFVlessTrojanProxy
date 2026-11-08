import { Meter } from "../store/meter";
import { p90Of, scoreMerged , ZERO_STAT } from "../nodes/score";
import { S } from "../core/state";
import { COLO_CITY, loadNodes, pickProtos } from "./sub";
import { P_T, VERSION, enc, toHex } from "../core/util";

/* panel */
export function fmtBytes(n: any) {
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
 * 生成用户首页（用量、当前节点、订阅入口与参数说明）。
 * @param {object} env Worker 环境
 * @param {URL} url 请求 URL
 * @param {string} id 用户 UUID
 * @param {string} host 入口域名
 * @param {string} key 页面口令
 * @param {object} info 展示用信息
 * @returns {string} HTML
 */
export function renderHtml(env: Env, url: any, id: any, host: any, key: any, info: any) {
  const base = `${url.origin}/${id}`;
  const kq = key ? `?k=${encodeURIComponent(key)}` : "";
  const kk = key ? "&k=" + encodeURIComponent(key) : "";
  const i = info || {};

  const protos = pickProtos(env, url);
  const regions = i.regions || [];
  const nodeCount = loadNodes(env, host).length * protos.length + regions.length * protos.length;

  const row = (k: any, v: any, mono: any) =>
    `<tr><td class="k">${k}</td><td class="${mono ? "u" : ""}">${v}</td></tr>`;

  const link = (path: any, desc: any, tag: any) =>
    `<tr><td class="t">${tag || "GET"}</td><td class="u"><a href="${base}${path}${kq}" target="_blank">${base}${path}${kq}</a></td><td class="d">${desc}</td></tr>`;

  const topLink = (path: any, desc: any, tag: any) =>
    `<tr><td class="t">${tag || "GET"}</td><td class="u"><a href="${url.origin}${path}${kq}" target="_blank">${url.origin}${path}${kq}</a></td><td class="d">${desc}</td></tr>`;

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
${row("密码", i[P_T + "Pwd"] || "（未配置）", true)}
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
${row("节点数", nodeCount + " 个（含地区节点 " + regions.length * 2 + " 个）", false)}
${row("地区出口", regions.length ? regions.join(" / ") : "暂无可用的地区 proxyip", false)}
${row("本机房", i.colo + "　|　" + (i.funnel || "-"), false)}
${row("当前节点 · 吞吐优先", i.curTput || "（未定）", true)}
${row("当前节点 · 速率优先", i.curLat || "（未定）", true)}
${row("备用节点", (i.aliveCount || 0) + " 个", false)}
${row("用量", (i.used || "0 B") + " / " + (i.quota || "不限"), false)}
${row("今日", i.today || "0 B", false)}
${row("到期", i.expire || "长期", false)}
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
export function getCookie(req: any, name: any) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/**
 * 计算字符串的 SHA-256，输出十六进制。
 * @param {string} str 原文
 * @returns {Promise<string>} 64 位十六进制
 */
export async function sha256Hex(str: any) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return toHex(new Uint8Array(d));
}

/**
 * 用 adminKey 派生会话 token（不存任何明文）。
 * @param {object} env Worker 环境
 * @returns {Promise<string>} token
 */
export async function sessionToken(env: Env) {
  const t = await sha256Hex(`adm|${env.adminKey || ""}|${env.adminHash || ""}`);
  return t.slice(0, 40);
}

/**
 * 校验管理端请求是否已登录（cookie 或 URL 上的 key）。
 * @param {Request} request 请求
 * @param {URL} url 请求 URL
 * @param {object} env Worker 环境
 * @returns {Promise<boolean>} 是否通过
 */
export async function adminAuthed(request: any, url: any, env: any) {
  const k = url.searchParams.get("k");
  if (k && env.adminKey && k === env.adminKey) return true;
  const tok = getCookie(request, "adm");
  if (!tok) return false;
  return tok === (await sessionToken(env));
}

export const RL_MEM = new Map();   // ip -> { n, t }

/**
 * 登录限流：命中则返回 false。
 * @param {string} ip 客户端 IP
 * @param {number} limit 单位时间内的最大次数
 * @returns {boolean} 是否允许本次请求
 */
export function rlTake(ip: any, limit: any) {
  const now = Date.now();
  const e = RL_MEM.get(ip);
  if (e && now - e.t < 600000) {
    if (e.n >= limit) return false;
    e.n += 1;
    return true;
  }
  RL_MEM.set(ip, { n: 1, t: now });
  if (RL_MEM.size > 500) RL_MEM.clear();
  return true;
}

/**
 * 清空某个 IP 的失败计数（登录成功后调用）。
 * @param {string} ip 客户端 IP
 * @returns {void}
 */
export function rlReset(ip: any) {
  RL_MEM.delete(ip);
}

/**
 * 生成一次性随机串（用于登录表单防重放）。
 * @returns {string} 32 位十六进制
 */
export function newNonce() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Date.now().toString(16) + "." + toHex(b);
}

/**
 * 渲染登录页。
 * @param {string} nonce 一次性串
 * @param {string} [err] 错误提示
 * @returns {string} HTML
 */
export function renderLogin(nonce: any, err: any) {
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
export function randomPwd(n: any) {
  const A = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(n || 16));
  let s = "";
  for (let i = 0; i < b.length; i++) s += A[b[i] % A.length];
  return s;
}

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

/**
 * 渲染管理面板（用户列表 + 用量 + 增删操作）。
 * @param {URL} url 请求 URL
 * @param {Array<object>} users 用户列表
 * @param {Map<string,object>} statsMap 用量表
 * @returns {string} HTML
 */
export function renderAdmin(url: any, users: any, statsMap: any) {
  const rows = users.list
    .map((u: any) => {
      const s = statsMap[u.id] || {};
      const used = fmtBytes((s.up || 0) + (s.down || 0));
      const today = fmtBytes((s.todayUp || 0) + (s.todayDown || 0));
      const dis = u.enabled === false;
      const ops = u.managed
        ? `<form method="post" action="/admin/op" style="display:inline">
             <input type="hidden" name="id" value="${u.id}">
             <button name="op" value="toggle">${dis ? "启用" : "禁用"}</button>
             <button name="op" value="reset">重置密码</button>
             <button name="op" value="del" onclick="return confirm('确定删除？')">删除</button>
           </form>`
        : `<span class="mu">环境变量，不可改</span>`;
      return `<tr class="${dis ? "off" : ""}">
        <td class="u">${escapeHtml(u.id)}</td>
        <td class="u">${u.pwd ? escapeHtml(u.pwd) : "<span class='mu'>—</span>"}</td>
        <td>${escapeHtml(u.note || "")}</td>
        <td>${dis ? "已禁用" : "正常"}</td>
        <td>${today}</td>
        <td>${used}</td>
        <td>${ops}</td>
      </tr>`;
    })
    .join("");

  const total = users.list.filter((x: any) => x.enabled !== false).length;

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
.add{margin:16px 0;padding:12px;border:1px solid #e3e6ea;border-radius:8px;background:#fafbfc}
input[type=text]{padding:5px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:13px}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px}
</style>
<h1>用户管理</h1>
<div class="sub">共 ${users.list.length} 个用户，启用 ${total} 个 · 数据存于 KV，面板改动立即生效</div>

<form class="add" method="post" action="/admin/op">
  <input type="hidden" name="op" value="add">
  备注：<input type="text" name="note" placeholder="例如：朋友A" size="18">
  <button type="submit">新增用户（自动生成 UUID + 密码）</button>
</form>

<table>
<tr><th>UUID</th><th>Trojan 密码</th><th>备注</th><th>状态</th><th>今日</th><th>累计</th><th>操作</th></tr>
${rows || '<tr><td colspan="7" class="mu">还没有用户</td></tr>'}
</table>

<div class="sub" style="margin-top:18px">
新增后把 UUID / 密码发给对方：控制页 <code>${url.origin}/&lt;uuid&gt;</code>，订阅 <code>/&lt;uuid&gt;/cl</code>。
</div>
</body></html>`;
}

/* ==================================================================
 * §9  路由与响应
 * ================================================================== */

/**
 * 计算对客户端展示的配额总量：用量到顶就自动翻倍。
 * @param {object} env Worker 环境
 * @param {number} used 已用字节
 * @returns {number} 展示用总量
 */
export function effectiveQuota(env: Env, used: any) {
  const base = Number(env.quotaBytes) > 0 ? Number(env.quotaBytes) : 1024 ** 4;  // 默认 1 TB
  const u = Number(used);
  if (!Number.isFinite(u) || u <= 0) return base;
  let total = base;
  while (u >= total) total *= 2;     // 不设上限，直到覆盖实际用量
  return total;
}

/**
 * 生成订阅响应头（subscription-userinfo / 到期 / 标题）。
 * @param {object} env Worker 环境
 * @param {object} stats 用量对象
 * @returns {Record<string,string>} 响应头
 */
export function subHeaders(env: Env, stats: any) {
  const used = (stats.up || 0) + (stats.down || 0);
  const total = effectiveQuota(env, used);

  // expire=0 表示"无期限"。空值 / never / 0 / 非法日期 一律当无期限处理
  let exp = 0;
  const raw = String(env.expireAt || "").trim();
  if (raw && raw !== "0" && raw.toLowerCase() !== "never") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) exp = Math.floor(n);
    else {
      const t = Date.parse(raw);
      if (!Number.isNaN(t)) exp = Math.floor(t / 1000);
    }
  }
  return {
    "Subscription-Userinfo": `upload=${stats.up || 0}; download=${stats.down || 0}; total=${total}; expire=${exp}`,
    "Profile-Update-Interval": "12",
    "Profile-Title": "edge",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Access-Control-Allow-Origin": "*",
  };
}

/**
 * 渲染用量看板（进度条 + 各入口 RTT + 最近错误）。
 * @param {object} env Worker 环境
 * @param {string} id 用户 UUID
 * @param {object} s 用量对象
 * @param {object} learned RTT 学习结果
 * @returns {string} HTML
 */
export function renderStatsHtml(env: Env, id: any, s: any, learned: any, alive: any, nsMap: any) {
  const usedBytes = (s.up || 0) + (s.down || 0);
  const total = effectiveQuota(env, usedBytes);
  const pct = total > 0 ? Math.min(100, Math.round((usedBytes / total) * 100)) : 0;

  const rttRows = (Object.entries(learned || {}) as [string, any][])
    .sort((a, b) => a[1].rtt - b[1].rtt)
    .map(([tag, v]) => {
      const city = v.colo ? `${v.colo}${(COLO_CITY as Record<string, string>)[v.colo] ? "-" + (COLO_CITY as Record<string, string>)[v.colo] : ""}` : "-";
      const ok = v.ok || 0, bad = v.fail || 0;
      const rate = ok + bad > 0 ? Math.round((ok / (ok + bad)) * 100) + "% (" + ok + "/" + (ok + bad) + ")" : "-";
      const cls = ok + bad >= 5 && ok / (ok + bad) < 0.8 ? ' style="color:#dc2626"' : "";
      return `<tr><td class="u">${tag}</td><td>${city}</td><td>${v.rtt} ms</td><td>${v.hits}</td><td${cls}>${rate}</td></tr>`;
    })
    .join("");

  const nodeRows = (alive || [])
    .map((x: any) => {
      const k = x.h + ":" + x.p;
      const a1 = (S.nstat.get(k) || ZERO_STAT);
      const b1 = (nsMap && nsMap[k]) || {};
      const st = {
        ok: Math.max(a1.ok || 0, b1.ok || 0),
        fail: Math.max(a1.fail || 0, b1.fail || 0),
        bps: b1.bps || p90Of(a1) || 0,
      };
      const ok = st.ok || 0;
      const bad = st.fail || 0;
      const rate = ok + bad > 0 ? Math.round((ok / (ok + bad)) * 100) + "% (" + ok + "/" + (ok + bad) + ")" : "-";
      const kbps = st.bps ? Math.round(st.bps / 1024) + " KB/s" : "未用";
      return { x, k, score: scoreMerged(k, nsMap), kbps, rate, ok, bad, cc: x.cc || "" };
    })
    .sort((a: any, b: any) => a.score - b.score)
    .slice(0, 10)
    .map(
      (n: any) =>
        `<tr><td class="u">${n.k}</td><td>${n.cc || "-"}</td><td>${n.x.ms} ms</td><td>${n.kbps}</td><td>${n.rate}</td><td><b>${Math.round(n.score)}</b></td></tr>`
    )
    .join("");

  const errRows = S.errs.slice(-20)
    .reverse()
    .map((e) => `<tr><td>${new Date(e.t).toISOString().replace("T", " ").slice(0, 19)}</td><td class="u">${escapeHtml(e.m)}</td></tr>`)
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
<tr><th>合计</th><td>${fmtBytes(s.up + s.down)}${total ? ` / ${fmtBytes(total)}（${pct}%）` : ""}</td></tr>
<tr><th>连接数</th><td>${s.conns}</td></tr>
<tr><th>首次</th><td>${s.firstSeen ? new Date(s.firstSeen).toISOString().replace("T", " ").slice(0, 19) : "-"}</td></tr>
<tr><th>最近</th><td>${s.lastSeen ? new Date(s.lastSeen).toISOString().replace("T", " ").slice(0, 19) : "-"}</td></tr>
</table>
${total ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}
<h2>实测 RTT（按入口）</h2>
<table><tr><th>入口标签</th><th>机房</th><th>RTT</th><th>样本</th><th>成功率</th></tr>${rttRows || "<tr><td colspan=4>暂无数据</td></tr>"}</table>
<h2>节点评分（延迟 + 失败率 + 实测吞吐）</h2>
<table><tr><th>节点</th><th>地区</th><th>探测延迟</th><th>实测吞吐</th><th>成功率</th><th>评分</th></tr>${nodeRows || "<tr><td colspan=6>暂无数据</td></tr>"}</table>
<h2>最近错误</h2>
<table><tr><th>时间</th><th>内容</th></tr>${errRows || "<tr><td colspan=2>无</td></tr>"}</table>
</body>`;
}

/**
 * HTML 转义，防止注入。
 * @param {string} s 原文
 * @returns {string} 转义后的文本
 */
export function escapeHtml(s: any) {
  const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, (c) => MAP[c]);
}

/* ==================================================================
 * Meter：每个用户一个 Durable Object —— 全局唯一的流量帐本
 *   计量必须"全局且不丢"，KV 的 read-modify-write 在多 isolate 下做不到，
 *   DO 是单实例串行，天然正确。
 *   写入策略：内存累加，每 20 批或 5 分钟（alarm）落一次 storage。
 * ================================================================== */
