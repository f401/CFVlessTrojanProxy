import { RATE_LIMIT, adminAuthed, newNonce, randomPwd, sessionToken, sha256Hex } from "../edge/auth";
import { loadUsers, saveUsers } from "../proxy/protocol";
import { eachLimit } from "../core/util";
import { cnt } from "../core/counter";
import { SC } from "../core/const";
import { readStats } from "../store/index";
import { escapeHtml, fmtBytes } from "../views/panel";
import { html } from "../edge/respond";
import type { RouteCtx } from "../edge/types";

/**
 * 功能：管理面板的视图对象 —— 把「登出 / 登录提交 / 用户增删改 / 面板渲染」四件事各自成方法。
 *
 * 拆开之前这是一个 132 行的 `admin(c)`：四个分支的前置条件完全不同（登出只读 cookie、
 * 登录要做挑战-应答与限速、用户操作要读改写整份用户表、面板要按用户数扇出 DO 往返），
 * 而它们共用同一个函数作用域，读的人无法一眼看出「哪一步会写 KV、哪一步会吃子请求预算」。
 * 构造函数只保存本次请求的上下文，所有分支都在 `run()` 里按原顺序分派。
 */
export class AdminView {
  private readonly c: RouteCtx;
  /** 管理密钥（未配置时整块面板关闭，见 `run()` 的第一个判断） */
  private readonly adminKey: string;

  /**
   * 功能：保存本次请求的上下文。
   * @param {RouteCtx} c 路由上下文（env / url / request / seg / pageKey 等）
   */
  constructor(c: RouteCtx) {
    this.c = c;
    this.adminKey = String(c.env.adminKey || "");
  }

  /**
   * 功能：按原 if 链的顺序分派到四个分支。
   * @returns {Promise<Response>} 响应
   */
  async run(): Promise<Response> {
    if (this.c.first !== "admin") return new Response("Not Found", { status: 404 });
    // 未配置 adminKey 时整个面板关闭：不给任何提示页之外的入口，避免被当成「管理入口存在但密码空」
    if (!this.adminKey) return html(renderAdminHint(), 503);
    // 短密钥直接拒绝：sha256(nonce:key) 这种挑战-应答能扛暴力破解的前提是密钥本身有熵
    if (this.adminKey.length < 12) {
      return new Response("adminKey 太短：请改用 16 位以上随机字符", { status: 503 });
    }
    const sub = (this.c.seg[1] || "").toLowerCase();
    if (sub === "logout") return this.logout();
    if (sub === "login" && this.c.request.method === "POST") return this.login();
    // 其余分支都要已登录：GET 走登录页，POST 直接 403（不给表单，避免误导）
    if (!(await adminAuthed(this.c.request, this.c.url, this.c.env))) {
      if (this.c.request.method === "POST") return new Response("Forbidden", { status: 403 });
      return html(renderLogin(newNonce(), ""));
    }
    if (sub === "op" && this.c.request.method === "POST") return this.usersOp();
    return this.panel();
  }

  /**
   * 功能：清掉会话 cookie 并回落到登录页。
   * @returns {Response} 303
   */
  private logout(): Response {
    return new Response(null, {
      status: 303,
      headers: {
        location: "/admin",
        "set-cookie": "adm=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
      },
    });
  }

