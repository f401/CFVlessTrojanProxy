import { escapeHtml, fmtBytes } from "./html";

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
      const s = statsMap[u.id] || {};
      const used = fmtBytes((s.up || 0) + (s.down || 0));
      const today = fmtBytes((s.todayUp || 0) + (s.todayDown || 0));
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

/**
 * 计算对客户端展示的配额总量：用量到顶就自动翻倍。
 * @param {object} env Worker 环境
 * @param {number} used 已用字节
 * @returns {number} 展示用总量
 */

/**
 * 生成订阅响应头（subscription-userinfo / 到期 / 标题）。
 * @param {object} env Worker 环境
 * @param {object} stats 用量对象
 * @returns {Record<string,string>} 响应头
 */

