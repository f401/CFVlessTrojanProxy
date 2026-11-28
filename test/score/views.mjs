/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case008({ W, ok }) {
  const html1 = W.renderStatsHtml(
    {},
    "u",
    { up: 0, down: 0, todayUp: 0, todayDown: 0 },
    {},
    W.statsNodeRows([{ h: "a", p: 443, ms: 10, cc: "US" }], { "a:443": { bps: 2048 * 1024, n: 7 } }),
    [],
  );
  ok("面板显示 KB/s 与样本数", html1.includes("2048 KB/s (n=7)"), html1.match(/\d+ KB\/s[^<]*/)?.[0]);
  const html2 = W.renderStatsHtml(
    {},
    "u",
    { up: 0, down: 0, todayUp: 0, todayDown: 0 },
    {},
    W.statsNodeRows([{ h: "b", p: 443, ms: 10, cc: "US" }], {}),
    [],
  );
  ok("没有吞吐样本显示未用", html2.includes("未用"));
  const html3 = W.renderStatsHtml(
    {},
    "u",
    { up: 0, down: 0, todayUp: 0, todayDown: 0 },
    { "<img src=x onerror=alert(1)>": { rtt: 10, colo: "HKG", hits: 1, ok: 1, fail: 0, ts: 1 } },
    [],
    [],
  );
  ok("入口标签做了 HTML 转义", !html3.includes("<img src=x"), html3.slice(0, 80));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case109({ W, ok }) {
  const u1 = { id: "aaaaaaaa-0000-4000-8000-00000000000a", pwd: "", note: "n1", enabled: true, managed: true };
  const u2 = { id: "aaaaaaaa-0000-4000-8000-00000000000b", pwd: "", note: "n2", enabled: true, managed: true };
  const page = W.renderAdmin(new URL("https://h.example/admin"), { list: [u1, u2] }, {
    [u1.id]: { up: 1, down: 2, todayUp: 0, todayDown: 0 },
  });
  const row1 = page.slice(page.indexOf(u1.id), page.indexOf(u2.id));
  const row2 = page.slice(page.indexOf(u2.id));
  ok("读到的用户那行是真数字", /<td>\d/.test(row1), row1.slice(0, 60));
  ok("没读到的用户那行是「—」", row2.includes("<td>—</td>"));
  ok("没读到的用户那行不会假装 0 B", !row2.includes("0 B"));
  ok("页面说明有几个用户这次没读到", page.includes("1 个用户这次没读到用量"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case141({ fs, ok, eq, W }) {
  const srcSub = fs.readFileSync("src/routes/subscription.ts", "utf8");
  ok("面板路径不再取池子的当前中继", srcSub.includes("pxGet(") === false, "");
  ok("面板路径不再塞计数器快照", srcSub.includes("cntView(") === false, "");

  const srcTypes = fs.readFileSync("types/app.d.ts", "utf8");
  const srcPanel = fs.readFileSync("src/views/panel.ts", "utf8");
  const head = srcTypes.indexOf("interface PanelInfo");
  ok("PanelInfo 类型还在", head > 0, "");
  const body = srcTypes.slice(head, srcTypes.indexOf("}", head));
  const fields = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s{2}([a-z][A-Za-z0-9]*)\s*:/);
    if (m) fields.push(m[1]);
  }
  eq("PanelInfo 字段都被解析到", fields.length > 8, true);
  const missing = fields.filter((f) => srcPanel.includes("this.info." + f) === false);
  eq("每个字段都有渲染点", missing.join(","), "");
  eq("curPx 已从类型里删掉", /\bcurPx\b/.test(srcTypes), false);

  // 行为面：面板真的还能渲染，且没有把 undefined 印到页面上
  const env = { nodes: "", uuids: "" };
  const url = new URL("https://panel.example.com/u1");
  const info = {
    regions: ["HK"],
    curLat: "1.2.3.4",
    curTput: "5.6.7.8",
    colo: "HKG",
    funnel: "直连 50% · 中转 50%",
    aliveCount: 3,
    used: "1 MB",
    today: "1 MB",
    quota: "100 MB",
    expire: "长期",
    policy: "滞回 15%",
  };
  const html = W.renderHtml(env, url, "u1", "panel.example.com", "k", info);
  ok("面板渲染出当前节点行", html.includes("当前节点 · 吞吐优先"), "");
  ok("面板里没有 undefined", html.includes("undefined") === false, "");
  ok("存活条数进了页面", html.includes("3"), "");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case163({ W, eq, fs, ok }) {
  const UUID234 = "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1";
  const HOST234 = "sim.example.com";
  const mkKv234 = () => {
    const m = new Map();
    return {
      async get(k) { return m.has(k) ? m.get(k) : null; },
      async put(k, v) { m.set(k, v); },
      async delete(k) { m.delete(k); },
      async list() { return { keys: [], list_complete: true }; },
    };
  };
  const baseEnv234 = { uuids: UUID234, trojan: UUID234 + ":test123", nodes: "", adminKey: "", STATS: mkKv234(), defaultMode: "lat", regions: "", proxyip: "auto" };
  const mkReq234 = (p) => ({ url: "https://" + HOST234 + p, headers: { get: () => null }, cf: { asn: 4134, city: "Guangzhou", colo: "HKG", clientTcpRtt: 42 } });
  const ctx234 = { waitUntil: () => {} };
  const run234 = async (env) => (await W.default.fetch(mkReq234("/" + UUID234 + "/logs"), env, ctx234)).json();
  const badEnv = { ...baseEnv234, METER: { idFromName: (n) => n, get: () => ({ async fetch() { throw new Error("do boom"); } }) } };
  const cntBefore234 = Number(W.cntView().logsDoFail) || 0;
  const bad1 = await run234(badEnv);
  eq("DO 读失败时 doSrc 标成 fail", bad1.doSrc, "fail");
  eq("DO 读失败时 fromDo 仍是 0、但列表里有留痕", String(bad1.fromDo) + "/" + String(bad1.count > 0), "0/true");
  eq("DO 读失败计 logsDoFail", (Number(W.cntView().logsDoFail) || 0) - cntBefore234, 1);
  const jnone = await run234({ ...baseEnv234, METER: undefined });
  eq("没有 METER 绑定时 doSrc 标成 none", jnone.doSrc, "none");
  const goodEnv = { ...baseEnv234, METER: { idFromName: (n) => n, get: () => ({ async fetch() { return new Response(JSON.stringify({ e: [{ t: Date.now(), m: "probe do line", tag: "x" }] })); } }) } };
  const jgood = await run234(goodEnv);
  eq("DO 正常时 doSrc 标成 ok", jgood.doSrc, "ok");
  eq("DO 正常时 fromDo 带回一条", jgood.fromDo, 1);
  const srcLogs234 = fs.readFileSync("src/routes/logs.ts", "utf8");
  ok("DO 读失败要计数", srcLogs234.includes("cnt(\"logsDoFail\");"), "");
  ok("DO 读失败要留痕（与快照失败同一口径）", srcLogs234.includes("logErr(\"logs do read failed\", \"kv\");"), "");
  ok("响应里带上 doSrc", srcLogs234.includes("doSrc, items: out }"), "");
  const st234 = fs.readFileSync("src/core/counter.ts", "utf8");
  ok("logsDoFail 已登记进 cntKeys", st234.includes("\"logsDoFail\","), "");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case219({ fs, eq, ok, W }) {
  const subCommon = fs.readFileSync("src/views/sub-common.ts", "utf8");
  const subSrc308 = fs.readFileSync("src/views/sub.ts", "utf8");
  const subviewSrc = fs.readFileSync("src/views/sub.ts", "utf8");
  const exists = (f) => { try { fs.statSync(f); return true; } catch { return false; } };
  eq("sub-links.ts 已合并", exists("src/views/sub-links.ts"), false);
  eq("sub-singbox.ts 已合并", exists("src/views/sub-singbox.ts"), false);
  ok("links 与 singbox 的渲染函数都在 sub-common 里", subCommon.includes("export function renderLinks(") && subCommon.includes("export function renderSingbox("), "两个渲染函数没进同一个文件");
  ok("共享 helper 也还在同一个文件里", subCommon.includes("export function edgeCount(") && subCommon.includes("export function pickProtos("), "helper 被拆出去了");
  ok("合并后的文件仍受 560 行上限约束", subCommon.split(/\r?\n/).length <= 560, "sub-common 超长");
  eq("sub.ts 从 sub-common 再导出 singbox", subSrc308.includes('export { renderSingbox } from "./sub-common";'), true);
  eq("sub.ts 从 sub-common 再导出 links", subSrc308.includes('export { renderLinks } from "./sub-common";'), true);
  eq("sub.ts 从 sub-common 转出 singbox", subviewSrc.includes('export { renderSingbox } from "./sub-common";'), true);
  eq("sub.ts 从 sub-common 转出 links", subviewSrc.includes('export { renderLinks } from "./sub-common";'), true);

  // 行为面：三个格式都还能渲染出来，而且和 SUBVIEW 的分发结果逐字相同
  const env308 = { uuid: "4241b903-8d39-4a17-8f4c-bb33b1630c33", nodes: "", pwd: "tj-308" };
  const url308 = new URL("https://edge.example.com/4241b903-8d39-4a17-8f4c-bb33b1630c33/sub");
  const id308 = "4241b903-8d39-4a17-8f4c-bb33b1630c33";
  const lk = W.renderLinks(env308, url308, id308, "edge.example.com", {}, ["HK"]);
  const sb = W.renderSingbox(env308, url308, id308, "edge.example.com", {}, ["HK"]);
  ok("links 仍是 vless:// 链接串", atob(lk).includes("vless://"), "links 输出丢了 vless 头");
  ok("singbox 仍是可解析 JSON", (() => { try { JSON.parse(sb); return true; } catch { return false; } })(), "singbox 输出不是 JSON");
  eq("SUBVIEW 的 links 分发就是 renderLinks", new W.SubscriptionView().render({ env: env308, url: url308, id: id308, host: "edge.example.com", learned: {}, regions: ["HK"] }, "links"), lk);
  eq("SUBVIEW 的 singbox 分发就是 renderSingbox", new W.SubscriptionView().render({ env: env308, url: url308, id: id308, host: "edge.example.com", learned: {}, regions: ["HK"] }, "singbox"), sb);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case220({ eq, fs, ok, W }) {
  const g = "309";
  const gone = [
    "src/core/transport-types.ts",
    "src/core/transport-tunnelfetch.ts",
    "src/core/tf.ts",
    "src/views/panel-admin.ts",
    "src/views/panel-stats.ts",
    "src/routes/debug-tables.ts",
    "src/routes/debug-actions.ts",
    "src/routes/debug-meter.ts",
  ];
  eq(`[${g}] 八份被并掉的文件都不在了`, gone.every((f) => !fs.existsSync(f)), true);

  const tf = fs.readFileSync("src/core/transport.ts", "utf8");
  eq(`[${g}] 传输层：契约、两个实现、注册表与门面同住一个文件`,
    ["export interface TransportProbe", "export interface ProbeTransport", "export class TunnelFetchTransport",
      "export class GatewayFetchTransport", "export class TransportRegistry", "export async function probeTf",
      "export const TRANSPORTS"].every((x) => tf.includes(x)), true);
  ok(`[${g}] 传输层里没有循环：实现不再 import 别的 transport 文件`,
    !/from "\.\/transport-(types|tunnelfetch)"/.test(tf));

  const panel = fs.readFileSync("src/views/panel.ts", "utf8");
  eq(`[${g}] 面板：页与看板两个入口在 panel.ts`,
    ["renderHtml", "renderStatsHtml"].every((x) => new RegExp("export function " + x + "\\(").test(panel)) && ["renderLogin", "renderAdmin", "renderAdminHint"].every((x) => new RegExp("export function " + x + "\\(").test(fs.readFileSync("src/routes/admin.ts", "utf8"))), true);
  ok(`[${g}] 页面壳与五个渲染入口同住 panel.ts（页壳不再是单独文件）`,
    !fs.existsSync("src/views/pageview.ts") && !fs.existsSync("src/views/html.ts") && panel.includes("export function renderHtml(") && panel.includes("export function fmtBytes("));

  const dbg = fs.readFileSync("src/routes/debug.ts", "utf8");
  eq(`[${g}] 调试路由：四段都在一个文件`,
    ["export class DebugTables", "export class DebugActions", "export class DebugMeterProbes", "export async function debug("].every((x) => dbg.includes(x)), true);
  eq(`[${g}] 上下文类型只声明一次`, (dbg.match(/type DebugCtx = RouteCtx & \{ id: string \};/g) || []).length, 1);
  ok(`[${g}] 调试路由仍把测量放在另一个文件`, fs.existsSync("src/routes/debug-nets.ts"));

  // 文件数：合完之后应当明显少于 7.296 那轮的 176
  const tsFiles = [];
  const collect = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const q = dir + "/" + e.name;
      if (e.isDirectory()) collect(q);
      else if (e.name.endsWith(".ts")) tsFiles.push(q);
    }
  };
  collect("src");
  ok(`[${g}] src 下的 ts 文件数已降到 125 以内（本次合并前是 130）`, tsFiles.length <= 125);

  // 能力面：三个单例与两个传输都还在窗口里
  ok(`[${g}] 三个调试单例仍可用`,
    W.DEBUG.tables instanceof W.DebugTables && W.DEBUG.actions instanceof W.DebugActions && W.DEBUG.probes instanceof W.DebugMeterProbes);
  ok(`[${g}] 注册表仍能取到两个实现`,
    W.TRANSPORTS.names().length === 3 &&
      ["tunnelfetch", "gateway", "http80"].every((n) => Boolean(W.TRANSPORTS.get(n))));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case223({ fs, ok, eq, W }) {
  const g = 312;
  const probeSrc312 = fs.readFileSync("src/px/probe.ts", "utf8");
  const panelSrc312 = fs.readFileSync("src/views/panel.ts", "utf8");
  const constSrc312 = fs.readFileSync("src/core/const.ts", "utf8");
  const healthSrc312 = fs.readFileSync("src/routes/health.ts", "utf8");

  ok(`[${g}] 三份被并掉的旧文件都不在了`,
    !fs.existsSync("src/px/aliveplan.ts") && !fs.existsSync("src/views/html.ts") && !fs.existsSync("src/views/pageview.ts"));

  eq(`[${g}] 池子目标规模回到常量表（只声明一次）`,
    W.ALIVE_TARGET === 16 && (constSrc312.match(/export const ALIVE_TARGET = 16;/g) || []).length === 1, true);

  ok(`[${g}] 源健康度自己回答「补货是不是一直失败」`,
    probeSrc312.includes("  stat(now = Date.now()): { bad: number; retryAt: number } {"));
  ok(`[${g}] stat 不数已到期的条目（到期即视为健康源重试）`,
    probeSrc312.includes("if (!v.until || v.until <= now) continue;"));
  ok(`[${g}] /health 走单例方法而不是模块函数`,
    healthSrc312.includes("src: SOURCES.stat(),") && !healthSrc312.includes("srcStat("));

  ok(`[${g}] 面板：两个页入口 + 转义/字节格式化 + 页壳同住 panel.ts`,
    ["renderHtml", "renderStatsHtml"].every((x) => panelSrc312.includes("export function " + x + "(")) &&
      panelSrc312.includes("export function fmtBytes(") &&
      panelSrc312.includes("export function escapeHtml(") &&
      panelSrc312.includes("export function renderStatsHtml("));
  ok(`[${g}] 面板不再 import 已并掉的两个文件`,
    !panelSrc312.includes('from "./pageview"') && !panelSrc312.includes('from "./html"'));

  const tsFiles312 = [];
  const walk312 = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const q = dir + "/" + e.name;
      if (e.isDirectory()) walk312(q);
      else if (e.name.endsWith(".ts")) tsFiles312.push(q);
    }
  };
  walk312("src");
  ok(`[${g}] 源码文件预算含独立地区视图（124 以内）（当前 ${tsFiles312.length}）`, tsFiles312.length <= 124);

  // 行为面：一次失败就进冷却统计；成功清零后不再计入
  const src312 = "https://example.invalid/poolsrc-312.txt";
  W.SOURCES.note(src312, false);
  const st312 = W.SOURCES.stat();
  ok(`[${g}] 失败一次就出现在概览里（bad ≥ 1，retryAt > 0）`, st312.bad >= 1 && st312.retryAt > Date.now(), true);
  W.SOURCES.note(src312, true);
  const clean312 = W.SOURCES.snap()[src312];
  ok(`[${g}] 成功清零后这一条不再占冷却位（until 归零）`, clean312 && clean312.until === 0 && clean312.n === 0, true);
  ok(`[${g}] stat 的返回形状固定`, Object.keys(W.SOURCES.stat()).sort().join(",") === "bad,retryAt");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case235({ fs, ok, readView, eq, W }) {
  const panelSrc = fs.readFileSync("src/views/panel.ts", "utf8");
  ok("面板页成了 PanelView 类", panelSrc.includes("export class PanelView"), "");
  for (const m of ["header", "identity", "subscriptions", "statusTable", "monitor", "params", "behaviour", "footer"]) {
    ok("分区方法存在：" + m, panelSrc.includes("private " + m + "(): Record<string, string>"), "");
  }
  const fnAt = panelSrc.indexOf("export function renderHtml(");
  ok("renderHtml 仍是入口", fnAt > 0, "");
  const fnBody = panelSrc.slice(fnAt, fnAt + 260);
  ok("renderHtml 只做委托", fnBody.includes("return new PanelView(") && fnBody.includes("<!doctype") === false, "");
  ok("静态样式抽进 panel.html", readView("src/views/html/panel.html").includes(":root{--bd"), "");
  eq("组装只有一次 renderTemplate", (panelSrc.match(/renderTemplate\(panelTpl,/g) || []).length, 1);
  const clsBody = panelSrc.slice(panelSrc.indexOf("export class PanelView"), fnAt);
  ok("不再有 const i = info 这个别名", panelSrc.includes("const i = info") === false, "");
  ok("插值都走 this.info", clsBody.includes("this.info.") && /\$\{i\./.test(clsBody) === false, "");
  ok("类的文档写清为什么改成", panelSrc.includes("为什么改成"), "");

  const env324 = { nodes: "", uuids: "" };
  const url324 = new URL("https://panel.example.com/u1");
  const info324 = {
    regions: ["HK"],
    curLat: "1.2.3.4:443",
    curTput: "1.2.3.4:443",
    colo: "HKG",
    funnel: "-",
    aliveCount: 3,
    used: "1 B",
    today: "1 B",
    quota: "不限",
    expire: "长期",
    policy: "失败 5 次才换",
  };
  const viaFn = W.renderHtml(env324, url324, "u1", "site.example.com", "pw", info324);
  const viaCls = new W.PanelView(env324, url324, "u1", "site.example.com", "pw", info324).render();
  eq("薄入口与类渲染完全一致", viaFn === viaCls, true);
  eq(
    "六个分区都在",
    ["身份", "订阅（导入客户端用这个）", "运行概览", "监控与调试", "参数", "行为说明"].filter((s) =>
      [...viaFn.matchAll(/<h2(?:\s[^>]*)?>([^<]+)<\/h2>/g)].some(match => match[1] === s)
    ).length,
    6
  );
  const esc324 = W.renderHtml(env324, url324, "u1", "<b>x</b>", "pw", info324);
  eq("站点名被转义", esc324.includes("&lt;b&gt;x&lt;/b&gt;") && esc324.includes("<b>x</b>") === false, true);
  eq("带查询串的路径用 &k=", viaFn.includes("/stats?format=html&k=pw"), true);
  eq("普通路径用 ?k=", viaFn.includes("/cl?k=pw"), true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case244({ fs, ok, eq, W }) {
  const srcSub333 = fs.readFileSync("src/routes/subscription.ts", "utf8").replace(/\r\n/g, "\n");
  /**
   * 功能：按签名切出一段函数/方法的源码（到下一个两格收尾的 `}` 为止）。
   * @param sig 签名行的一部分
   * @returns 源码片段；找不到返回空串
   */
  const body333 = (sig) => {
    const at = srcSub333.indexOf(sig);
    if (at < 0) return "";
    const rest = srcSub333.slice(at);
    const end = rest.search(/\n  \}\n/);
    return end < 0 ? rest : rest.slice(0, end);
  };

  ok("SubscriptionRoutes 是导出类", /export class SubscriptionRoutes \{/.test(srcSub333));
  const entry333 = srcSub333.slice(srcSub333.indexOf("export async function subscription("));
  ok(
    "入口只剩一行委托",
    entry333.includes("return new SubscriptionRoutes(c).run(kind);") && entry333.slice(0, entry333.indexOf("\n}")).split("\n").length <= 4,
  );
  const run333 = body333("async run(kind: string)");
  ok("run 按 FEEDS 分派并留 404 兜底", run333.includes("if (FEEDS[kind]) return this.feed(kind);") && run333.includes("status: 404"));

  const feeds333 = srcSub333.slice(srcSub333.indexOf("const FEEDS"), srcSub333.indexOf("};", srcSub333.indexOf("const FEEDS")));
  eq("三条格式 + 三个口令变体都在表里", (feeds333.match(/^  \w+:/gm) || []).length, 6);
  ok(
    "三种格式各登记一次渲染器与响应体类型",
    feeds333.includes('clash", json: false') && feeds333.includes('singbox", json: true') && feeds333.includes('links", json: false'),
  );

  const page333 = body333("private async page()");
  ok(
    "控制页只取用量与存活表两次往返",
    page333.includes("Promise.all([readStats(env, id), aliveList(env)])") && page333.includes("html(renderHtml(") && page333.includes("CSP_STATIC") && !page333.includes("PAGES.panel("),
  );
  ok("控制页不再取池子的当前中继（白付一次往返）", !page333.includes("px:cur") && !page333.includes("SEL.current("));

  const feed333 = body333("private async feed(");
  ok("三种订阅共用一条渲染路径", feed333.includes("this.view.render(") && feed333.includes("subHeaders(env, s)") && feed333.includes("spec.json ?"));
  eq("三种格式不再各抄一份渲染", (srcSub333.match(/this\.view\.render\(/g) || []).length, 1);
  eq("用量头只在这一条路径上挂（两个响应分支各一次）", (srcSub333.match(/subHeaders\(/g) || []).length, 2);

  const stats333 = body333("private async stats()");
  ok("JSON 分支零额外往返（拿不到存活表也不读快照）", !stats333.includes("aliveList(") && !stats333.includes("nodeSnapGet("));
  const statsHtml333 = body333("private async statsHtml(");
  ok(
    "HTML 明细才并跨 isolate 快照",
    statsHtml333.includes("aliveList(env)") && statsHtml333.includes("nodeSnapGet(env, id)") && statsHtml333.includes("nsOf(") && statsHtml333.includes("statsNodeRows("),
  );

  // 行为面：构造一个最小 UserCtx（不绑 KV、不绑 DO，用量落在「零」上）
  const env333 = { uuid: "4241b903-8d39-4a17-8f4c-bb33b1630c33", pwd: "pw", adminKey: "k333" };
  /**
   * 功能：造一个最小用户上下文。
   * @param kind 路由种类
   * @returns UserCtx 形状的对象
   */
  const ctx333 = (kind) => ({
    request: new Request("https://e333.example/" + kind),
    env: env333,
    ctx: { waitUntil() {}, passThroughOnException() {} },
    url: new URL("https://e333.example/?k=k333"),
    host: "e333.example",
    seg: [kind],
    first: kind,
    auth: { ok: true, list: [], trojan: new Map(), uuids: new Set(), byId: new Map() },
    pageKey: "k333",
    keyOk: true,
    cf: {},
    id: "4241b903-8d39-4a17-8f4c-bb33b1630c33",
    learned: {},
    regions: [],
  });

  const unknown333 = await W.subscription(ctx333("bogus"), "bogus");
  eq("未知种类仍然 404", unknown333.status, 404);

  const cl333 = await W.subscription(ctx333("cl"), "cl");
  const clBody333 = await cl333.text();
  eq("clash 订阅是纯文本", cl333.headers.get("content-type"), "text/plain;charset=utf-8");
  ok("clash 订阅带 proxies 与策略组", clBody333.includes("proxies:") && clBody333.includes("proxy-groups:"));

  const sb333 = await W.subscription(ctx333("sb"), "sb");
  const sbBody333 = await sb333.text();
  eq("sing-box 订阅是 JSON", sb333.headers.get("content-type"), "application/json;charset=utf-8");
  ok("sing-box 订阅可解析且带 outbounds", Array.isArray(JSON.parse(sbBody333).outbounds));

  const ty333 = await W.subscription(ctx333("ty"), "ty");
  const tyText333 = Buffer.from((await ty333.text()).trim(), "base64").toString("utf8");
  ok("明文链接订阅是 base64 且解出 vless 链接", tyText333.includes("vless://"), tyText333.slice(0, 40));

  const st333 = await W.subscription(ctx333("stats"), "stats");
  const stBody333 = JSON.parse(await st333.text());
  ok("用量 JSON 带 id 与四个计数", stBody333.id === ctx333("stats").id && stBody333.up === 0 && stBody333.down === 0 && stBody333.conns === 0);

  const pg333 = await W.subscription(ctx333("page"), "page");
  const pgBody333 = await pg333.text();
  eq("控制页是 HTML", pg333.headers.get("content-type"), "text/html;charset=utf-8");
  ok("控制页带用量分区", pgBody333.includes("用量"), String(pgBody333.length));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case260({ fs, ok, W }) {
  // ---- 第 353 组：页面视图由路由对象自己持有，模块级 PAGES 退场 ----
  const panelSrc353 = fs.readFileSync("src/views/panel.ts", "utf8");
  const subSrc353 = fs.readFileSync("src/routes/subscription.ts", "utf8");
  const walk353 = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) out.push(...walk353(p));
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const allSrc353 = walk353("src").map((p) => fs.readFileSync(p, "utf8")).join("\n");
  ok("[353] 视图模块不再导出模块级单例", !panelSrc353.includes("export const PAGES = new PageView();"), "panel.ts 里还有单例");
  ok("[353] 视图没有薄包装类", !panelSrc353.includes("export class PageView {"), "");
  ok("[353] 路由直接引入纯渲染函数", subSrc353.includes('import { renderHtml, renderStatsHtml, fmtBytes } from "../views/panel";'), "");
  ok("[353] 路由不再构造无状态包装", !subSrc353.includes("new PageView()"), "");
  ok("[353] 两处渲染都直接调用", subSrc353.includes("html(renderHtml(") && subSrc353.includes("html(renderStatsHtml(") && !/[^.]\bPAGES\./.test(subSrc353), "渲染接线丢失");
  ok("[353] 全仓没有模块级 PAGES 单例", !allSrc353.includes("export const PAGES ="), "src/ 里还有");
  ok("[353] 窗口里 PAGES 已退场", W.PAGES === undefined, "W.PAGES 仍在");
  ok("[353] 窗口提供两种纯渲染函数", typeof W.renderHtml === "function" && typeof W.renderStatsHtml === "function", "");
  ok("[353] 不再导出冗余构造器", W.PageView === undefined, "");
  ok("[353] 独立实例仍能渲染面板与统计", (() => {
    const env = { uuid: "u353", pwd: "p353" };
    const url = new URL("https://s353.example/u353/page");
    const panel = W.renderHtml(env, url, "u353", "s353.example", "k353", null);
    const stats = W.renderStatsHtml(env, "u353", { up: 0, down: 0, conns: 0 }, {}, [], []);
    return panel.includes("<!doctype") && stats.includes("<!doctype");
  })(), "渲染不出来");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case265({ fs, ok, eq, W }) {
  const subSrc358 = fs.readFileSync("src/views/sub.ts", "utf8");
  const routeSrc358 = fs.readFileSync("src/routes/subscription.ts", "utf8");
  ok(
    "[358] 渲染器不再以模块级单例存在",
    !/^export const SUBVIEW = new SubscriptionView\(\);/m.test(subSrc358),
    "SUBVIEW 还在",
  );
  ok(
    "[358] 类本身仍在（能力没删，只是换了持有者）",
    subSrc358.includes("export class SubscriptionView {"),
    "类不见了",
  );
  ok(
    "[358] 路由按类名引入渲染器",
    routeSrc358.includes('import { SubscriptionView, trojanPasswordOf } from "../views/sub";'),
    "import 形态不对",
  );
  ok(
    "[358] 路由类自己持有渲染器字段",
    routeSrc358.includes("private readonly view = new SubscriptionView();"),
    "字段不在",
  );
  eq(
    "[358] 三种格式的渲染只经一处字段调用",
    (routeSrc358.match(/this\.view\.render\(/g) || []).length,
    1,
  );
  ok(
    "[358] 不再直接引用模块级单例",
    !routeSrc358.includes("SUBVIEW.render("),
    "还有裸单例调用",
  );
  ok(
    "[358] 测试窗口只剩类，单例已退场",
    W.SUBVIEW === undefined && typeof W.SubscriptionView === "function",
    "窗口形态不对",
  );
  const envRet358 = { uuid: "u1", pwd: "pw", host: "edge358.example.com" };
  const urlRet358 = new URL("https://edge358.example.com/u1/cl");
  const inRet358 = { env: envRet358, url: urlRet358, id: "u1", host: "edge358.example.com", learned: {}, regions: ["HK"] };
  const viewA358 = new W.SubscriptionView();
  eq(
    "[358] clash 分发就是 renderClash",
    viewA358.render(inRet358, "clash"),
    W.renderClash(envRet358, urlRet358, "u1", "edge358.example.com", {}, ["HK"], undefined),
  );
  const viewB358 = new W.SubscriptionView();
  ok("[358] 两个实例互不影响", viewA358 !== viewB358, "同一实例");
  eq(
    "[358] 未知格式回落到 clash（历史行为）",
    viewB358.render(inRet358, "nope"),
    viewB358.render(inRet358, "clash"),
  );
  eq(
    "[358] 类上只有 render 与私有的 table",
    Object.getOwnPropertyNames(W.SubscriptionView.prototype).sort().join(","),
    "constructor,render,table",
  );
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case276({ ok, W, eq }) {
  // 结构：三个枚举与六个源注册表都挂在窗口上
  ok("[371] IpKind 枚举五个成员", W.IpKind && W.IpKind.Residential === "residential" && W.IpKind.Hosting === "hosting" && W.IpKind.Unknown === "unknown", "IpKind 缺失");
  ok("[371] IpLevel 枚举三个成员", W.IpLevel && W.IpLevel.Good === "good" && W.IpLevel.Normal === "normal" && W.IpLevel.Risky === "risky", "IpLevel 缺失");
  ok("[371] IpFamily 用 IPv4/IPv6 全名", W.IpFamily && W.IpFamily.IPv4 === "v4" && W.IpFamily.IPv6 === "v6", "IpFamily 成员名不对");
  eq("[371] 六源注册表齐备", W.QUALITY_SOURCES.length, 6);
  ok("[371] 每源都有 name/url/parse", W.QUALITY_SOURCES.every((s) => s.name && typeof s.url === "function" && typeof s.parse === "function"), "源结构不全");

  // 六源真实返回格式的解析（用 2026-11-19 实测样本）
  const ipapi = W.QUALITY_SOURCES.find((s) => s.name === "ipapi-com");
  const sigIpapi = ipapi.parse({ status: "success", isp: "Google LLC", mobile: false, proxy: true, hosting: true });
  eq("[371] ip-api 机房→Hosting", sigIpapi.kind, W.IpKind.Hosting);
  eq("[371] ip-api proxy 位", sigIpapi.proxy, true);
  eq("[371] ip-api 失败行弃用", ipapi.parse({ status: "fail" }), null);
  const ipLocate = W.QUALITY_SOURCES.find((s) => s.name === "iplocate");
  const sigLoc = ipLocate.parse({ company: { type: "residential" }, privacy: { is_abuser: false, is_tor: true, is_proxy: false, is_vpn: true } });
  eq("[371] iplocate 住宅→Residential", sigLoc.kind, W.IpKind.Residential);
  eq("[371] iplocate tor→risky", sigLoc.risky, true);
  eq("[371] iplocate vpn 位", sigLoc.vpn, true);

  // mergeQuality：风险位优先、住宅/商企 Good、机房 Normal、无信号不臆测
  const now371 = Date.now() - 60_000;
  const qGood = W.mergeQuality([{ kind: W.IpKind.Residential, proxy: false, vpn: false, risky: false }], now371);
  eq("[371] 住宅合并为 Good", qGood.level, W.IpLevel.Good);
  const qHost = W.mergeQuality([{ kind: W.IpKind.Hosting, proxy: false, vpn: false, risky: false }], now371);
  eq("[371] 机房合并为 Normal", qHost.level, W.IpLevel.Normal);
  const qRisk = W.mergeQuality([{ kind: W.IpKind.Residential, proxy: false, vpn: false, risky: true }], now371);
  eq("[371] 风险位压过 Good", qRisk.level, W.IpLevel.Risky);
  const qNone = W.mergeQuality([], now371);
  eq("[371] 无信号 kind 不臆测", qNone.kind, W.IpKind.Unknown);
  eq("[371] 无信号按 Normal 用", qNone.level, W.IpLevel.Normal);

  // IpQualityTable：读写、TTL 过期、单源冷却、快照只导有效行
  {
    const t = new W.IpQualityTable();
    t.note("1.2.3.4:443", qGood);
    eq("[371] 质量表读回", t.get("1.2.3.4:443", now371).level, W.IpLevel.Good);
    eq("[371] 3 天后过期", t.get("1.2.3.4:443", now371 + 3 * 24 * 3600_000 + 1), null);
    eq("[371] 源初始不冷却", t.sourceCooling("ipapi-com", now371), false);
    t.failSource("ipapi-com", now371);
    eq("[371] 失败后冷却", t.sourceCooling("ipapi-com", now371 + 1000), true);
    eq("[371] 5 分钟后解除", t.sourceCooling("ipapi-com", now371 + 5 * 60_000 + 1), false);
    // 直接塞一条已过期的行进表（绕过 get 的即时删除），验证 snapshot 只导有效行
    t.rows.set("9.9.9.9:443", { kind: W.IpKind.Hosting, level: W.IpLevel.Normal, proxy: false, vpn: false, at: now371 - 4 * 24 * 3600_000 });
    t.note("5.6.7.8:443", qGood);
    const snap371 = t.snapshot(now371);
    eq("[371] 快照只导有效行", Object.keys(snap371).length, 1);
    ok("[371] 快照跳过过期行", !snap371["9.9.9.9:443"] && !!snap371["5.6.7.8:443"], "过期行不该出现在快照");
  }

  // ProbeCoverage：最旧优先轮转、分族统计、clear
  {
    const c = new W.ProbeCoverage();
    c.note("a:443", W.IpFamily.IPv4, now371 - 2000);
    c.note("b:443", W.IpFamily.IPv6, now371 - 1000);
    eq("[371] 覆盖未探优先", c.pick(["a:443", "b:443", "c:443"], 2)[0], "c:443");
    const st = c.stats(["a:443", "b:443", "c:443"]);
    eq("[371] 覆盖总数", st.total, 3);
    eq("[371] 覆盖已探", st.probed, 2);
    eq("[371] 覆盖 v4/v6 分列", st.v4 + st.v6, 2);
    c.clear();
    eq("[371] 覆盖清空", c.rows.size, 0);
  }

  // ConnObservation：colo|node|site 键、rttOf、TTL
  {
    const co = new W.ConnObservation();
    co.note("HKG", "1.2.3.4:443", "x.com", 200, 321, W.IpFamily.IPv4, now371);
    eq("[371] 连通性 rttOf", co.rttOf("HKG", "1.2.3.4:443", "x.com", now371), 321);
    eq("[371] 2xx 记 ok", co.get("HKG", "1.2.3.4:443", "x.com", now371).ok, true);
    co.note("HKG", "9.9.9.9:443", "x.com", 403, 100, W.IpFamily.IPv4, now371);
    eq("[371] 403 仍可达", co.get("HKG", "9.9.9.9:443", "x.com", now371).ok, true);
    co.note("HKG", "8.8.8.8:443", "x.com", 0, 0, W.IpFamily.IPv4, now371);
    eq("[371] code=0 不可达", co.get("HKG", "8.8.8.8:443", "x.com", now371).ok, false);
    eq("[371] 6h 后过期", co.rttOf("HKG", "1.2.3.4:443", "x.com", now371 + 6 * 3600_000 + 1), null);
  }

  // QualityProbe：缓存命中零请求；注入的 io 未调用即证明
  {
    const t = new W.IpQualityTable();
    const probe = new W.QualityProbe();
    const saveRows = W.QUALITY.rows;
    t.note("cached:443", qGood, now371);
    W.QUALITY.rows = t.rows;
    let calls = 0;
    const io = { fetch: async () => { calls++; throw new Error("should not fetch"); } };
    const r = await probe.qualityOf("cached:443", "1.1.1.1", io, W.IpFamily.IPv4, now371);
    eq("[371] 缓存命中直接返回", r.level, W.IpLevel.Good);
    eq("[371] 缓存命中零请求", calls, 0);
    W.QUALITY.rows = saveRows;
  }

  // 清理：本组不污染后续分组
  W.CONN_OBS.rows.clear();
  W.COVERAGE.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case277({ W, ok, eq, fs }) {
  const saveSeed372 = W.SEED_STORE.document;
  const saveAlive372 = new Map(W.NODE_MEMORY.alive);
  const saveColo372 = W.ISOLATE.colo;
  const savePool372 = [...W.POOL_MEMORY.rows];
  W.POOL_MEMORY.rows.length = 0;

  W.NODE_MEMORY.alive.clear();
  W.ISOLATE.colo = "??";
  W.SEED_STORE.document = {
    v: 7, ts: Date.now(), poolGen: 1, poolN: 3, builtAt: Date.now(),
    byColo: {
      US: { nodes: [{ k: "9.9.9.9:443", h: "9.9.9.9", p: 443, cc: "US" }] },
      DE: { nodes: [{ k: "8.8.8.8:443", h: "8.8.8.8", p: 443, cc: "DE" }] },
    },
  };
  W.NODE_MEMORY.alive.set("1.1.1.1:443", { h: "1.1.1.1", p: 443, cc: "JP", ms: 10, at: Date.now() });
  W.QUALITY.note("9.9.9.9", { kind: W.IpKind.Residential, level: W.IpLevel.Good, proxy: false, vpn: false, at: Date.now() });
  W.QUALITY.note("8.8.8.8", { kind: W.IpKind.Hosting, level: W.IpLevel.Risky, proxy: true, vpn: false, at: Date.now() });
  W.COVERAGE.note("1.1.1.1:443", W.IpFamily.IPv4, Date.now());
  W.CONN_OBS.note("??", "1.1.1.1:443", "example.com", 200, 42, W.IpFamily.IPv4, Date.now());

  ok("[372] regions 端点已导出", typeof W.regions === "function" && typeof W.RegionsView === "function");
  const ctx372 = { url: new URL("https://edge.example.com/regions?format=json&site=example.com"), env: {}, id: "u372" };
  W.REGION_CACHE.rows = null;
W.REGION_CACHE.json = null; // JSON 结果缓存与行缓存同寿命，一起清
  const resp372 = await W.regions(ctx372);
  eq("[372] 返回 200", resp372.status, 200);
  const body372 = await resp372.json();
  eq("[372] target 来自查询串", body372.target, "example.com");
  eq("[372] 覆盖统计总数", body372.coverage.total, 3);
  eq("[372] 覆盖统计已探", body372.coverage.probed, 1);
  eq("[372] alive∪seed 三节点都有", body372.nodes.length, 3);
  // 已探优先（1.1.1.1 记过覆盖）→ 再按质量：seed 里 Good 早于 Risky
  eq("[372] 已探排第一", body372.nodes[0].key, "1.1.1.1:443");
  eq("[372] Good 早于 Risky", body372.nodes[1].key, "9.9.9.9:443");
  eq("[372] Risky 排最后", body372.nodes[body372.nodes.length - 1].key, "8.8.8.8:443");
  const jp372 = body372.nodes.find((n) => n.key === "1.1.1.1:443");
  eq("[372] 目标站点延迟回填", jp372.rtt, 42);
  eq("[372] 地址族 v4", jp372.family, W.IpFamily.IPv4);
  eq("[372] 已探标记", jp372.probed, true);
  const us372 = body372.nodes.find((n) => n.key === "9.9.9.9:443");
  eq("[372] 质量枚举住宅", us372.kind, W.IpKind.Residential);
  eq("[372] 等级 Good", us372.level, W.IpLevel.Good);
  eq("[372] 来源是 seed", us372.source, "seed");
  const risky372 = body372.nodes.find((n) => n.key === "8.8.8.8:443");
  eq("[372] 风险等级", risky372.level, W.IpLevel.Risky);
  eq("[372] 代理标记透传", risky372.proxy, true);

  // ?node= 硬钉住：session 解析形状白名单（非法字符/超长丢弃）
  const sessSrc372 = fs.readFileSync("src/proxy/session.ts", "utf8");
  ok("[372] session 解析 ?node=", sessSrc372.includes('q.get("node")') && sessSrc372.includes("this.pinnedNode"));
  ok("[372] 钉住只收 host:port 白名单", /pinnedNode = qnode && \/\^\[0-9a-zA-Z/.test(sessSrc372));
  const routerSrc372 = fs.readFileSync("src/proxy/fallback.ts", "utf8");
  const routeBody372 = routerSrc372.slice(routerSrc372.indexOf("async route("));
  ok("[372] 路由最高优先级走钉住", routeBody372.indexOf("if (this.o.pinnedNode) return this.viaPinned(") < routeBody372.indexOf("DIALER.open"));
  ok("[372] 钉住失败不回落", routerSrc372.includes("绝不换节点/回落"));

  // 清理
  W.SEED_STORE.document = saveSeed372;
  W.NODE_MEMORY.alive = saveAlive372;
  W.ISOLATE.colo = saveColo372;
  W.POOL_MEMORY.rows.push(...savePool372);
  W.QUALITY.rows.clear();
  W.COVERAGE.clear();
  W.CONN_OBS.rows.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case278({ W, fs, ok, eq }) {
  const saveAlive373 = new Map(W.NODE_MEMORY.alive);
  const saveColo373 = W.ISOLATE.colo;
  W.NODE_MEMORY.alive.clear();
  W.ISOLATE.colo = "??";
  W.NODE_MEMORY.alive.set("1.1.1.1:443", { h: "1.1.1.1", p: 443, cc: "JP", ms: 10, at: Date.now() });
  W.NODE_MEMORY.alive.set("2.2.2.2:443", { h: "2.2.2.2", p: 443, cc: "JP", ms: 12, at: Date.now() });
  W.NODE_MEMORY.alive.set("3.3.3.3:443", { h: "3.3.3.3", p: 443, cc: "US", ms: 8, at: Date.now() });
  W.QUALITY.note("1.1.1.1", { kind: W.IpKind.Residential, level: W.IpLevel.Good, proxy: false, vpn: false, at: Date.now() });
  W.QUALITY.note("2.2.2.2", { kind: W.IpKind.Hosting, level: W.IpLevel.Risky, proxy: true, vpn: false, at: Date.now() });

  const uid373 = "373-user";
  const auth373 = {
    uuids: new Set([uid373]), trojan: new Map(), ok: true,
    list: [{ id: uid373, pwd: "x", note: "", enabled: true, managed: true, regions: ["JP"], regionTopN: 3, targetHost: "example.com" }],
  };
  const url373 = new URL("https://edge.example.com/sub");
  const subSrc373 = fs.readFileSync("src/views/sub-common.ts", "utf8");
  ok("[373] REGION_SUB 类与单例已导出", typeof W.REGION_SUB === "object" && typeof W.RegionSubscription === "function");
  ok("[373] 三个渲染点都走 RegionSubscription", (subSrc373.match(/REGION_SUB\.entries\(/g) || []).length === 2
    && fs.readFileSync("src/views/sub.ts", "utf8").includes("REGION_SUB.entries("));

  const picked373 = W.REGION_SUB.entries(["JP"], "edge.example.com", "pw", ["vless", "trojan"], url373, auth373, uid373);
  // JP 两个节点：1.1.1.1(Good 保留) / 2.2.2.2(Risky 排除) → 每节点×2协议 = 2 条
  eq("[373] Risky 被排除，只剩 Good 的两条协议", picked373.length, 2);
  // server 必须是 CF 边缘入口（钉 v4），不再是中继 IP 1.1.1.1（中继上无 Worker WS/TLS 监听，客户端必超时）
  ok("[373] server 走 CF 边缘且 node= 硬钉中继", picked373.every((e) => e.server !== "1.1.1.1" && e.port === 443 && e.path.includes("node=1.1.1.1")));
  eq("[373] vless 条目质量名", picked373[0].name, "📍JP-good-v4-1.1.1.1-vless");
  eq("[373] trojan 条目质量名", picked373[1].name, "📍JP-good-v4-1.1.1.1-trojan");
  ok("[373] path 用 encodeURIComponent 编码冒号", picked373[0].path.includes("1.1.1.1%3A443"));

  // topN=1 只出一个节点
  const authTop1 = { ...auth373, list: [{ ...auth373.list[0], regionTopN: 1 }] };
  eq("[373] topN=1 只出一条协议集", W.REGION_SUB.entries(["JP"], "edge.example.com", "pw", ["vless", "trojan"], url373, authTop1, uid373).length, 2);

  // 无配置回落原 ?rg= 行为（golden 字节不变）
  const fallback373 = W.REGION_SUB.entries(["JP"], "edge.example.com", "pw", ["vless"], url373, { list: [] }, "nobody");
  eq("[373] 无配置回落一条", fallback373.length, 1);
  ok("[373] 回落走 ?rg=", fallback373[0].path.includes("region-JP") && fallback373[0].path.includes("rg=jp"));

  W.NODE_MEMORY.alive = saveAlive373;
  W.ISOLATE.colo = saveColo373;
  W.QUALITY.rows.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case279({ fs, ok, readView, W, eq }) {
  const admSrc374 = fs.readFileSync("src/routes/admin.ts", "utf8");
  ok("[374] usersOp 有 config 分支", admSrc374.includes('op === "config"'));
  // 校验逻辑已抽到 protocol.ts 的 regionConfigList（admin 与自助面板共用）
  const helperSrc374 = fs.readFileSync("src/proxy/protocol.ts", "utf8");
  ok("[374] config 校验地区白名单", helperSrc374.includes('/^[A-Z0-9]{2,8}$/') && helperSrc374.includes(".slice(0, 32)"));
  ok("[374] topN 限 1-8", helperSrc374.includes("Math.max(1, Math.min(8,"));
  ok("[374] admin 复用 helper", admSrc374.includes("regionConfigList("));
  ok("[374] env 用户转托管", helperSrc374.includes("managed: true") && helperSrc374.includes("list.filter((x) => x.id !== id)"));
  const htmlTpl374 = readView("src/views/html/admin.html");
  ok("[374] admin 模板有 {{rows}} 占位", htmlTpl374.includes("{{rows}}"));
  // renderAdmin 每行带 config 表单
  // 内存 KV 桩：put 必须真的存，否则 saveUsers→loadUsers 永远读不到刚写的配置
  const kvStore374 = {};
  // loadUsers 的 UserIndex.add 用 RE_UUID 过滤，测试 id 必须是真 UUID 才能落库回读
  const uuidEnv374 = "37400000-0000-4000-8000-000000000001";
  const uuidMgr374 = "37400000-0000-4000-8000-000000000002";
  const env374 = {
    uuid: uuidEnv374,
    STATS: { get: async (k) => kvStore374[k] ?? null, put: async (k, v) => { kvStore374[k] = v; } },
  };
  W.USERS.invalidate();
  const rec374 = [
    { id: uuidEnv374, pwd: "e", note: "", enabled: true, managed: false },
    { id: uuidMgr374, pwd: "m", note: "", enabled: true, managed: true, regions: ["US"], regionTopN: 2, targetHost: "example.com" },
  ];
  const rendered374 = W.renderAdmin(new URL("https://x/admin"), { list: rec374 }, {}, "");
  ok("[374] env 用户显示可配置文案", rendered374.includes("环境变量") && rendered374.includes("配置"));
  ok("[374] 配置表单带 op=config", rendered374.includes('name="op" value="config"'));
  ok("[374] 已有地区回填到表单", rendered374.includes('name="regions"') && rendered374.includes("US"));

  // 保存 + 重新加载：regions/topN/targetHost 写入 KV，managed=true
  await W.saveUsers(env374, [
    { id: uuidEnv374, pwd: "e", note: "", enabled: true, managed: true, regions: ["JP", "US"], regionTopN: 4, targetHost: "x.test" },
  ]);
  W.USERS.invalidate();
  const loaded374 = await W.loadUsers(env374);
  const cfg374 = loaded374.list.find((u) => u.id === uuidEnv374);
  ok("[374] 配置写回后可在用户表读到", !!cfg374);
  eq("[374] regions 落库", (cfg374.regions || []).join(","), "JP,US");
  eq("[374] topN 落库", cfg374.regionTopN, 4);
  eq("[374] targetHost 落库", cfg374.targetHost, "x.test");
  eq("[374] 转托管", cfg374.managed, true);

  W.USERS.invalidate();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case280({ readView, fs, ok, W, eq }) {
  const panelTpl375 = readView("src/views/html/panel.html");
  const panelSrc375 = fs.readFileSync("src/views/panel.ts", "utf8");
  ok("[375] panel 模板有地区浏览器占位", panelTpl375.includes("{{regionsRow}}") && panelTpl375.includes("{{connTestRow}}"));
  ok("[375] monitor 产出地区/连通性两行", panelSrc375.includes('regionsRow: this.link("/regions"') && panelSrc375.includes('connTestRow: this.link("/debug?tfb='));

  // 连通性写入：runTfb 把每条通道的状态码/耗时写进 CONN_OBS（纯内存，零额外额度）
  const tfbSrc375 = fs.readFileSync("src/route/tfb.ts", "utf8");
  ok("[375] tfb 引入 CONN_OBS 与 IpFamily", tfbSrc375.includes('import { CONN_OBS } from "../px/regions"') && tfbSrc375.includes("IpFamily.IPv6"));
  ok("[375] 每条通道写连通性观测", tfbSrc375.includes("CONN_OBS.note(ISOLATE.colo, ip, host"));
  ok("[375] 直连行跳过（无可展示节点）", tfbSrc375.includes('ip !== "direct"'));

  // 行为：note 后能按 colo|node|site 读到目标站延迟
  const colo375 = W.ISOLATE.colo;
  W.ISOLATE.colo = "TEST375";
  W.CONN_OBS.clear ? W.CONN_OBS.clear() : (W.CONN_OBS.rows && W.CONN_OBS.rows.clear());
  W.CONN_OBS.note("TEST375", "5.5.5.5", "site375.test", 200, 123, W.IpFamily.IPv4, Date.now());
  eq("[375] 连通性延迟可读", W.CONN_OBS.rttOf("TEST375", "5.5.5.5", "site375.test", Date.now()), 123);
  W.ISOLATE.colo = colo375;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case281({ readView, ok, fs, regionsSource, W, eq }) {
  // 结构：新模板存在且是 LF；helper 与 admin/regions 都用它
  const tpl377 = readView("src/views/html/regions.html");
  ok("[377] regions.html 无 CRLF", !tpl377.includes("\r\n"));
  ok("[377] 模板有表单与分组占位", tpl377.includes("<form method=\"post\"") && tpl377.includes("{{groupsHtml}}") && tpl377.includes('name="targetHost"') && tpl377.includes('name="topN"'));
  const proto377 = fs.readFileSync("src/proxy/protocol.ts", "utf8");
  const admin377 = fs.readFileSync("src/routes/admin.ts", "utf8");
  const tools377 = regionsSource();
  ok("[377] 勾选框在 tools.ts 生成", tools377.includes('name="regions" value="'));
  ok("[377] 共享 helper 在 protocol.ts", proto377.includes("export function regionConfigList("));
  ok("[377] admin 复用共享 helper", admin377.includes("regionConfigList(") && admin377.includes("/regions"));
  ok("[377] regions 默认渲染 HTML + format=json 兼容", tools377.includes('get("format") === "json"') && tools377.includes("renderTemplate(regionsTpl"));
  ok("[377] POST 走 saveUsers 写回", tools377.includes("await saveUsers(this.c.env, chosen.list)"));
  // CPU 门禁：地区面板 800 节点时逐 key alive.find 是 O(N²)（基准 23ms/op，实测吃满免费计划 CPU），必须走 Map 查表
  ok("[377] 地区面板不再 O(N²) find", tools377.includes("liveByKey = new Map<") && tools377.includes("liveByKey.get(key)") && !tools377.includes("alive.find("));
  // CPU 门禁：/proxyip 黑名单查表与地区订阅 rank 都不能在 map/comparator 里做线性或重复计算
  const proxyip377 = fs.readFileSync("src/routes/proxyip.ts", "utf8");
  const subcommon377 = fs.readFileSync("src/views/sub-common.ts", "utf8");
  ok("[377] proxyip 黑名单走 Set", proxyip377.includes("new Set(blacklist)") && proxyip377.includes("blackSet.has(k)") && !proxyip377.includes("blacklist.includes("));
  ok("[377] 地区订阅 rank 只算一次", subcommon377.includes("live.map((n) => ({ n, r: this.rank(n, now) }))") && !subcommon377.includes("picked.sort((a, b) => this.rank("));

  // 展示映射：带文字徽章，不只靠颜色
  ok("[377] good 徽章带文字", W.levelBadge("good").includes("良好") && W.levelBadge("good").includes("b g"));
  ok("[377] risky 徽章带文字", W.levelBadge("risky").includes("风险"));
  ok("[377] 未知等级回落未探", W.levelBadge("weird").includes("未探"));
  ok("[377] 类型中文标签+原始值", W.kindLabel(W.IpKind.Residential).includes("住宅") && W.kindLabel(W.IpKind.Residential).includes("residential"));
  ok("[377] 族标签", W.familyLabel(W.IpFamily.IPv4) === "IPv4" && W.familyLabel(W.IpFamily.IPv6) === "IPv6");
  const row377 = (over = {}) => ({ key: "1.1.1.1:443", country: "US", family: W.IpFamily.IPv4, alive: true, source: "alive", kind: W.IpKind.Residential, level: "good", proxy: true, vpn: false, probed: true, rtt: null, ...over });
  ok("[377] 代理标记", W.flagLabel(row377()) === "代理");
  ok("[377] 无标记显示破折号", W.flagLabel(row377({ proxy: false, vpn: false })) === "—");
  // 所有标签插值都过 escapeHtml（造一个带尖括号的类型不会注入）
  ok("[377] 标签转义", !W.kindLabel("<img>").includes("<img>"));

  // 分组：按国家码字典序、未知落到 ??
  const grouped377 = W.groupRows([row377({ country: "JP" }), row377({ country: "US" }), row377({ country: "" }), row377({ country: "JP", key: "2.2.2.2:443" })]);
  eq("[377] 分组数", grouped377.length, 3);
  eq("[377] 组按字典序", grouped377.map((g) => g.country).join(","), "??,JP,US");
  eq("[377] 组内保留顺序", grouped377.find((g) => g.country === "JP").rows.length, 2);

  // regionConfigList：纯函数写回，不改入参，env 用户转托管，归一化地区/节点数
  const auth377 = {
    list: [
      { id: "env377", pwd: "e", note: "", enabled: true, managed: false },
      { id: "mgr377", pwd: "m", note: "n", enabled: true, managed: true, regions: ["US"] },
    ],
    uuids: new Set(), trojan: new Map(), ok: true,
  };
  const chosen377 = W.regionConfigList(auth377, "env377", [" jp ", "DE", "bad!!"], 99, "example.com");
  eq("[377] 写回成功", chosen377.ok, true);
  const row377b = chosen377.list.find((x) => x.id === "env377");
  eq("[377] 地区归一化过滤", (row377b.regions || []).join(","), "JP,DE");
  eq("[377] topN 夹到 8", row377b.regionTopN, 8);
  eq("[377] env 用户转托管", row377b.managed, true);
  eq("[377] 保留原密码", row377b.pwd, "e");
  eq("[377] 托管用户不丢", chosen377.list.some((x) => x.id === "mgr377"), true);
  eq("[377] 入参未被改", auth377.list.find((x) => x.id === "env377").managed, false);
  const missing377 = W.regionConfigList(auth377, "nobody", [], 3, "");
  eq("[377] 不存在的用户报错", missing377.ok, false);
  const clear377 = W.regionConfigList(auth377, "mgr377", [], 0, "");
  eq("[377] 空地区=清除", (clear377.list.find((x) => x.id === "mgr377").regions || []).length, 0);
  eq("[377] topN 缺省回落 3", clear377.list.find((x) => x.id === "mgr377").regionTopN, 3);

  // HTML 渲染：默认请求得到面板，含徽章与勾选框；带 site 显示延迟列
  const saveSeed377 = W.SEED_STORE.document;
  const saveAlive377 = new Map(W.NODE_MEMORY.alive);
  W.NODE_MEMORY.alive.clear();
  W.SEED_STORE.document = { v: 7, byColo: { US: { nodes: [{ k: "9.9.9.9:443", h: "9.9.9.9", p: 443, cc: "US" }] } } };
  W.QUALITY.note("9.9.9.9", { kind: W.IpKind.Residential, level: W.IpLevel.Good, proxy: false, vpn: false, at: Date.now() });
  const ctx377 = {
    url: new URL("https://edge.example.com/regions"),
    request: { method: "GET" },
    env: {}, id: "u377", pageKey: "",
    auth: { list: [{ id: "u377", pwd: "p", note: "", enabled: true, managed: true, regions: ["US"] }], uuids: new Set(), trojan: new Map(), ok: true },
  };
  W.REGION_CACHE.rows = null;
W.REGION_CACHE.json = null; // JSON 结果缓存与行缓存同寿命，一起清
  const respHtml377 = await W.regions(ctx377);
  eq("[377] 默认返回 200", respHtml377.status, 200);
  const html377 = await respHtml377.text();
  ok("[377] HTML 含地区勾选框", html377.includes('type="checkbox" name="regions" value="US" checked'));
  ok("[377] HTML 含质量徽章", html377.includes("良好") && html377.includes("b g"));
  ok("[377] HTML 含类型标签", html377.includes("住宅"));
  ok("[377] HTML 含 JSON 链接", html377.includes("/regions?format=json"));
  ok("[377] 未带 site 不显示延迟列", !html377.includes("<th>到站延迟</th>"));
  // 带 site 显示延迟列
  const ctxSite377 = { ...ctx377, url: new URL("https://edge.example.com/regions?site=example.com") };
  const htmlSite377 = await (await W.regions(ctxSite377)).text();
  ok("[377] 带 site 显示延迟列", htmlSite377.includes("<th>到站延迟</th>"));
  // format=json 仍返回旧契约
  const ctxJson377 = { ...ctx377, url: new URL("https://edge.example.com/regions?format=json") };
  const json377 = await (await W.regions(ctxJson377)).json();
  ok("[377] format=json 兼容 nodes/coverage", Array.isArray(json377.nodes) && !!json377.coverage);

  // 清理
  W.NODE_MEMORY.alive.clear();
  for (const [k, v] of saveAlive377) W.NODE_MEMORY.alive.set(k, v);
  W.SEED_STORE.document = saveSeed377;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case282({ regionsSource, readView, fs, ok, eq, W }) {
  const tools378 = regionsSource();
  const regionsTpl378 = readView("src/views/html/regions.html");
  const regionsSrc378 = fs.readFileSync("src/px/regions.ts", "utf8");
  // 结构：事实列（纯内存查表）已在 rows() 里读取五张表
  ok("[378] rows 读出口族事实", tools378.includes("egFamily: EG.famOf(ip, now)"));
  ok("[378] rows 读成功率事实", tools378.includes("psOk: target ? PS.okOf(target, ip, now)"));
  ok("[378] rows 读判死事实", tools378.includes("dead: DEAD.isDead(ip, now)"));
  ok("[378] rows 读封锁事实", tools378.includes("blkPenalty: target ? BLK.penOf(target, ip, now)"));
  ok("[378] rows 读 DNS 事实", tools378.includes("const v6 = target ? DNS.v6Of(target, now)"));
  // 已探优先 + 未探测单独分组（用户口径）
  ok("[378] 已探优先排序", tools378.includes("Number(b.probed) - Number(a.probed)"));
  ok("[378] 组级也按已探优先", tools378.includes("a[1].some((r) => r.probed) ? 1 : 0"));
  // 探测按钮：指定网站（runTfb）+ 逐节点质量重探（qualityOf），且都限流
  ok("[378] 指定网站探测复用 tfb", tools378.includes("runTfb({ env: this.c.env }, site, n, list"));
  ok("[378] 质量重探复用 probe", tools378.includes("QUALITY_PROBE.qualityOf(key, h, this.c.budget, fam)"));
  ok("[378] 两类探测都限流", tools378.includes('QUALITY.recheckReady(ck, 60_000)') && tools378.includes('QUALITY.recheckReady(qk, 60_000)'));
  ok("[378] 冷却表放进状态持有者且有界", regionsSrc378.includes("readonly recheckCool = new BoundedMap<string, number>"));
  // 模板：指定网站探测表单 + 重探按钮的样式类
  ok("[378] 模板有网站探测表单", regionsTpl378.includes('id="probeSite"') && regionsTpl378.includes("开始探测"));
  ok("[378] 模板有重探按钮样式", regionsTpl378.includes(".lnkbtn"));

  // 展示标签
  eq("[378] 出口族标签 v4", W.egLabel(4), "v4");
  eq("[378] 出口族标签 v6", W.egLabel(6), "v6");
  eq("[378] 出口族标签未知", W.egLabel(0), "—");
  eq("[378] 成功率标签", W.psLabel(0.876), "88%");
  eq("[378] 成功率无样本", W.psLabel(-1), "—");
  eq("[378] DNS 标签", W.dnsLabel(1) + "/" + W.dnsLabel(0) + "/" + W.dnsLabel(-1), "有/无/—");

  // 分组：所有国家都保留勾选框；有已探节点的国家在前，全未探的国家在后，各自按码序
  const row378 = (over = {}) => ({ key: "1.1.1.1:443", country: "US", family: W.IpFamily.IPv4, alive: true, source: "alive", kind: W.IpKind.Residential, level: "good", proxy: false, vpn: false, probed: true, rtt: null, egFamily: 4, psOk: -1, dead: false, blkPenalty: 1, dnsV6: -1, ...over });
  const grouped378 = W.groupRows([row378({ probed: false, country: "JP" }), row378({ country: "US" }), row378({ country: "DE" })]);
  eq("[378] 分组数=国家数", grouped378.length, 3);
  eq("[378] 全未探国家排最后", grouped378[grouped378.length - 1].country, "JP");
  eq("[378] 已探组按码序", grouped378.slice(0, 2).map((g) => g.country).join(","), "DE,US");

  // 限流行为：同一 key 1 分钟内只放行一次
  const cool378 = new W.QUALITY.constructor();
  eq("[378] 首探放行", cool378.recheckReady("q:1.1.1.1:443", 60000, 100000), true);
  cool378.recheckMark("q:1.1.1.1:443", 100000);
  eq("[378] 冷却中拒绝", cool378.recheckReady("q:1.1.1.1:443", 60000, 100001), false);
  eq("[378] 过期后放行", cool378.recheckReady("q:1.1.1.1:443", 60000, 160001), true);
  eq("[378] 不同 key 独立", cool378.recheckReady("s:example.com", 60000, 100001), true);

  // 渲染：带 site 时 HTML 有事实列与重探按钮，且未探测组不产生勾选框
  const saveSeed378 = W.SEED_STORE.document;
  const saveAlive378 = new Map(W.NODE_MEMORY.alive);
  W.NODE_MEMORY.alive.clear();
  W.SEED_STORE.document = { v: 7, byColo: { US: { nodes: [{ k: "8.8.8.8:443", h: "8.8.8.8", p: 443, cc: "US" }] } } };
  W.EG.note("8.8.8.8", 4, Date.now());
  W.PS.note("example.com", "8.8.8.8", true, Date.now());
  const ctx378 = {
    url: new URL("https://edge.example.com/regions?site=example.com"),
    request: { method: "GET" },
    env: {}, id: "u378", pageKey: "",
    auth: { list: [{ id: "u378", pwd: "p", note: "", enabled: true, managed: true, regions: ["US"] }], uuids: new Set(), trojan: new Map(), ok: true },
  };
  W.REGION_CACHE.rows = null;
W.REGION_CACHE.json = null; // JSON 结果缓存与行缓存同寿命，一起清
  const html378 = await (await W.regions(ctx378)).text();
  // 列头从「出口族事实」简写成「出口族」（列没删，窄屏少挤一点）
ok("[378] HTML 有出口族列", html378.includes("出口族"));
  ok("[378] HTML 有成功率列", html378.includes("成功率") && html378.includes("100%"));
  ok("[378] HTML 有重探按钮", html378.includes('value="requality"') && html378.includes("重探质量"));
  ok("[378] HTML 有网站探测表单", html378.includes('id="probeSite"') && html378.includes("开始探测"));
  ok("[378] formaction 无模板占位", !html378.includes("{{postAction}}"));
  W.EG.clear && W.EG.clear();
  W.NODE_MEMORY.alive.clear();
  for (const [k, v] of saveAlive378) W.NODE_MEMORY.alive.set(k, v);
  W.SEED_STORE.document = saveSeed378;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case283({ W, eq, ok }) {
  const saveSeed379 = W.SEED_STORE.document;
  const saveAlive379 = new Map(W.NODE_MEMORY.alive);
  const saveReadAt379 = W.SEED_STORE.readAt;
  const saveReadFailed379 = W.SEED_STORE.readFailed;
  const saveColo379 = W.ISOLATE.colo;
  // 冷 isolate 的真实状态：内存里的 seed/alive 全空，但 KV 里有行情
  W.NODE_MEMORY.alive.clear();
  W.SEED_STORE.document = { v: 7, byColo: {} };
  W.ISOLATE.colo = "TST";
  W.SEED_STORE.readAt = 0;
  W.SEED_STORE.readFailed = false;
  const kvSeed379 = {
    v: 7,
    ts: Date.now(),
    poolGen: 1,
    poolN: 1,
    builtAt: Date.now(),
    byColo: { TST: { nodes: [{ k: "203.0.113.79:443", h: "203.0.113.79", p: 443, cc: "TST" }], ts: Date.now() } },
  };
  const env379 = {
    uuids: "u379",
    STATS: {
      get: async (k) => (k === "px:seed" ? JSON.stringify(kvSeed379) : null),
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [] }),
    },
  };
  const ctx379 = {
    url: new URL("https://edge.example.com/regions?format=json"),
    request: { method: "GET" },
    env: env379, id: "u379",
  };
  W.REGION_CACHE.rows = null;
W.REGION_CACHE.json = null; // JSON 结果缓存与行缓存同寿命，一起清
  const resp379 = await W.regions(ctx379);
  eq("[379] 冷 isolate 请求成功", resp379.status, 200);
  const body379 = await resp379.json();
  ok("[379] 冷 isolate 从 KV 载入节点（不再恒空）", body379.nodes.length > 0, JSON.stringify(body379.nodes));
  eq("[379] 载入的是 KV 里的节点", body379.nodes[0].key, "203.0.113.79:443");
  ok("[379] GET 触发了 seed 读取（readAt 已置）", W.SEED_STORE.readAt > 0, String(W.SEED_STORE.readAt));
  // 恢复现场
  W.NODE_MEMORY.alive.clear();
  for (const [k, v] of saveAlive379) W.NODE_MEMORY.alive.set(k, v);
  W.SEED_STORE.document = saveSeed379;
  W.SEED_STORE.readAt = saveReadAt379;
  W.SEED_STORE.readFailed = saveReadFailed379;
  W.ISOLATE.colo = saveColo379;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case291({ fs, regionsSource, ok, W, eq }) {
  const G = 389;
  const proto389 = fs.readFileSync("src/proxy/protocol.ts", "utf8");
  const tools389 = regionsSource();
  const sub389 = fs.readFileSync("src/views/sub.ts", "utf8");
  const app389 = fs.readFileSync("types/app.d.ts", "utf8");
  // ---- 结构锁 ----
  ok(`[${G}] UserRec 有 pinnedNodes 字段`, app389.includes("pinnedNodes?: string[];"));
  ok(`[${G}] protocol 读入 pinnedNodes`, proto389.includes("Array.isArray(cfg.pinnedNodes)"));
  ok(`[${G}] protocol 落盘 pinnedNodes`, proto389.includes("{ pinnedNodes: x.pinnedNodes }"));
  ok(`[${G}] regionConfigList 有 pinnedNodes 形参`, proto389.includes("pinnedNodes?: string[],"));
  ok(`[${G}] 面板有节点勾选框`, tools389.includes('name="pinnedNodes"'));
  ok(`[${G}] 面板 post 读 pinnedNodes`, tools389.includes('f.getAll("pinnedNodes")'));
  ok(`[${G}] 自选节点作为手动组成员生成`, sub389.includes("pinNames.length ? \", \" + pinNames.map"));
  ok(`[${G}] 订阅从 auth 读 pinnedNodes`, sub389.includes("me?.pinnedNodes"));
  ok(`[${G}] 手动组有版本号后缀且默认回自动组`, /const G_MAN = .*v2"/.test(sub389) && sub389.includes('default-selected: "${G_TPUT}"'));
  // ---- 数据层行为：归一化 + 不传保留原值 ----
  const auth389 = {
    list: [
      { id: "pinm", pwd: "m", note: "", enabled: true, managed: true, regions: ["US"], pinnedNodes: ["1.2.3.4:443"] },
      { id: "pine", pwd: "e", note: "", enabled: true, managed: false },
    ],
    uuids: new Set(), trojan: new Map(), ok: true,
  };
  // 传了：归一化（过滤非法、去重无关但截断、host:port 正则）
  const set389 = W.regionConfigList(auth389, "pinm", ["US"], 3, "", [" bad!! ", "5.6.7.8:8443", "noport", "9.9.9.9:443"]);
  eq(`[${G}] 写回成功`, set389.ok, true);
  const rowSet389 = set389.list.find((x) => x.id === "pinm");
  eq(`[${G}] pinnedNodes 归一化`, (rowSet389.pinnedNodes || []).join(","), "5.6.7.8:8443,9.9.9.9:443");
  // 不传：保留原值（admin 旧表单不清空）
  const keep389 = W.regionConfigList(auth389, "pinm", ["US"], 3, "");
  eq(`[${G}] 不传保留原 pinnedNodes`, (keep389.list.find((x) => x.id === "pinm").pinnedNodes || []).join(","), "1.2.3.4:443");
  // 空数组=清空
  const clear389 = W.regionConfigList(auth389, "pinm", ["US"], 3, "", []);
  eq(`[${G}] 空数组清空`, (clear389.list.find((x) => x.id === "pinm").pinnedNodes || []).length, 0);
  // 入参未被改
  eq(`[${G}] 入参未被改`, auth389.list.find((x) => x.id === "pinm").pinnedNodes.length, 1);
  // ---- 订阅层行为：自选节点独立分组，只进手动组 ----
  const subAuth389 = {
    list: [{ id: "u389", pwd: "p", note: "", enabled: true, managed: true, pinnedNodes: ["203.0.113.60:8443"] }],
    uuids: new Set(), trojan: new Map(), ok: true,
  };
  const env389 = { uuid: "u389", nodes: "", proxyip: "auto" };
  const y389 = W.renderClash(env389, new URL("https://edge.example.com/x"), "u389", "edge.example.com", {}, [], subAuth389);
  ok(`[${G}] 自选节点条目存在`, y389.includes('📌203.0.113.60-VL'));
  ok(`[${G}] 自选节点硬钉 node=`, y389.includes('node=203.0.113.60%3A8443') || y389.includes('node=203.0.113.60:8443'));
  ok(`[${G}] 手动组默认选中吞吐优先组`, y389.includes('default-selected: "🚀 吞吐优先"'));
  // 默认组（吞吐/速率）不引用自选组：定位 G_TPUT/G_LAT 块
  const blockOf = (name) => {
    const i = y389.indexOf(`- name: "${name}"`);
    if (i < 0) return "";
    const j = y389.indexOf("- name:", i + 10);
    return y389.slice(i, j < 0 ? y389.length : j);
  };
  ok(`[${G}] 吞吐组不含硬钉节点`, !blockOf("🚀 吞吐优先").includes("📌203.0.113.60-VL"));
  ok(`[${G}] 速率组不含硬钉节点`, !blockOf("⚡ 速率优先").includes("📌203.0.113.60-VL"));
  ok(`[${G}] 手动组含硬钉节点`, blockOf("🎯 手动 v2").includes("📌203.0.113.60-VL"));
  // 无 pinnedNodes 时不生成自选组
  const yNoPin389 = W.renderClash(env389, new URL("https://edge.example.com/x"), "u389", "edge.example.com", {}, [], undefined);
  ok(`[${G}] 无勾选不生成硬钉条目`, !yNoPin389.includes("📌203.0.113.60-VL"));
  // ---- 面板渲染：勾选框回填 ----
  const saveSeed389 = W.SEED_STORE.document;
  const saveAlive389 = new Map(W.NODE_MEMORY.alive);
  W.NODE_MEMORY.alive.clear();
  W.SEED_STORE.document = { v: 7, byColo: { US: { nodes: [{ k: "203.0.113.60:8443", h: "203.0.113.60", p: 8443, cc: "US" }] } } };
  const ctx389 = {
    url: new URL("https://edge.example.com/regions"),
    request: { method: "GET" },
    env: {}, id: "u389", pageKey: "",
    auth: { list: [{ id: "u389", pwd: "p", note: "", enabled: true, managed: true, regions: ["US"], pinnedNodes: ["203.0.113.60:8443"] }], uuids: new Set(), trojan: new Map(), ok: true },
  };
  W.REGION_CACHE.rows = null;
W.REGION_CACHE.json = null; // JSON 结果缓存与行缓存同寿命，一起清
  const html389 = await (await W.regions(ctx389)).text();
  ok(`[${G}] 面板节点勾选框回填`, html389.includes('type="checkbox" name="pinnedNodes" value="203.0.113.60:8443" checked'));
  ok(`[${G}] 面板表头有选列`, html389.includes("<th>选</th>"));
  W.NODE_MEMORY.alive.clear();
  for (const [k, v] of saveAlive389) W.NODE_MEMORY.alive.set(k, v);
  W.SEED_STORE.document = saveSeed389;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case292({ regionsSource, readView, ok, W, eq }) {
  const G = 390;
  const tools390 = regionsSource();
  const tpl390 = readView("src/views/html/regions.html");
  // ---- 结构锁 ----
  ok(`[${G}] 纯函数已导出`, typeof W.nodeCheckConclusion === "function");
  ok(`[${G}] nodecheck 分支存在`, tools390.includes('op.startsWith("nodecheck:")'));
  ok(`[${G}] 钉单节点跑 tfb`, tools390.includes("runTfb({ env: this.c.env }, site, 1, key)"));
  ok(`[${G}] 60s 冷却.nc`, tools390.includes('"nc:" + key'));
  ok(`[${G}] 分支用纯函数结论`, tools390.includes("nodeCheckConclusion(status, bytes)"));
  ok(`[${G}] 模板有 checkSite 输入框`, tpl390.includes('id="checkSite"'));
  ok(`[${G}] 表格有测连通按钮`, tools390.includes('value="nodecheck:'));
  ok(`[${G}] 表格有连通测试列`, tools390.includes("<th>连通测试</th>"));
  ok(`[${G}] post 分派 nodecheck`, tools390.includes('opRaw.startsWith("nodecheck:")'));
  // ---- 纯函数行为（连通 / 被 ban 诊断） ----
  eq(`[${G}] 200 连通`, W.nodeCheckConclusion(200, 45705), "连通正常");
  eq(`[${G}] 301 连通`, W.nodeCheckConclusion(301, 100), "连通正常");
  eq(`[${G}] 小响应 403 判被 ban`, W.nodeCheckConclusion(403, 737), "疑似被 ban（小响应 403，族拒绝）");
  eq(`[${G}] 2048 边界判被 ban`, W.nodeCheckConclusion(403, 2048), "疑似被 ban（小响应 403，族拒绝）");
  eq(`[${G}] 整页 403 不判 ban`, W.nodeCheckConclusion(403, 20000), "HTTP 403（可能被拒绝或业务 403）");
  eq(`[${G}] 404 普通错误`, W.nodeCheckConclusion(404, 500), "HTTP 404（可能被拒绝或业务 403）");
  eq(`[${G}] 0 字节 403 不算 ban`, W.nodeCheckConclusion(403, 0), "HTTP 403（可能被拒绝或业务 403）");
  eq(`[${G}] 无应答`, W.nodeCheckConclusion(0, 0), "无应答（连不上或超时）");
  // ---- 面板渲染：有连通测试列与按钮 ----
  const saveSeed390 = W.SEED_STORE.document;
  const saveAlive390 = new Map(W.NODE_MEMORY.alive);
  W.NODE_MEMORY.alive.clear();
  W.SEED_STORE.document = { v: 7, byColo: { US: { nodes: [{ k: "198.51.100.9:443", h: "198.51.100.9", p: 443, cc: "US" }] } } };
  const ctx390 = {
    url: new URL("https://edge.example.com/regions"),
    request: { method: "GET" },
    env: {}, id: "u390", pageKey: "",
    auth: { list: [{ id: "u390", pwd: "p", note: "", enabled: true, managed: true, regions: ["US"] }], uuids: new Set(), trojan: new Map(), ok: true },
  };
  W.REGION_CACHE.rows = null;
W.REGION_CACHE.json = null; // JSON 结果缓存与行缓存同寿命，一起清
  const html390 = await (await W.regions(ctx390)).text();
  ok(`[${G}] HTML 有测连通按钮`, html390.includes('value="nodecheck:198.51.100.9:443"'));
  ok(`[${G}] HTML 有 checkSite 框`, html390.includes('id="checkSite"'));
  ok(`[${G}] HTML 有连通测试列`, html390.includes("<th>连通测试</th>"));
  W.NODE_MEMORY.alive.clear();
  for (const [k, v] of saveAlive390) W.NODE_MEMORY.alive.set(k, v);
  W.SEED_STORE.document = saveSeed390;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case293({ readView, regionsSource, ok, W }) {
  const tpl391 = readView("src/views/html/regions.html");
  const tools391 = regionsSource();
  // 结构锁
  ok("[391] 出站 IP 列源码", tools391.includes("出站 IP") && tools391.includes("ipx"));
  ok("[391] 出站 IP 抽自 key", tools391.includes("splitRelay(r.key, 443)"));
  ok("[391] 国家已知徽章", tools391.includes("已知 ${probedN}") && tools391.includes("未探测"));
  ok("[391] 重探按钮带 data-key", tools391.includes("data-key="));
  ok("[391] 探测按钮带 data-probe", tools391.includes('data-probe="1"'));
  ok("[391] 去掉共享隐藏 key", !tools391.includes('name="key"'));
  ok("[391] 表单 action 统一构造", tools391.includes("postAction: escapeHtml(link({}))"));
  // 模板：JS 拦截不跳转 + 结果内联 + 重探用 data-key
  ok("[391] JS fetch 拦截", tpl391.includes("fetch(") && tpl391.includes("preventDefault"));
  ok("[391] 结果内联容器", tpl391.includes('id="result"'));
  ok("[391] JS 重探用 data-key", tpl391.includes("dataset.key"));
  ok("[391] JS 读取表单 action", tpl391.includes("fetch(document.getElementById('saveForm').action"));
  ok("[391] 新 UI 样式类", tpl391.includes(".ipx") && tpl391.includes(".cgroup"));
  // 渲染：带 seed 节点，检查出站 IP / 组徽章 / data-key / 无跳转残留
  const saveSeed391 = W.SEED_STORE.document;
  const saveAlive391 = new Map(W.NODE_MEMORY.alive);
  W.NODE_MEMORY.alive.clear();
  W.SEED_STORE.document = { v: 7, byColo: { US: { nodes: [{ k: "198.51.100.9:443", h: "198.51.100.9", p: 443, cc: "US" }] } } };
  const ctx391 = {
    url: new URL("https://edge.example.com/regions"),
    request: { method: "GET" },
    env: {}, id: "u391", pageKey: "",
    auth: { list: [{ id: "u391", pwd: "p", note: "", enabled: true, managed: true, regions: ["US"] }], uuids: new Set(), trojan: new Map(), ok: true },
  };
  W.REGION_CACHE.rows = null;
W.REGION_CACHE.json = null; // JSON 结果缓存与行缓存同寿命，一起清
  const html391 = await (await W.regions(ctx391)).text();
  ok("[391] HTML 有出站 IP 列", html391.includes("<th>出站 IP</th>") && html391.includes("ipx"));
  ok("[391] HTML 出站 IP 值", html391.includes("198.51.100.9"));
  ok("[391] HTML 重探 data-key", html391.includes('data-key="198.51.100.9:443"'));
  ok("[391] HTML 探测 data-probe", html391.includes('data-probe="1"'));
  ok("[391] HTML 国家组徽章", html391.includes("已知 ") || html391.includes("未探测"));
  ok("[391] HTML 无占位符残留", !html391.includes("{{postActionJson}}") && !html391.includes("{{groupsHtml}}"));
  W.NODE_MEMORY.alive.clear();
  for (const [k, v] of saveAlive391) W.NODE_MEMORY.alive.set(k, v);
  W.SEED_STORE.document = saveSeed391;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case294({ regionsSource, readView, ok }) {
  const tools392 = regionsSource();
  const tpl392 = readView("src/views/html/regions.html");
  // 根因1：探测按钮从 submit 改 button，避免表单导航 abort fetch → NetworkError
  ok("[392] 重探按钮 type=button", tools392.includes('type="button" name="op" value="requality"'));
  ok("[392] 测连通按钮 type=button", tools392.includes('type="button" name="op" value="nodecheck:'));
  ok("[392] 按钮不再用 formaction", !tools392.includes("formaction="));
  ok("[392] 开始探测按钮 type=button", tpl392.includes('type="button" data-act="site-probe"'));
  // 根因2：relay 只去方括号、保留 host:port 冒号（原 replace 把冒号删了 → 45.136.117.194443）
  ok("[392] relay 只去方括号", tools392.includes('replace(/[[\\]]/g, "")'));
  ok("[392] 冒号粘连注释在", tools392.includes("45.136.117.194443"));
  // 根因3：requality 标签拼数组过滤空值，去掉悬空 " / "
  ok("[392] 标签数组过滤空值", tools392.includes('.filter(Boolean)') && tools392.includes("tags.join"));
  // hint 文案与 catch 人话化
  ok("[392] 探测 hint 无奇怪文案", tpl392.includes("各出口能否打开"));
  ok("[392] 测连通 hint 说明用途", tpl392.includes("识别是否被 ban"));
  ok("[392] catch 人话提示", tpl392.includes("请检查网络后重试") && tpl392.includes("e.message"));
  ok("[392] catch 无裸 e 拼接", !tpl392.includes("show('请求失败：'+e)"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case297({ regionsSource, ok, W, eq }) {
  const tools395 = regionsSource();
  // 结构锁：三类探测结果都要带国家码
  ok("[395] 有 countryOf 查询函数", typeof W.countryOf === "function");
  ok("[395] 有 ccTag 渲染函数", typeof W.ccTag === "function");
  ok("[395] 指定网站探测带国家", tools395.includes("ccTag(countryOf(relay))"));
  ok("[395] 质量重探带国家", tools395.includes("ccTag(countryOf(key))"));
  ok("[395] 连通测试带国家", tools395.includes('"节点 " + cc + key'));
  ok("[395] 已知节点按国家分组", tools395.includes("groupRows(rows)"));
  ok("[395] 已知组在前", tools395.includes("pb - pa || a[0].localeCompare(b[0])"));
  // 行为：ccTag 空串不显示、有码显示方括号
  eq("[395] ccTag 空串", W.ccTag(""), "");
  eq("[395] ccTag 有码", W.ccTag("US"), "[US] ");
  // 行为：countryOf 从存活表查国家码（保存/恢复现场，避免污染其它组）
  const aliveBackup = new Map(W.NODE_MEMORY.alive);
  const coloBackup = W.ISOLATE.colo;
  try {
    W.NODE_MEMORY.alive.set("198.51.100.9:443", { h: "198.51.100.9", p: 443, cc: "JP", ms: 5 });
    W.NODE_MEMORY.alive.set("198.51.100.10:8443", { h: "198.51.100.10", p: 8443, cc: "DE", ms: 6 });
    eq("[395] countryOf 精确匹配 key", W.countryOf("198.51.100.9:443"), "JP");
    eq("[395] countryOf 缺省端口", W.countryOf("198.51.100.9"), "JP");
    eq("[395] countryOf 按 host 扫", W.countryOf("198.51.100.10:9999"), "DE");
    eq("[395] countryOf direct 用本机房", W.countryOf("direct"), String(coloBackup || "").toUpperCase());
    eq("[395] countryOf 查不到返回空", W.countryOf("203.0.113.99"), "");
    // 分组：已知节点（probed=true）的国家排在未知国家前，组内保留顺序
    const mk = (key, country, probed) => ({ key, country, probed, alive: true, level: "normal", family: 1, source: "alive", kind: "unknown", proxy: false, vpn: false, rtt: null, egFamily: 0, psOk: -1, dead: false, blkPenalty: 1, dnsV6: -1 });
    const groups = W.groupRows([mk("a:1", "ZZ", false), mk("b:2", "AA", true), mk("c:3", "MM", false)]);
    eq("[395] 分组已知国家在前", groups[0].country, "AA");
    eq("[395] 分组数正确", groups.length, 3);
  } finally {
    W.NODE_MEMORY.alive.clear();
    for (const [k, v] of aliveBackup) W.NODE_MEMORY.alive.set(k, v);
    W.ISOLATE.colo = coloBackup;
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case298({ fs, regionsSource, readView, ok, W }) {
    const tf396 = fs.readFileSync("src/route/tfb.ts", "utf8");
    const tl396 = regionsSource();
    const h396 = readView("src/views/html/regions.html");
    // 结构：tfb 支持 cap；tools 读 nodes 列表 / requality json / 结果含状态码+延迟 / 表格行 data 标识
    ok("[396] runTfb 支持自定义 cap", tf396.includes("cap = 3") && tf396.includes("Math.min(cap, n)"));
    ok("[396] probe 读勾选节点列表", tl396.includes('f.getAll("nodes")') && tl396.includes('x.split(",")') && tl396.includes("picked.join"));
    ok("[396] 探测结果含状态码与延迟", tl396.includes("r.status ??") && tl396.includes("r.ms ??") && tl396.includes("ms`"));
    ok("[396] requality 返回 json 回填", tl396.includes('Response.json({ ok: true, key') && tl396.includes("badge: levelBadge") && tl396.includes("kindHtml: kindLabel"));
    ok("[396] 表格行带 data-node 定位", tl396.includes('<tr data-node=') && tl396.includes('data-cell="level"') && tl396.includes('data-cell="kind"') && tl396.includes('data-cell="source"'));
    // 前端：收集勾选节点传 nodes；requality json=1；回填三单元格
    ok("[396] 前端收集勾选节点", h396.includes("input[name=\"pinnedNodes\"]") && h396.includes("c.type==='hidden'||c.checked") && h396.includes("nodes:nodes.join"));
    ok("[396] 前端 requality 走 json", h396.includes("json:'1'") && h396.includes("runProbe(b,'requality'") && h396.includes(",true)"));
    ok("[396] 前端回填行单元格", h396.includes('td[data-cell="level"]') && h396.includes('td[data-cell="kind"]') && h396.includes('td[data-cell="source"]') && h396.includes("innerHTML=data.badge"));
    // 行为：tfb cap 上限与 pickFresh 选择
    const capRun = W.runTfb && typeof W.runTfb === "function";
    ok("[396] runTfb 可从窗口导出", capRun);
  }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case299({ regionsSource, ok, eq, W }) {
    const tl397 = regionsSource();
    // 结构：probe() 开头和 GET run() 一样有 aliveList 惰性载入，否则 POST 落到冷 isolate 时 countryOf 查不到
    ok("[397] probe 路径惰性载入国家码表",
      tl397.includes("POST 可能落到没 GET 过的 isolate") &&
      tl397.includes("await aliveList(this.c.env)"));
    // 惰性载入出现两处（GET run + POST probe）
    eq("[397] aliveList 惰性载入两处", (tl397.split("await aliveList(this.c.env)").length - 1), 2);
    // 行为：countryOf 从 seed byColo 查到国家码（探测结果每行靠它标 [CC]）
    const seedBackup397 = W.SEED_STORE.document && W.SEED_STORE.document.byColo ? W.SEED_STORE.document.byColo : null;
    try {
      W.NODE_MEMORY.alive.clear();
      if (W.SEED_STORE.document) W.SEED_STORE.document.byColo = { TST: { nodes: [{ k: "198.51.100.9:443", h: "198.51.100.9", p: 443, cc: "TST" }] } };
      eq("[397] countryOf 从 seed 查到国家码", W.countryOf("198.51.100.9:443"), "TST");
      eq("[397] ccTag 渲染国家码", W.ccTag("TST"), "[TST] ");
      eq("[397] 未知节点无国家码", W.countryOf("192.0.2.99:443"), "");
    } finally {
      W.NODE_MEMORY.alive.clear();
      if (W.SEED_STORE.document) W.SEED_STORE.document.byColo = seedBackup397;
    }
  }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case300({ regionsSource, readView, ok, W }) {
  const tools398 = regionsSource();
  const tpl398 = readView("src/views/html/regions.html");
  // 结构：表头有国家列、紧跟节点列；行里渲染 r.country（缺失显示 —）
  ok("[398] 表头有国家列", tools398.includes("<th>国家</th>"));
  ok("[398] 国家列在节点列后", tools398.indexOf("<th>节点</th>") < tools398.indexOf("<th>国家</th>") && tools398.indexOf("<th>国家</th>") < tools398.indexOf("<th>出站 IP</th>"));
  ok("[398] 行渲染国家码", tools398.includes('escapeHtml(r.country || "—")'));
  // 根因修复：checkSite placeholder 从 x.com（会被 obf/pre.js 的 SENS 编码成 __K 破坏 HTML 属性引号）改成不敏感的示例域名
  const checkInput398 = tpl398.split("\n").find((l) => l.includes('id="checkSite"'));
  ok("[398] checkSite placeholder 不触发混淆", !!checkInput398 && checkInput398.includes("example.com") && !checkInput398.includes("x.com"));
  // 其他两个输入框仍正常
  ok("[398] probeSite/targetHost 用示例域名", tpl398.includes('id="probeSite"') && tpl398.includes('id="targetHost"'));
  // 渲染：seed 节点带 cc=US，表格里出现国家码单元格
  const saveSeed398 = W.SEED_STORE.document;
  const saveAlive398 = new Map(W.NODE_MEMORY.alive);
  W.NODE_MEMORY.alive.clear();
  W.SEED_STORE.document = { v: 7, byColo: { US: { nodes: [{ k: "198.51.100.9:443", h: "198.51.100.9", p: 443, cc: "US" }] } } };
  const ctx398 = {
    url: new URL("https://edge.example.com/regions"),
    request: { method: "GET" },
    env: {}, id: "u398", pageKey: "",
    auth: { list: [{ id: "u398", pwd: "p", note: "", enabled: true, managed: true, regions: [] }], uuids: new Set(), trojan: new Map(), ok: true },
  };
  try {
    W.REGION_CACHE.rows = null;
W.REGION_CACHE.json = null; // JSON 结果缓存与行缓存同寿命，一起清
    const html398 = await (await W.regions(ctx398)).text();
    ok("[398] HTML 表头有国家列", html398.includes("<th>国家</th>"));
    ok("[398] HTML 行有国家码", html398.includes(">US</td>"));
    ok("[398] HTML 连通框 placeholder 正常", html398.includes('id="checkSite"') && !html398.includes("__K("));
  } finally {
    W.NODE_MEMORY.alive.clear();
    for (const [k, v] of saveAlive398) W.NODE_MEMORY.alive.set(k, v);
    W.SEED_STORE.document = saveSeed398;
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case301({ regionsSource, fs, ok, W, eq }) {
  const tl399 = regionsSource();
  const rg399 = fs.readFileSync("src/px/regions.ts", "utf8");
  // 结构：QUALITY 有独立 isoCc 表 + noteIso/getIso；展示层优先 ISO；文档 IP 跳过
  ok("[399] isoCc 表存在且有界", rg399.includes("readonly isoCc = new BoundedMap<"));
  ok("[399] noteIso/getIso 方法", rg399.includes("noteIso(host: string") && rg399.includes("getIso(host: string"));
  ok("[399] countryOf 优先 ISO", tl399.indexOf("QUALITY.getIso(host)") < tl399.indexOf("const exact = NODE_MEMORY.alive.get(relay)"));
  ok("[399] rows 用 ISO 码", tl399.includes("isoCc || live?.cc || seedCc"));
  ok("[399] 排除文档 IP 查询", tl399.includes("function isDocIp") && tl399.includes("!isDocIp(h)"));
  ok("[399] 惰性补码只在缺失时查", tl399.includes("QUALITY.isoNeeded(h)"));
  // 行为：noteIso/getIso 隔离缓存，优先于机场码
  const savedAlive399 = new Map(W.NODE_MEMORY.alive);
  const savedSeed399 = W.SEED_STORE.document && W.SEED_STORE.document.byColo;
  W.QUALITY.isoCc.clear();
  try {
    W.NODE_MEMORY.alive.clear();
    W.NODE_MEMORY.alive.set("198.51.100.9:443", { h: "198.51.100.9", p: 443, cc: "AMS", ms: 5 });
    eq("[399] 无 ISO 时回落机场码", W.countryOf("198.51.100.9:443"), "AMS");
    W.QUALITY.noteIso("198.51.100.9", "nl");
    eq("[399] ISO 大写存储", W.QUALITY.getIso("198.51.100.9"), "NL");
    eq("[399] ISO 覆盖机场码展示", W.countryOf("198.51.100.9:443"), "NL");
    eq("[399] 缺省端口也用 ISO", W.countryOf("198.51.100.9"), "NL");
    // 过期回退机场码
    W.QUALITY.isoCc.set("198.51.100.9", { cc: "NL", at: Date.now() - 4 * 86400_000 });
    eq("[399] 过期 ISO 回退机场码", W.countryOf("198.51.100.9:443"), "AMS");
    eq("[399] 过期 ISO 清除", W.QUALITY.getIso("198.51.100.9"), "");
  } finally {
    W.NODE_MEMORY.alive.clear();
    for (const [k, v] of savedAlive399) W.NODE_MEMORY.alive.set(k, v);
    if (W.SEED_STORE.document) W.SEED_STORE.document.byColo = savedSeed399;
    W.QUALITY.isoCc.clear();
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case302({ regionsSource, readView, ok, W, eq }) {
  const rs = regionsSource();
  const rh = readView("src/views/html/regions.html");
  ok("[400] rows 含全池 POOL_MEMORY.rows", rs.includes("...POOL_MEMORY.rows.map((x) => `${x.h}:${x.p}`)"));
  ok("[400] probed 认质量徽章", rs.includes("probed: !!cov || !!q"));
  ok("[400] 表格行带 data-probed", rs.includes("data-probed=\"${r.probed ? 1 : 0}\""));
  ok("[400] 服务端分页 size=40", rs.includes("const size = 40"));
  ok("[400] 分页切片", rs.includes("rows.slice((page - 1) * size"));
  ok("[400] page 由查询串取", rs.includes('searchParams.get("page")'));
  ok("[400] htmlView 带分页变量", rs.includes("pageInfo:") && rs.includes("prevHref:") && rs.includes("hasNext:"));
  ok("[400] 分页条模板", rh.includes('id="pager"') && rh.includes("{{pageInfo}}"));
  ok("[400] 折叠默认隐藏未探测", rh.includes('tr[data-probed="0"]') && rh.includes("folded=true"));
  ok("[400] 折叠开关按钮", rh.includes("data-act=\"toggle-unprobed\""));
  ok("[400] 探测后带 site 重载", rh.includes("reloadSite") && rh.includes("next.searchParams.set('site',reloadSite)"));
  ok("[400] 重载保留结果", rh.includes("rgProbeResult") && rh.includes("sessionStorage"));
  ok("[400] probe 函数第四参", rh.includes("function probe(action,extra,json,reloadSite)"));
  ok("[400] JS 无语法断裂", !rh.includes("})\n        if(reloadSite)"));
  // 行为：全池节点进入 rows 且分页正确
  const savePool400 = [...W.POOL_MEMORY.rows];
  const saveSeed400 = W.SEED_STORE.document;
  const saveAlive400 = new Map(W.NODE_MEMORY.alive);
  W.NODE_MEMORY.alive.clear();
  W.SEED_STORE.document = { v: 7, ts: Date.now(), poolGen: 1, poolN: 45, builtAt: Date.now(), byColo: {} };
  W.POOL_MEMORY.rows.length = 0;
  for (let i = 0; i < 45; i++) W.POOL_MEMORY.rows.push({ h: "203.0.113." + (i + 1), p: 443 });
  const ctx400 = { url: new URL("https://edge.example.com/regions"), env: {}, id: "u400", auth: { uuids: new Set(), list: [] } };
  W.REGION_CACHE.rows = null;
W.REGION_CACHE.json = null; // JSON 结果缓存与行缓存同寿命，一起清
  const r1 = await W.regions({ ...ctx400, url: new URL("https://edge.example.com/regions?format=json") });
  const j1 = await r1.json();
  eq("[400] JSON 全量 45 节点", j1.nodes.length, 45);
  const r2 = await W.regions({ ...ctx400, url: new URL("https://edge.example.com/regions?page=1") });
  const h2 = await r2.text();
  ok("[400] 第一页 40 行", (h2.match(/<tr /g) || []).length === 40);
  ok("[400] 分页信息 1/2", h2.includes("第 1/2 页"));
  ok("[400] 下一页链接可见", /data-show="1"[^>]*>下一页/.test(h2));
  const r3 = await W.regions({ ...ctx400, url: new URL("https://edge.example.com/regions?page=2") });
  const h3 = await r3.text();
  ok("[400] 第二页 5 行", (h3.match(/<tr /g) || []).length === 5);
  ok("[400] 分页信息 2/2", h3.includes("第 2/2 页"));
  W.POOL_MEMORY.rows.length = 0;
  W.POOL_MEMORY.rows.push(...savePool400);
  W.SEED_STORE.document = saveSeed400;
  W.NODE_MEMORY.alive = saveAlive400;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case303({ W, ok, eq }) {
  // ① egDerive 使用 EG_TINY 而不是 EG_BIG：源码证据 + 行为已在第 95 组验证
  const egSrc = W.egDerive.toString();
  ok("[402] egDerive 用 EG_TINY 门槛", egSrc.includes("down > EG_TINY"), "门槛不是 EG_TINY");
  ok("[402] egDerive 不再用 EG_BIG 判 v4", !/down >= EG_BIG/.test(egSrc), "仍用 EG_BIG");
  // ③ 国家码搭车：ip-api 源请求 fields 带 countryCode，QoS 成功行回填 isoCc（零新增子请求）
  const ipapi = W.QUALITY_SOURCES.find((x) => x.name === "ipapi-com");
  ok("[402] ipapi fields 含 countryCode", ipapi.url("1.2.3.4").includes("countryCode"), "fields 缺 countryCode");
  W.QUALITY.isoCc.clear();
  W.QUALITY.noteIso("1.2.3.4", "DE", Date.now());
  eq("[402] noteIso 可回读", W.QUALITY.getIso("1.2.3.4", Date.now()), "DE");
  W.QUALITY.isoCc.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case304({ W, ok, fs }) {
  const t0 = 1_700_000_000_000;
  // ② ConnObservation：灌 6000 行（> CONN_CAP=2000），表必须收敛到上限附近，不能无界涨
  const co = new W.ConnObservation();
  for (let i = 0; i < 6000; i++) co.note("HKG", `n${i}:443`, "x.com", 200, 100, W.IpFamily.IPv4, t0 + i);
  ok("[403] ConnObservation 有界（不超 CAP）", co.rows.size <= 2000 && co.rows.size > 0, `size=${co.rows.size}`);
  // ProbeCoverage：只 set 无 cap 是 1102 根因，灌 6000 行后必须收敛
  const cv = new W.ProbeCoverage();
  for (let i = 0; i < 6000; i++) cv.note(`n${i}:443`, W.IpFamily.IPv4, t0 + i);
  ok("[403] ProbeCoverage 有界", cv.rows.size <= 4000 && cv.rows.size > 0, `size=${cv.rows.size}`);
  // recheckCool：60s key 旧代码 TTL=3d 清不掉会一直涨，新代码靠容量上限收口
  const qt = new W.IpQualityTable();
  for (let i = 0; i < 6000; i++) qt.recheckMark(`s:site${i}`, t0 + i);
  ok("[403] recheckCool 有界", qt.recheckCool.size <= 4000 && qt.recheckCool.size > 0, `size=${qt.recheckCool.size}`);
  // 源码锁：三处手写全表 sort 已删除（1102 的 O(N log N) 来源）
  const rg403 = fs.readFileSync("src/px/regions.ts", "utf8");
  ok("[403] 写路径不再全表排序裁剪", !rg403.includes("].sort((a, b) => a[1].at"), "仍有手写全表 sort");
  // ④ 面板自选 server 走 CF 边缘，不是中继 IP
  const sub403 = fs.readFileSync("src/views/sub.ts", "utf8");
  ok("[403] 自选 emit server 用 vip 不用 ph", /emit\(name, proto, vip, 443,/.test(sub403), "server 不是 vip:443");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case306({ W, eq, fs, ok, regionsSource }) {
  const t0 = 1700000000000;
  const q = new W.IpQualityTable();
  eq("[405] host 初始需要查 ISO", q.isoNeeded("198.18.0.1", t0), true);
  q.markIsoTried("198.18.0.1", t0);
  eq("[405] 查过未命中后 TTL 内不重查", q.isoNeeded("198.18.0.1", t0 + 3600000), false);
  eq("[405] TTL 过后允许重试", q.isoNeeded("198.18.0.1", t0 + 7 * 3600000), true);
  q.noteIso("198.18.0.2", "US", t0);
  eq("[405] 已有国家码的 host 不再查", q.isoNeeded("198.18.0.2", t0), false);
  // 源码锁：五处 prune 都带「超容量」守卫，常态 O(1) set（O(N²) 是 1102 根因）
  const rg405 = fs.readFileSync("src/px/regions.ts", "utf8");
  const guards405 = rg405.split(".capacity()) this.").length - 1;
  ok("[405] 五处 prune 都有超容量守卫", guards405 >= 5, `guards=${guards405}`);
  // 负缓存确实接到展示层的查询路径上（ensureIsoCountries 用 isoNeeded + markIsoTried）
  const tools405 = regionsSource();
  ok("[405] ensureIsoCountries 用 isoNeeded 过滤", tools405.includes("QUALITY.isoNeeded(h)"), "未过滤已查 host");
  ok("[405] 发起查询前登记负缓存", tools405.includes("QUALITY.markIsoTried(h)"), "失败 host 会每 GET 重试");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case307({ ok, W, regionsSource }) {
  ok("[406] 状态表有 regionRowsCache 字段", Object.prototype.hasOwnProperty.call(W.REGION_CACHE, "rows"), "缺字段");
  const tools406 = regionsSource();
  ok("[406] 命中只看寿命不看 key", tools406.includes("REGION_CACHE.freshRows(now)") && !tools406.includes("cache.key === key"), "churn 会触发重建");
  ok("[406] 缓存不计算无用指纹", !tools406.includes("aliveSig") && !tools406.includes("seedSig"), "无效指纹增加热路径成本");
  ok("[406] target 四列补算", tools406.includes("CONN_OBS.rttOf(coloNow") && tools406.includes("PS.okOf(target") && tools406.includes("BLK.penOf(target") && tools406.includes("DNS.v6Of(target"), "四列未渲染时补算");
  const cache406 = new W.RegionPageCache();
  cache406.rows = { t: 1000, rows: [] };
  ok("[406] 缓存 30 秒过期", cache406.freshRows(30999) !== null && cache406.freshRows(31000) === null, "TTL 不是 30 秒");
  ok("[406] 写回缓存", tools406.includes("REGION_CACHE.rows = { t: now, rows }"), "未写回");
  ok("[406] POST 不清整表缓存", tools406.includes("不在 POST 入口清整表缓存") && !tools406.includes("REGION_CACHE.rows = null; // 探测/写配置"), "POST 清缓存会累积触发 1102");
  // 行为：用 ctx 走真实 routes() 两次；第一次填充缓存、第二次同 URL 命中（不重建），换 site 重建
  const savedCache406 = W.REGION_CACHE.rows;
  W.REGION_CACHE.rows = null;
  const ctx406 = { url: new URL("https://edge.example.com/regions?format=json"), env: {}, id: "u406" };
  await W.regions(ctx406);
  const c1 = W.REGION_CACHE.rows;
  ok("[406] GET 后缓存已填充", !!c1 && c1.rows.length > 0, `rows=${c1 && c1.rows.length}`);
  await W.regions(ctx406);
  ok("[406] 同 target 命中缓存不重建", W.REGION_CACHE.rows === c1, "缓存被重建");
  const ctx406b = { url: new URL("https://edge.example.com/regions?format=json&site=other.test"), env: {}, id: "u406" };
  await W.regions(ctx406b);
  ok("[406] 不同 target 命中缓存", W.REGION_CACHE.rows === c1, "换 site 重建了整表");
  // 后台 probe 改 alive（churn）不应触发重建——旧代码用完整指纹做 key，每次都重建 → CF 上 1102
  W.NODE_MEMORY.alive.set("99.0.0.77:443", { h: "99.0.0.77", p: 443, cc: "US", at: Date.now() });
  await W.regions(ctx406);
  ok("[406] alive churn 不触发重建", W.REGION_CACHE.rows === c1, "后台探活改 alive 导致重建");
  W.NODE_MEMORY.alive.delete("99.0.0.77:443");
  W.REGION_CACHE.rows = savedCache406;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case308({ fs, regionsSource, readView, ok, W, eq }) {
  const reg407 = fs.readFileSync("src/px/regions.ts", "utf8");
  const types407 = fs.readFileSync("types/app.d.ts", "utf8");
  const tools407 = regionsSource();
  const html407 = readView("src/views/html/regions.html");
  // 结构锁：org 是客观属性能进 IpQuality；reach 是实测值只进 CONN_OBS
  ok("[407] IpQuality 有 org 字段", types407.includes("org?: string"), "org 未进 IpQuality");
  ok("[407] qualityFromIpApi 带 org", reg407.includes("if (row.org) q.org = String(row.org)"), "批量查询没带出组织");
  ok("[407] qualityOf 带 org", reg407.includes("if (org) result.org = org"), "手动重探没带出组织");
  ok("[407] 可达性走 probeSni", tools407.includes('probeSni(rh, rp, "www.cloudflare.com", CONNECT_MS, this.c.budget)'), "没拨节点判可达");
  ok("[407] 可达写 CONN_OBS", tools407.includes('CONN_OBS.note(ISOLATE.colo || "??", key, "@reach"'), "可达性没落本 isolate");
  ok("[407] reach 不进 IpQuality", !reg407.includes("reachable") && !reg407.includes("reach?:"), "实测值跨 isolate 传播了");
  ok("[407] rows 读 @reach", tools407.includes('CONN_OBS.get(coloNow, r.key, "@reach", now)'), "写了没读=死数据");
  ok("[407] 表格显示组织列", tools407.includes('data-cell="org"') && html407.includes('data-cell="org"'), "组织未展示");
  ok("[407] 前端回填组织", html407.includes("data.org||"), "回填没刷新组织");
  // 行为：qualityFromIpApi 从 ip-api 行里提取 org
  const q407 = W.qualityFromIpApi({ status: "success", org: "Example Telecom", countryCode: "US", hosting: false, mobile: false, proxy: false }, Date.now());
  eq("[407] org 提取", q407 && q407.org, "Example Telecom");
  // 行为：reach 写 CONN_OBS 后按 key 读回（黑洞=code 0 → ok=false）
  const colo407 = "TST", key407 = "198.51.100.77:443";
  W.CONN_OBS.note(colo407, key407, "@reach", 0, 1234, W.IpFamily.IPv4, Date.now());
  const rr407 = W.CONN_OBS.get(colo407, key407, "@reach", Date.now());
  ok("[407] 黑洞观测可读回", !!rr407 && rr407.ok === false, "CONN_OBS 读不到黑洞结果");
  W.CONN_OBS.note(colo407, key407, "@reach", 200, 322, W.IpFamily.IPv4, Date.now());
  const rr407b = W.CONN_OBS.get(colo407, key407, "@reach", Date.now());
  ok("[407] 可用观测覆盖", !!rr407b && rr407b.ok === true, "可用结果没覆盖黑洞结果");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case309({ fs, ok, W }) {
  const tr408 = fs.readFileSync("src/core/transport.ts", "utf8");
  const sub408 = fs.readFileSync("src/views/sub.ts", "utf8");
  ok("[408] 有中继时强制隧道", tr408.includes("forceTunnel: !!relay"), "没传 forceTunnel，native fetch 会忽略 connect 回调");
  ok("[408] Clash MATCH 指向手动组", sub408.includes("`  - MATCH,${G_MAN}`"), "MATCH 仍锁在 url-test，自选节点不生效");
  const auth408 = { list: [{ id: "u408", pwd: "p", note: "", enabled: true, managed: true, pinnedNodes: ["45.151.183.22:443"] }], uuids: new Set(), trojan: new Map(), ok: true };
  const clash408 = W.renderClash(
    { uuid: "u408", nodes: "", proxyip: "auto", defaultMode: "tput" },
    new URL("https://example.com/u408"), "u408", "example.com", {}, [], auth408);
  ok("[408] 规则里 MATCH 到手动组 v2", clash408.includes("- MATCH,🎯 手动 v2"), "实际订阅规则没指向手动组");
  const man408 = clash408.slice(clash408.indexOf('- name: "🎯 手动 v2"'), clash408.indexOf('- name: "🎯 手动 v2"') + 900);
  ok("[408] 手动组含硬钉节点且默认回自动组", man408.includes("📌45.151.183.22") && man408.includes('default-selected: "🚀 吞吐优先"'), "手动组没纳入硬钉节点或缺默认回退");
  // 决定性行为：stub fetch 恒 200，若 forceTunnel 生效则必定走 gate.openSocket（此处抛标记错），
  // 结果 ok:false 且 err 含标记；若没生效则被 native fetch 骗成 ok:true —— 这正是黑洞假 200 的成因。
  const realFetch408 = globalThis.fetch;
  let dialed408 = false;
  const gate408 = { openSocket() { dialed408 = true; throw new Error("TUNNEL_DIALED_408"); }, fetch() { throw new Error("no sub"); }, snapshot() { return {}; } };
  try {
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    const out408 = await W.TRANSPORTS.get("tunnelfetch").probe("www.example.com", "203.0.113.99:443", "/", 1500, gate408);
    ok("[408] 中继探测没被 native fetch 骗成 200", out408.ok === false, "不存在的中继仍返回 200=没走隧道");
    ok("[408] 中继探测真的调用了 connect 回调", dialed408 === true, "connect 回调没被调用");
  } finally { globalThis.fetch = realFetch408; }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case314({ readView, regionsSource, ok, W }) {
  const tpl413 = readView("src/views/html/regions.html");
  const tools413 = regionsSource();
  ok("[413] 搜索框", tpl413.includes('id="q"') && tpl413.includes("搜索 IP"));
  ok("[413] 筛选按钮三档", tpl413.includes('data-filter="sel"') && tpl413.includes('data-filter="ok"') && tpl413.includes('data-filter="no"'));
  ok("[413] 统计计数位", tpl413.includes('id="cntShown"') && tpl413.includes('id="cntSel"') && tpl413.includes('id="cntCc"'));
  ok("[413] 吸底保存条", tpl413.includes('class="savebar"') && tpl413.includes('form="saveForm"'));
  ok("[413] 横向滚动容器样式", tpl413.includes(".tw{overflow-x"));
  ok("[413] 折叠箭头样式", tpl413.includes(".cgroup .caret") && tpl413.includes(".cgroup.closed"));
  ok("[413] 浮层提示可标错", tpl413.includes("#result.err") && tpl413.includes("show('请先填写要探测的网站',1)"));
  ok("[413] 筛选是客户端收窄", tpl413.includes("function matchFilter") && tpl413.includes("classList.toggle('hide'"));
  ok("[413] 组头点击折叠", tpl413.includes("closest('h2.cgroup')") && tpl413.includes("classList.toggle('closed'"));
  ok("[413] 行属性 data-search/data-reach/data-cc", tools413.includes('data-search="') && tools413.includes('data-reach="') && tools413.includes('data-cc="'));
  ok("[413] 表格套 tw 容器", tools413.includes('<div class="tw"><table>'));
  ok("[413] 组头带折叠箭头", tools413.includes('<span class="caret">'));
  ok("[413] 空态给重建入口", tools413.includes("重建池子"));
  // 渲染一遍：确认占位符都替换掉、行属性真的出现在 HTML 里
  const saveSeed413 = W.SEED_STORE.document;
  const saveAlive413 = new Map(W.NODE_MEMORY.alive);
  W.NODE_MEMORY.alive.clear();
  W.SEED_STORE.document = { v: 7, byColo: { US: { nodes: [{ k: "198.51.100.9:443", h: "198.51.100.9", p: 443, cc: "US" }] } } };
  const ctx413 = {
    url: new URL("https://edge.example.com/regions"),
    request: { method: "GET" },
    env: {}, id: "u413", pageKey: "",
    auth: { list: [{ id: "u413", pwd: "p", note: "", enabled: true, managed: true, regions: ["US"] }], uuids: new Set(), trojan: new Map(), ok: true },
  };
  W.REGION_CACHE.rows = null;
  const html413 = await (await W.regions(ctx413)).text();
  ok("[413] 渲染后无占位符残留", !html413.includes("{{") , html413.slice(0, 120));
  ok("[413] 渲染出搜索框", html413.includes('id="q"'));
  ok("[413] 渲染出行属性", html413.includes('data-search="') && html413.includes('data-cc="US"'));
  ok("[413] 渲染出吸底保存", html413.includes('class="savebar"'));
  // 空态分支由源码锁覆盖（运行时池子里总有行）
  W.NODE_MEMORY.alive.clear();
  for (const [k, v] of saveAlive413) W.NODE_MEMORY.alive.set(k, v);
  W.SEED_STORE.document = saveSeed413;
  W.REGION_CACHE.rows = null;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case315({ fs, regionsSource, ok, eq, W }) {
  const util414 = fs.readFileSync("src/core/util.ts", "utf8");
  const tun414 = fs.readFileSync("src/proxy/tunnel.ts", "utf8");
  const tools414 = regionsSource();
  const lim414 = fs.readFileSync("docs/LIMITS.md", "utf8");
  const conn414 = fs.readFileSync("src/proxy/connection.ts", "utf8");
  // safeSend 以前静默 return：客户端走了管道还得再搬 512KB 才发现
  ok("[414] safeSend 返回布尔", util414.includes("export function safeSend(ws: WebSocketLike, data: Uint8Array): boolean"));
  ok("[414] safeSend 未开连接返回 false", util414.includes("if (!ws || ws.readyState !== WS_OPEN) return false;"));
  ok("[414] safeSend 异常也返回 false", util414.includes("/* 对端已关闭：与 readyState 检查同等语义，交给调用方收尾 */"));
  eq("[414] safeSend 未开连接返回 false（行为）", W.safeSend({ readyState: 3 }, new Uint8Array(1)), false);
  let sent414 = 0;
  eq("[414] safeSend 开会话返回 true（行为）", W.safeSend({ readyState: 1, send: () => { sent414++; } }, new Uint8Array(1)), true);
  eq("[414] safeSend 真的发了", sent414, 1);
  // 发不出去要让 pipe 立刻收尾
  ok("[414] 写失败抛 client gone", tun414.includes('if (!safeSend(ws, merged)) throw new Error("client gone");') && tun414.includes('} else if (!safeSend(ws, u8)) {'));
  // 客户端中途消失必须留下「搬到多少字节 / 跑了多久」的证据，并落盘
  ok("[414] client gone 记字节与耗时", tun414.includes("client gone ") && tun414.includes("st.down}B/"));
  ok("[414] client gone 立刻推 DO", tun414.includes("await PEND.flush(st.env, true, 1)"));
  ok("[414] PEND 与 pendAdd 已导入", tun414.includes('import { PEND, pendAdd } from "../store/pend";'));
  // ?limit= 收窄 JSON（默认仍全量）
  ok("[414] json 支持 limit", tools414.includes('searchParams.get("limit")') && tools414.includes("limit > 0 ? rows.slice(0, limit) : rows"));
  const ctx414 = {
    url: new URL("https://edge.example.com/regions?format=json&limit=2"),
    request: { method: "GET" },
    env: {}, id: "u414", pageKey: "",
    auth: { list: [{ id: "u414", pwd: "p", note: "", enabled: true, managed: true, regions: [] }], uuids: new Set(), trojan: new Map(), ok: true },
  };
  const save414 = W.SEED_STORE.document;
  W.SEED_STORE.document = { v: 7, byColo: { US: { nodes: [
    { k: "198.51.100.1:443", h: "198.51.100.1", p: 443, cc: "US" },
    { k: "198.51.100.2:443", h: "198.51.100.2", p: 443, cc: "US" },
    { k: "198.51.100.3:443", h: "198.51.100.3", p: 443, cc: "US" },
  ] } } };
  W.REGION_CACHE.rows = null;
  const j414 = JSON.parse(await (await W.regions(ctx414)).text());
  eq("[414] limit=2 只回两行", j414.nodes.length, 2);
  const ctx414b = { ...ctx414, url: new URL("https://edge.example.com/regions?format=json") };
  W.REGION_CACHE.rows = null;
  const j414b = JSON.parse(await (await W.regions(ctx414b)).text());
  ok("[414] 不带 limit 仍全量", j414b.nodes.length >= 3);
  W.SEED_STORE.document = save414;
  W.REGION_CACHE.rows = null;
  // 文档漂移：真实阈值 4MB/180s/64MB（7.426 改回 64MB，并在文档里记下 A/B 结论）
  ok("[414] LIMITS 背压阈值同步", lim414.includes("4 MB") && lim414.includes("180 s") && lim414.includes("64 MB"));
  ok("[414] connection 注释不再写 16MB/60秒", !conn414.includes("缓冲涨到 16MB 上限或等满 60 秒") && conn414.includes("WS_STALL_MS（180s）"));
  const tun415 = fs.readFileSync("src/proxy/tunnel.ts", "utf8");
  ok("[415] 异常收尾记录已搬字节与耗时", tun415.includes("dl end ${st ? st.down : 0}B/${endMs}ms"));
  ok("[415] 异常收尾记录 WS 状态与是否已通知", tun415.includes("rs=${ws ? ws.readyState : -1} n=${st && st.notified ? 1 : 0}"));
  ok("[415] 异常收尾当场 awaited 推 DO", tun415.includes("await PEND.flush(st.env, true, 1).catch(() => {});"));
  ok("[415] 旧的 pipe 日志已换成带数据的证据行", !tun415.includes('logErr("pipe: " + errMsg(err)'));
  ok("[415] clientGone 分支仍单独记一条", tun415.includes("client gone ${st.down}B/${goneMs}ms"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case317({ ok, W, regionsSource }) {
  ok("[417] 状态表有 JSON 结果缓存", typeof W.REGION_CACHE === "object" && "json" in W.REGION_CACHE);
  const tools417 = regionsSource();
  ok("[417] 命中缓存就不再序列化", tools417.includes("REGION_CACHE.freshJson(jkey, nowJson)") && tools417.includes("hitJson !== null"));
  ok("[417] 缓存键含站点与条数上限", tools417.includes("const jkey = target + \"|\" + limit;"));
  ok("[417] 序列化后写回缓存", tools417.includes("REGION_CACHE.json = { t: nowJson, key: jkey, text: bodyJson };"));
  ok("[417] body 读掉后用同 headers 重新组装", tools417.includes("return new Response(bodyJson, { headers: respJson.headers });"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case318({ readView, regionsSource, ok }) {
  const tpl418 = readView("src/views/html/regions.html");
  const tools418 = regionsSource();
  ok("[418] 覆盖提示存在且用 CF 托管普适判据", tpl418.includes("这些节点能覆盖哪些站") && tpl418.includes("Cloudflare") && tpl418.includes(".notice"));
  ok("[418] 提示不写死具体站点域名", !/\bgithub\b|\bgstatic\b|\bx\.com\b|\bgoogle\b/i.test(tpl418));
  ok("[418] 筛选按钮用 CF 站口径", tpl418.includes('data-filter="ok">CF 可达') && tpl418.includes('data-filter="no">CF 不通'));
  ok("[418] 重探回填通过统一显隐入口重排", !tpl418.includes("row.style.display=''") && tpl418.includes("row.setAttribute('data-probed','1');\n            refresh();"));
  ok("[418] 覆盖计数文案标明本页口径", tools418.includes("本页已知 ${input.rows.length}"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case319({ W, ok, eq, fs, regionsSource }) {
  const has418 = typeof W.socksConnectReq === "function" && typeof W.SocksPool === "function";
  ok("[418] 测试窗口导出 SOCKS 握手与池子", has418);
  if (has418) {
  // ① IPv4 目标：VER=5 CMD=1 RSV=0 ATYP=1 + 4 字节地址 + 2 字节端口
  const v4 = W.socksConnectReq({ host: "1.2.3.4", port: 443 });
  eq("[418] IPv4 目标长度", v4.length, 10);
  eq("[418] IPv4 前缀", Array.from(v4.slice(0, 4)).join(","), "5,1,0,1");
  eq("[418] IPv4 地址与端口", Array.from(v4.slice(4)).join(","), "1,2,3,4,1,187");
  // ② 域名目标：ATYP=3 + 1 字节长度 + 域名（example.com 是 11 字节）
  const dom = W.socksConnectReq({ host: "example.com", port: 80 });
  eq("[418] 域名目标 ATYP 与长度", Array.from(dom.slice(3, 5)).join(","), "3,11");
  eq("[418] 域名目标末端端口", [dom[dom.length - 2], dom[dom.length - 1]].join(","), "0,80");
  // ③ 抓列表：内网/保留地址丢掉、重复条目只留一条
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("1.2.3.4:1080\n10.0.0.1:1080\n1.2.3.4:1080\n5.6.7.8:9050\nbad line\n");
  const pool = new W.SocksPool();
  const n = await pool.refill({});
  globalThis.fetch = origFetch;
  eq("[418] 抓列表丢内网并去重", n, 2);
  const snap = pool.snap();
  eq("[418] 快照条目数", snap.rows.length, 2);
  eq("[418] 未验证的不算可用", snap.ok, 0);
  eq("[418] 未验证的不会被选中", pool.pick(), null);
  eq("[418] 池内端口解析正确", snap.rows.map((r) => r.port).sort((a, b) => a - b).join(","), "1080,9050");
  // ④ 记一次失败后 fails 增长（推进冷却的依据）
  pool.markFail("1.2.3.4:1080");
  eq("[418] markFail 记一次失败", pool.snap().rows.find((r) => r.h === "1.2.3.4").fails, 1);
  eq("[418] 池子上限", W.SOCKS_MAX, 400);
  // ⑤ 三处接线必须在：会话解析、路由分支、面板数据源
  const ses418 = fs.readFileSync("src/proxy/session.ts", "utf8");
  ok("[418] 会话解析 ?s5=", ses418.includes('q.get("s5")'));
  const fb418 = fs.readFileSync("src/proxy/fallback.ts", "utf8");
  ok("[418] 路由有 viaSocks 分支", fb418.includes("if (this.o.socksNode) return this.viaSocks(host, port);"));
  ok("[418] 握手失败不回落到别的出口", fb418.includes('onHangUp(1011, "socks5 failed")'));
  const tl418 = regionsSource();
  ok("[418] JSON 暴露代理池", tl418.includes("s5: SOCKS.snap()"));
  ok("[418] POST 有 op=socks", tl418.includes('if (op === "socks")'));
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case320({ readView, ok }) {
  const tpl419 = readView("src/views/html/regions.html");
  ok("[419] 表头不再粘性（横向滚动容器里 sticky 会压到行上）", !tpl419.includes("position:sticky;top:44px"));
  ok("[419] 工具栏仍粘性", tpl419.includes("#toolbar{position:sticky;top:0"));
  ok("[419] 行显隐只有一个入口", tpl419.includes("tr.matches('tr[data-probed=\"0\"]')") && tpl419.includes("tr.style.display=ok?'':'none'"));
  ok("[419] 计数按实际显示统计", tpl419.includes("if(tr.style.display!=='none')shown++"));
  ok("[419] 组折叠走 folded 类", tpl419.includes("tb.classList.toggle('folded')") && !tpl419.includes("tb.style.display=hid?'':'none'"));
  ok("[419] 展开全部后重算显隐", tpl419.includes("tb.classList.toggle('folded',!open)") && tpl419.includes("applyFold();refresh();"));
}