  /**
   * 功能：登录提交 —— 只收 `nonce` 与 `sha256(nonce:密码)`，不传明文密码。
   * @returns {Promise<Response>} 成功时 303 + 会话 cookie，失败时回登录页并带原因
   */
  private async login(): Promise<Response> {
    const ip = this.c.request.headers.get("cf-connecting-ip") || "unknown";
    // 内存计数优先（同一 isolate 内精确），KV 只做跨 isolate 的粗粒度兜底
    if (!RATE_LIMIT.take(ip, 10)) {
      return html(renderLogin(newNonce(), "尝试次数过多，请 10 分钟后再试"), 429);
    }
    const f = await this.c.request.formData();
    const n = String(f.get("n") || "");
    const p = String(f.get("p") || "").toLowerCase();
    const ts = parseInt(n.split(".")[0], 16);
    if (!n || !p) return html(renderLogin(newNonce(), "缺少参数"), 400);
    // nonce 前 8 个 hex 是签发时间戳：超过 5 分钟就当作重放
    if (!ts || Date.now() - ts > 300000) {
      return html(renderLogin(newNonce(), "登录已过期，请重试"), 400);
    }
    const want = await sha256Hex(`${n}:${this.adminKey}`);
    if (p !== want) {
      return html(renderLogin(newNonce(), "密码错误"), 401);
    }
    // 成功才清限速：失败留痕是为了让「连错」在 10 分钟内持续受限
    RATE_LIMIT.reset(ip);
    const tok = await sessionToken(this.c.env);
    return new Response(null, {
      status: 303,
      headers: {
        location: "/admin",
        "set-cookie": `adm=${tok}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
      },
    });
  }

  /**
   * 功能：用户表的增 / 删 / 启停 / 重置密码。
   * @returns {Promise<Response>} 成功时 303 回到面板，读不到用户表时 503
   */
  private async usersOp(): Promise<Response> {
    const f = await this.c.request.formData();
    const op = String(f.get("op") || "");
    const target = String(f.get("id") || "").toLowerCase();
    const cur = await loadUsers(this.c.env);
    // 读 KV 失败且没有完整缓存时，cur.list 可能缺托管用户；此时任何
    // 增删改都会把缺失的用户从 KV 里整份删掉，必须拒绝
    if (cur.ok === false) {
      return new Response("用户表暂时读不到（KV 故障），为避免覆盖请稍后重试", { status: 503 });
    }
    // 只回写托管用户：手动配置的用户在 env 里，不该被这一页的写回覆盖掉
    let list = cur.list.filter((x) => x.managed).map((x) => ({ ...x }));
    if (op === "add") {
      list.push({
        id: crypto.randomUUID(),
        pwd: randomPwd(16),
        note: String(f.get("note") || "").slice(0, 40),
        enabled: true,
        managed: true,
        ts: Date.now(),
      });
    } else if (op === "del") {
      list = list.filter((x) => x.id !== target);
    } else if (op === "toggle") {
      list = list.map((x) => (x.id === target ? { ...x, enabled: x.enabled === false } : x));
    } else if (op === "reset") {
      list = list.map((x) => (x.id === target ? { ...x, pwd: randomPwd(16) } : x));
    }
    await saveUsers(this.c.env, list);
    // 用 ?k= 打开面板时，操作后的 303 也要带上 k，否则下一跳掉回登录页
    const k = this.c.url.searchParams.get("k") || "";
    const back = "/admin" + (k ? "?k=" + encodeURIComponent(k) : "");
    return new Response(null, { status: 303, headers: { location: back } });
  }

  /**
   * 功能：渲染面板（用户表 + 每人用量）。
   * @returns {Promise<Response>} 200
   */
  private async panel(): Promise<Response> {
    const users = await loadUsers(this.c.env);
    // 用量从 Meter DO 取（和 /stats 同一个口径）。以前读的是 `stats:<date>` 这个早已废弃的键，
    // 迁移到 snap/DO 之后它再也没人写，"今日用量" 永远是 0。
    const statsMap: Record<string, { up: number; down: number; todayUp: number; todayDown: number }> = {};
    // 并行读但限 8 并发：用户一多，串行 await 会把面板拖到几秒（每次都是一次 DO 往返）
    // 并发限制不限制**总量**：免费计划一次调用只有 50 个子请求，用户数超过预算时排在
    // 后面的读数会全部失败，而下面的 catch 只留一句注释 ⇒ 面板上那些人静默显示 0
    // （看起来像「这用户没流量」，实际是没读到）。所以按 ADMIN_STATS_MAX 截断，
    // 并把被截掉的人数记进计数器（v7.142）。
    const head = users.list.slice(0, SC.ADMIN_STATS_MAX);
    if (users.list.length > head.length) cnt("admStatsSkip", users.list.length - head.length);
    await eachLimit(head, 8, async (u) => {
      try {
        const s = await readStats(this.c.env, u.id);
        statsMap[u.id] = {
          up: s.up || 0,
          down: s.down || 0,
          todayUp: s.todayUp || 0,
          todayDown: s.todayDown || 0,
        };
      } catch (e) {
        /* 单个用户读失败不影响整页 */
      }
    });
    return html(renderAdmin(this.c.url, users, statsMap, this.c.pageKey));
  }
}

/**
 * 功能：/admin 路由入口 —— 登录（挑战-应答）+ 用户增删改。未设 adminKey 时整个面板关闭。
 * @param {RouteCtx} c 路由上下文
 * @returns {Promise<Response>} 响应
 */
export async function admin(c: RouteCtx): Promise<Response> {
  return new AdminView(c).run();
}

/* ==================================================================
 * 登录页与管理页的 HTML：从 src/views/panel.ts 搬来。
 * 原因：panel.ts 触到 560 行上限，而这三块只服务 /admin 这一条路由 ——
 * 面板页（PanelView）与用量看板留在 views 层，管理页跟着它的路由走。
 * ================================================================== */

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
