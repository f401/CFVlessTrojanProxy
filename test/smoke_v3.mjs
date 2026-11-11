import mod from "./_bundle.mjs";
import * as W from "./_bundle.mjs";

let pass = 0, fail = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log(`FAIL ${n}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); } };
const ok = (n, c) => eq(n, !!c, true);

const UUID = "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1";
const env = {
  uuids: UUID,
  trojan: `${UUID}:test123`,
  nodes: "a.example.com:443:tls,104.16.0.1:443:tls",
};

const mk = (path, headers = {}) => {
  const u = new URL("https://a.example.com" + path);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    url: u.toString(),
    headers: { get: (k) => h[String(k).toLowerCase()] ?? null },
    cf: { asn: 4134, city: "Guangzhou", colo: "HKG", clientTcpRtt: 42 },
  };
};
const ctx = { waitUntil: () => {} };

async function run(path, headers) {
  const r = await mod.fetch(mk(path, headers), env, ctx);
  const body = await r.text();
  return { status: r.status, headers: Object.fromEntries(r.headers), body };
}

/* health */
let r = await run("/health");
eq("health 200", r.status, 200);
ok("health json", JSON.parse(r.body).ok === true);

/* 控制页 */
r = await run(`/${UUID}`);
eq("控制页 200", r.status, 200);
ok("控制页 html", r.headers["content-type"].includes("text/html"));
ok("控制页含订阅链接", r.body.includes(`/${UUID}/cl`));

/* 订阅 + Subscription-Userinfo */
r = await run(`/${UUID}/cl`);
eq("clash 200", r.status, 200);
ok("clash 有 userinfo 头", !!r.headers["subscription-userinfo"]);
ok("clash 头含 upload", /upload=\d+/.test(r.headers["subscription-userinfo"]));
ok("clash 含 trojan", r.body.includes("type: trojan"));
ok("clash 含 ip 标签", r.body.includes("&ip=104-16-0-1-443"));

/* singbox */
r = await run(`/${UUID}/sb`);
eq("singbox 200", r.status, 200);
let sb = null;
try { sb = JSON.parse(r.body); } catch (e) {}
ok("singbox 是合法 JSON", sb && Array.isArray(sb.outbounds));
ok("singbox outbound 数", sb.outbounds.length === 2 * 2 * 2 + 4);  // 2 节点 x 2 协议 x 2 模式 + 2 urltest + selector

/* base64 */
r = await run(`/${UUID}/ty`);
ok("ty 可 base64 解码", Buffer.from(r.body, "base64").toString("utf8").includes("vless://"));

/* stats */
r = await run(`/${UUID}/stats`);
eq("stats 200", r.status, 200);
ok("stats json 含 up/down", "up" in JSON.parse(r.body) && "down" in JSON.parse(r.body));

r = await run(`/${UUID}/stats?format=html`);
ok("stats html", r.headers["content-type"].includes("text/html") && r.body.includes("实测 RTT"));

/* logs */
r = await run(`/${UUID}/logs`);
eq("logs 200", r.status, 200);
ok("logs 结构", Array.isArray(JSON.parse(r.body).items));

/* 404 */
r = await run("/nope");
eq("未知路径 404", r.status, 404);
ok("404 不泄露 cf", !r.body.includes("colo"));

r = await run(`/${UUID}/unknown`);
eq("未知子路径 404", r.status, 404);

/* pageKey */
const env2 = { ...env, pageKey: "s3cret" };
const r2 = await mod.fetch(mk(`/${UUID}`), env2, ctx);
eq("pageKey 缺失 403", r2.status, 403);
const r3 = await mod.fetch(mk(`/${UUID}?k=s3cret`), env2, ctx);
eq("pageKey 正确 200", r3.status, 200);

/* 无 uuid 配置：/health 仍然可用（便于全新部署自检），业务路径才 500 */
const r4 = await mod.fetch(mk("/health"), {}, ctx);
eq("无 uuid 时 /health 仍可用", r4.status, 200);
const r4b = await mod.fetch(mk("/"), {}, ctx);
eq("无 uuid 时业务路径 500", r4b.status, 500);

/* 写操作必须管理员：restore 会往 DO 写数据 */
r = await run(`/${UUID}/debug?restore=1`);
eq("debug restore 需要管理员", r.status, 403);

/* 未知路径不返回 request.cf（旧版是 200 + 2.3KB JSON） */
r = await run("/");
eq("根路径 404", r.status, 404);

console.log(`\nsmoke：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
