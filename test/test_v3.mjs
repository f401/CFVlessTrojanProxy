import * as W from "./_bundle.mjs";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

let pass = 0,
  fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got),
    b = JSON.stringify(want);
  if (a === b) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${name}\n  got : ${a}\n  want: ${b}`);
  }
};
const ok = (name, cond, info = "") => eq(name, !!cond, true) || (!cond && console.log("  info:", info));

/* ---------- 1. SHA-224 官方向量 ---------- */
eq(
  "sha224('')",
  W.toHex(W.sha224Bytes(new TextEncoder().encode(""))),
  "d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f",
);
eq(
  "sha224('abc')",
  W.toHex(W.sha224Bytes(new TextEncoder().encode("abc"))),
  "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7",
);
eq(
  "sha224('test123')",
  W.toHex(W.sha224Bytes(new TextEncoder().encode("test123"))),
  "4f555b1bb8bc729a665b8892df73119e2ef2eb50dffaf0d5c546cf23",
);
eq(
  "sha224('Passw0rd!')",
  W.toHex(W.sha224Bytes(new TextEncoder().encode("Passw0rd!"))),
  "72f6c09f12fe97e7ab06d44fa4abc999904811729a7af49f040ee454",
);

/* ---------- 测试数据构造 ---------- */
const UUID = "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1";
const UUID2 = "11111111-2222-3333-4444-555555555555";
const PWD = "test123";
const enc = new TextEncoder();

function uuidToBytes(u) {
  const h = u.replace(/-/g, "");
  const a = new Uint8Array(16);
  for (let i = 0; i < 16; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}

function vlessBuf(uuid, host = "example.com", port = 80, cmd = 1, atyp = 2) {
  const d = enc.encode(host);
  const b = new Uint8Array(1 + 16 + 1 + 1 + 2 + 1 + 1 + d.length + 8);
  let o = 0;
  b[o++] = 0; // ver
  b.set(uuidToBytes(uuid), o);
  o += 16;
  b[o++] = 0; // optLen
  b[o++] = cmd;
  b[o++] = (port >> 8) & 0xff;
  b[o++] = port & 0xff;
  b[o++] = atyp;
  b[o++] = d.length;
  b.set(d, o);
  o += d.length;
  b[o++] = 0x41;
  b[o++] = 0x42; // payload
  return b.slice(0, o);
}

function trojanBuf(pwd, host = "example.com", port = 80, cmd = 1, atyp = 3) {
  const hash = enc.encode(W.toHex(W.sha224Bytes(enc.encode(pwd))));
  const d = enc.encode(host);
  const b = new Uint8Array(56 + 2 + 1 + 1 + 1 + d.length + 2 + 2 + 4);
  let o = 0;
  b.set(hash, o);
  o += 56;
  b[o++] = 0x0d;
  b[o++] = 0x0a;
  b[o++] = cmd;
  b[o++] = atyp;
  b[o++] = d.length;
  b.set(d, o);
  o += d.length;
  b[o++] = (port >> 8) & 0xff;
  b[o++] = port & 0xff;
  b[o++] = 0x0d;
  b[o++] = 0x0a;
  b[o++] = 0x41;
  b[o++] = 0x42;
  return b.slice(0, o);
}

/* ---------- 2. 协议侦测 ---------- */
eq("detect(vless)", W.detectProtocol(vlessBuf(UUID)), "vless");
eq("detect(trojan)", W.detectProtocol(trojanBuf(PWD)), "trojan");
eq("detect(短包)", W.detectProtocol(new Uint8Array([0, 1, 2])), "vless");

/* ---------- 3. 解析 ---------- */
const auth = await W.loadUsers({ uuids: UUID, trojan: `${UUID}:${PWD}` });
eq("auth.uuids.size", auth.uuids.size, 1);
eq("auth.trojan.size", auth.trojan.size, 1);

const v = W.parseVLESS(vlessBuf(UUID), auth);
ok("vless 解析成功", v.ok, v.err);
eq("vless.host", v.host, "example.com");
eq("vless.port", v.port, 80);
eq("vless.udp", v.udp, false);
eq("vless.offset", v.offset, 1 + 16 + 1 + 1 + 2 + 1 + 1 + 11);

const vBad = W.parseVLESS(vlessBuf(UUID2), auth);
eq("vless 错误 uuid 被拒", vBad.ok, false);
eq("vless 错误 uuid 原因", vBad.err, "鉴权失败");

const t = W.parseTrojan(trojanBuf(PWD), auth);
ok("trojan 解析成功", t.ok, t.err);
eq("trojan.host", t.host, "example.com");
eq("trojan.port", t.port, 80);
eq("trojan.offset", t.offset, 56 + 2 + 1 + 1 + 1 + 11 + 2 + 2);
eq("trojan 回填 uuid", t.id, UUID);

const tBad = W.parseTrojan(trojanBuf("wrongpwd"), auth);
eq("trojan 错误密码被拒", tBad.ok, false);

const V6 = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
function vlessBufV6(uuid) {
  const b = new Uint8Array(1 + 16 + 1 + 1 + 2 + 1 + 16 + 4);
  let o = 0;
  b[o++] = 0;
  b.set(uuidToBytes(uuid), o);
  o += 16;
  b[o++] = 0;
  b[o++] = 1;
  b[o++] = 0x01;
  b[o++] = 0xbb;
  b[o++] = 3;
  b.set(V6, o);
  o += 16;
  b[o++] = 0x41;
  return b.slice(0, o);
}
function trojanBufV6(pwd) {
  const hash = enc.encode(W.toHex(W.sha224Bytes(enc.encode(pwd))));
  const b = new Uint8Array(56 + 2 + 1 + 1 + 16 + 2 + 2 + 4);
  let o = 0;
  b.set(hash, o);
  o += 56;
  b[o++] = 0x0d;
  b[o++] = 0x0a;
  b[o++] = 1;
  b[o++] = 4;
  b.set(V6, o);
  o += 16;
  b[o++] = 0x01;
  b[o++] = 0xbb;
  b[o++] = 0x0d;
  b[o++] = 0x0a;
  b[o++] = 0x41;
  return b.slice(0, o);
}
const v6 = W.parseVLESS(vlessBufV6(UUID), auth);
ok("vless IPv6 地址解析", v6.ok, v6.err);
eq("vless IPv6 host", v6.host, "2001:db8:0:0:0:0:0:1");
eq("vless IPv6 port", v6.port, 443);

const t6 = W.parseTrojan(trojanBufV6(PWD), auth);
ok("trojan IPv6 地址解析", t6.ok, t6.err);
eq("trojan IPv6 host", t6.host, "2001:db8:0:0:0:0:0:1");
eq("trojan IPv6 port", t6.port, 443);

/* ---------- 4. 目标策略 ---------- */
eq("拦 127.0.0.1", !!W.checkTarget("127.0.0.1", 80), true);
eq("拦 localhost. 末尾点", !!W.checkTarget("localhost.", 80), true);
eq("拦 127.1 简写", !!W.checkTarget("127.1", 80), true);
eq("拦 2130706433 整数写法", !!W.checkTarget("2130706433", 80), true);
eq("拦 0177.0.0.1 八进制写法", !!W.checkTarget("0177.0.0.1", 80), true);
eq("拦 ::ffff:127.0.0.1", !!W.checkTarget("::ffff:127.0.0.1", 80), true);
eq("拦 ::ffff:7f00:1", !!W.checkTarget("::ffff:7f00:1", 80), true);
eq("拦 NAT64 编码的 127.0.0.1", !!W.checkTarget("64:ff9b::7f00:1", 80), true);
eq("拦 198.18.0.1 基准测试段", !!W.checkTarget("198.18.0.1", 80), true);
eq("拦 10.1.2.3", !!W.checkTarget("10.1.2.3", 80), true);
eq("拦 169.254.169.254", !!W.checkTarget("169.254.169.254", 80), true);
eq("拦 192.168.1.1", !!W.checkTarget("192.168.1.1", 80), true);
eq("拦 ::1", !!W.checkTarget("::1", 80), true);
eq("拦 6379 端口", !!W.checkTarget("1.1.1.1", 6379), true);
eq("放行 8.8.8.8:53", W.checkTarget("8.8.8.8", 53), null);
eq("放行 example.com:443", W.checkTarget("example.com", 443), null);

/* ---------- 5. 配置渲染 ---------- */
const env = {
  uuids: UUID,
  trojan: `${UUID}:${PWD}`,
  nodes: "a.example.com:443:tls,c.example.com:8880:plain",
};
const url = new URL("https://a.example.com/" + UUID + "/cl");

const cl = W.renderClash(env, url, UUID, "a.example.com");
ok("clash 含 vless 节点", cl.includes("vless-a-example-com-443"));
ok("clash 含 trojan 节点", cl.includes("trojan-a-example-com-443"));
ok("clash 含 groups", cl.includes("proxy-groups:") && cl.includes("type: url-test") && cl.includes("type: select"));
eq("clash 节点数", (cl.match(/^    type: (vless|trojan)$/gm) || []).length, 8); // 2 节点 x 2 协议 x 2 模式

const sb = JSON.parse(W.renderSingbox(env, url, UUID, "a.example.com"));
eq("singbox outbounds 数", sb.outbounds.length, 12); // 2 urltest + 1 selector + 8 节点 + direct
eq("singbox 首个为 urltest", sb.outbounds[0].type, "urltest");

const ty = atob(W.renderLinks(env, url, UUID, "a.example.com"));
ok("分享串含 vless://", ty.includes("vless://" + UUID + "@a.example.com:443"));
ok("分享串含 trojan://", ty.includes("trojan://"));
eq("分享串 2 节点 x 2 协议 x 2 模式", (ty.match(/^(vless|trojan):\/\//gm) || []).length, 8);
{
  const tyD = decodeURIComponent(ty);
  ok("分享串含 mode=tput / mode=lat", tyD.includes("mode=tput") && tyD.includes("mode=lat"));
  ok("分享串节点名带 T/L 后缀", tyD.includes("-T") && tyD.includes("-L"));
}

const onlyVless = W.renderClash({ ...env }, new URL("https://x/?proto=vless"), UUID, "a.example.com");
eq("proto=vless 只出 vless", (onlyVless.match(/^    type: (vless|trojan)$/gm) || []).length, 4);

/* ---------- 6. 无 trojan 配置时不输出 trojan ---------- */
const nolTrojan = W.renderClash({ uuids: UUID, nodes: "a.com:443:tls" }, url, UUID, "a.com");
eq("无密码不出 trojan", nolTrojan.includes("type: trojan"), false);

/* ---------- 7. 新增：标签 / RTT 学习 / 排序 / 订阅头 ---------- */
eq("tagOf(ip)", W.tagOf("104.16.0.1"), "104-16-0-1");
eq("tagOf(domain)", W.tagOf("a.example.com"), "a-example-com");
eq("城市表命中", W.COLO_CITY["HKG"], "香港");

ok("path 带 ip 标签", cl.includes('path: "/?ed=2560&ip=a-example-com-443&mode=tput"'));

// 学习：让 c.example.com 变得更快，排序应该翻转
const cf1 = { asn: 4134, city: "Guangzhou", colo: "HKG", clientTcpRtt: 40, edgeL4: { deliveryRate: 9000 } };
for (let i = 0; i < 5; i++) W.rttLearn(cf1, "c-example-com-8880");
const learned = { "c-example-com-8880": { rtt: 40, colo: "HKG", hits: 5, ts: Date.now() } };
const ordered = W.orderNodes(W.loadNodes(env, "a.example.com"), learned);
eq("排序后第一个是学到的节点", ordered[0].host, "c.example.com");
eq("学到的节点带城市", W.nodeLabel(ordered[0]), "HKG-香港-c-example-com-8880");
eq("未学到的节点只显示标签", W.nodeLabel(ordered[1]), "a-example-com-443");

const cl2 = W.renderClash(env, url, UUID, "a.example.com", learned);
ok("排序生效于 clash 输出", cl2.indexOf("vless-HKG-香港-c-example-com-8880") < cl2.indexOf("vless-a-example-com-443"));
ok("rtt 注释写入", cl2.includes("# rtt ~40ms"));

// 无数据时保持原顺序
const ordered0 = W.orderNodes(W.loadNodes(env, "a.example.com"), {});
eq("无数据保持原顺序", ordered0[0].host, "a.example.com");

// 订阅头
const h = W.subHeaders({ quotaBytes: 107374182400, expireAt: "2027-01-01T00:00:00Z" }, { up: 111, down: 222 });
ok("Subscription-Userinfo 含总量", h["Subscription-Userinfo"].includes("total=107374182400"));
ok(
  "Subscription-Userinfo 含用量",
  h["Subscription-Userinfo"].includes("upload=111") && h["Subscription-Userinfo"].includes("download=222"),
);
ok("expire 被转成秒", /expire=1[78]\d{8}/.test(h["Subscription-Userinfo"]));

/* ---------- admin 入口链接 / 订阅复制 ---------- */
{
  const html = W.renderAdmin(
    new URL("https://edge.example.com/admin"),
    {
      list: [{ id: UUID, pwd: "pw123", note: "n", enabled: true, managed: true }],
    },
    {},
    "KEY42",
  );
  ok("admin 每行有控制页跳转", html.includes(`https://edge.example.com/${UUID}?k=KEY42`), "");
  ok("admin 每行有 cl 订阅复制", html.includes(`https://edge.example.com/${UUID}/cl?k=KEY42`), "");
  ok("admin 每行有 sb 订阅复制", html.includes(`https://edge.example.com/${UUID}/sb?k=KEY42`), "");
  ok("admin 有复制脚本", html.includes("navigator.clipboard") && html.includes("data-copy"), "");
  const htmlK = W.renderAdmin(
    new URL("https://edge.example.com/admin?k=KEY42"),
    {
      list: [{ id: UUID, pwd: "pw123", note: "n", enabled: true, managed: true }],
    },
    {},
    "",
  );
  ok("?k= 打开时表单也带 k", htmlK.includes('action="/admin/op?k=KEY42"'), "");
}

/* ---------- 管理会话：过期令牌不再永久有效 ---------- */
{
  const env2 = { adminKey: "0123456789abcdef" };
  const tok = await W.sessionToken(env2);
  const withTok = (t) => new Request("https://edge.example.com/admin", { headers: { cookie: `adm=${t}` } });
  const u2 = new URL("https://edge.example.com/admin");
  eq("有效会话令牌放行", await W.adminAuthed(withTok(tok), u2, env2), true);
  const oldTok = await W.sessionToken(env2, Date.now() - 1000);
  eq("过期令牌拒绝", await W.adminAuthed(withTok(oldTok), u2, env2), false);
  eq("换 adminKey 后旧令牌失效", await W.adminAuthed(withTok(tok), u2, { adminKey: "fedcba9876543210" }), false);
  eq(
    "?k= 直连仍然可用",
    await W.adminAuthed(
      new Request("https://edge.example.com/admin?k=0123456789abcdef"),
      new URL("https://edge.example.com/admin?k=0123456789abcdef"),
      env2,
    ),
    true,
  );
}

/* ---------- 主 UUID / 跨 isolate 归属 ---------- */
eq("主 UUID 取列表第一个（小写）", W.primaryId({ uuid: "AAA-BBB,CCC-DDD" }), "aaa-bbb");
eq("没有 uuid 时回落 uuids", W.primaryId({ uuids: "EEE-FFF" }), "eee-fff");
eq("都没有返回空串", W.primaryId({}), "");

/* ---------- 面板托管用户的 Trojan 密码 ---------- */
{
  const authM = {
    uuids: new Set([UUID]),
    trojan: new Map(),
    list: [{ id: UUID, pwd: "ManagedPwd123", enabled: true, managed: true, note: "" }],
  };
  const envM = { nodes: "a.example.com:443:tls" };
  eq("托管用户密码优先于 env 公共密码", W.trojanPasswordOf(envM, UUID, authM), "ManagedPwd123");
  const clM = W.renderClash(envM, new URL("https://x/" + UUID), UUID, "a.example.com", {}, [], authM);
  ok("托管用户订阅会出 Trojan", clM.includes("type: trojan"));
  ok("托管用户订阅用生成的密码", clM.includes('password: "ManagedPwd123"'));
  const authEmpty = {
    uuids: new Set([UUID]),
    trojan: new Map(),
    list: [{ id: UUID, pwd: "", enabled: true, managed: true, note: "" }],
  };
  eq("托管用户没密码时不出 Trojan", W.trojanPasswordOf(envM, UUID, authEmpty), "");
}

/* ---------- 用户表：托管启用状态 / 密码覆盖 ---------- */
{
  const kv = (users) => ({ get: async (k) => (k === "users" ? JSON.stringify(users) : null) });
  W.S.usersCache = { v: null, t: 0 };
  W.S.usersSig = "";
  const envD = { uuid: UUID, STATS: kv([{ id: UUID, pwd: "pw-managed", enabled: false, managed: true }]) };
  const aD = await W.loadUsers(envD);
  eq("托管禁用覆盖 env 启用状态", aD.uuids.has(UUID), false);
  eq("禁用用户不注册 Trojan", aD.trojan.size, 0);

  W.S.usersCache = { v: null, t: 0 };
  W.S.usersSig = "";
  const envE = {
    uuid: UUID,
    pwd: "pw-env",
    STATS: kv([{ id: UUID, pwd: "pw-managed", enabled: true, managed: true }]),
  };
  const aE = await W.loadUsers(envE);
  eq("托管启用后恢复 UUID", aE.uuids.has(UUID), true);
  eq("托管密码覆盖 env 密码只留一个", aE.trojan.size, 1);

  // 单密码模式下多个 env 用户共享哈希：归属要稳定，禁用一人不能误删另一人
  const U2 = "df1af8dd-3efe-407b-a5b6-4950afa4ac6f";
  W.S.usersCache = { v: null, t: 0 };
  W.S.usersSig = "";
  const shared = { uuids: UUID + "," + U2, pwd: "same-pwd", STATS: kv([]) };
  const aS = await W.loadUsers(shared);
  eq("共享密码只注册一个哈希", aS.trojan.size, 1);
  eq("共享密码归属第一个用户", [...aS.trojan.values()][0], UUID);

  W.S.usersCache = { v: null, t: 0 };
  W.S.usersSig = "";
  const sharedOff = { uuids: UUID + "," + U2, pwd: "same-pwd", STATS: kv([{ id: U2, enabled: false, managed: true }]) };
  const aOff = await W.loadUsers(sharedOff);
  eq("禁用共享用户之一不撤掉另一人", [...aOff.trojan.values()][0], UUID);
  eq("另一个用户仍在 uuids", aOff.uuids.has(UUID), true);
}

/* ---------- KV 读失败时沿用旧用户表，不能把托管用户全踢下线 ---------- */
{
  const fake = {
    uuids: new Set([UUID]),
    trojan: new Map(),
    list: [{ id: UUID, pwd: "pw", enabled: true, managed: true, note: "" }],
  };
  W.S.usersCache = { v: fake, t: Date.now() - 400000 };
  W.S.usersSig = UUID + "|pw";
  const envFailUsers = {
    uuid: UUID,
    pwd: "pw",
    STATS: {
      get: async () => {
        throw new Error("kv down");
      },
    },
  };
  const a = await W.loadUsers(envFailUsers);
  ok("KV 读失败沿用旧用户表", a.uuids.has(UUID));
  W.S.usersCache = { v: null, t: 0 };
  W.S.usersSig = "";
}

/* ---------- cron 并发闸：重投递 / 手动 refresh 撞车不双跑 ---------- */
{
  // cronScan 会去抓上游候选池：stub 掉 fetch，返回空文本让它提前退出
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 200 });
  try {
    W.S.cronBusy = false;
    let done = null;
    const ctx1 = {
      waitUntil: (p) => {
        done = p;
      },
    };
    const envCron = { STATS: { get: async () => null, put: async () => {} }, pxSchedH: "0" };
    await W.runCron(envCron, ctx1);
    await done; // 等 waitUntil 的任务真正跑完，闸门必须回到 false
    eq("runCron 结束后闸门释放", W.S.cronBusy, false);

    W.S.cronBusy = true;
    let skipped = null;
    await W.runCron(envCron, {
      waitUntil: (p) => {
        skipped = p;
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    eq("cron 忙时不重复跑（闸门保持）", W.S.cronBusy, true);
    eq("cron 忙时不排新任务", skipped, null);
  } finally {
    globalThis.fetch = realFetch;
    W.S.cronBusy = false;
  }
}

/* ---------- flushPx(force) 必须真的跳过 20 分钟节流 ---------- */
{
  const now = Date.now();
  const seedDoc = {
    v: 6,
    ts: now,
    poolGen: 1,
    poolN: 1,
    builtAt: now,
    byColo: { "*": { ts: now, nodes: [{ k: "seed-node:443", h: "seed-node", p: 443, ms: 50 }] } },
    cnt: null,
  };
  W.S.seed = seedDoc;
  W.S.seedAt = now;
  W.S.seedDirty = true;
  let puts = 0;
  const envSeed = {
    STATS: {
      get: async () => JSON.stringify(seedDoc),
      put: async () => {
        puts++;
      },
    },
  };
  await W.flushPx(envSeed, false);
  eq("非 force 在 20 分钟节流内跳过", puts, 0);
  W.S.seedDirty = true;
  await W.flushPx(envSeed, true);
  ok("force 必须写进 KV", puts > 0);
}

/* ---------- 地区节点沿用请求端口（8443 部署不能写死 443） ---------- */
{
  const u843 = new URL(`https://edge.example.com:8443/${UUID}`);
  const y = W.renderClash({ ...env, regions: "HK" }, u843, UUID, "edge.example.com", {}, ["HK"]);
  ok(
    "Clash 地区节点用 8443",
    y.includes("port: 8443"),
    y
      .split("\n")
      .filter((l) => l.includes("port:"))
      .join(" | "),
  );
  const links = Buffer.from(
    W.renderLinks({ ...env, regions: "HK" }, u843, UUID, "edge.example.com", {}, ["HK"]),
    "base64",
  ).toString("utf8");
  ok(
    "明文订阅地区节点用 8443",
    links.includes("edge.example.com:8443"),
    links
      .split("\n")
      .filter((l) => l.includes("region"))
      .join(" | "),
  );
}

/* ---------- 老 RTT 条目缺 hits/rtt 时不能变 NaN ---------- */
{
  W.S.rtt.clear();
  W.rttLearn({ clientTcpRtt: 100, colo: "HKG" }, "tag", "rtt-u");
  const b = W.S.rtt.get("rtt-u").tag;
  eq("RTT 首次写入", [b.rtt, b.hits], [100, 1]);
  // 模拟早期版本写下的条目：没有 hits，rtt 也是 0
  W.S.rtt.get("rtt-u").tag = { rtt: 0, colo: "", bw: 0, ok: 0, fail: 0, ts: 0 };
  W.rttLearn({ clientTcpRtt: 200, colo: "HKG" }, "tag", "rtt-u");
  const c = W.S.rtt.get("rtt-u").tag;
  ok("老条目补 hits", c.hits === 1, String(c.hits));
  ok("老条目 rtt 不变 NaN", Number.isFinite(c.rtt) && c.rtt > 0, String(c.rtt));
  W.S.rtt.clear();
}

/* ---------- UDP/53 分帧：Trojan 带地址前缀，VLESS 带 ver 头 ---------- */
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]));
  const sent = [];
  const ws = {
    readyState: 1,
    send: (d) => sent.push([...d]),
    close() {},
    addEventListener() {},
    removeEventListener() {},
  };
  try {
    // Trojan: [ATYP=1][8.8.8.8][port=53][len=4][4 字节 DNS]
    const stT = { down: 0, header: null };
    const dns12 = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
    await W.handleDns(ws, new Uint8Array([1, 8, 8, 8, 8, 0, 53, 0, 12, ...dns12]), stT, true);
    eq("Trojan UDP 响应保留地址前缀", sent[0], [1, 8, 8, 8, 8, 0, 53, 0, 4, 1, 2, 3, 4]);
    eq("Trojan UDP 下行计数", stT.down, 4);

    // VLESS: [len=4][4 字节 DNS]，响应前要带一次 [ver,0]
    const stV = { down: 0, header: new Uint8Array([0, 0]) };
    await W.handleDns(ws, new Uint8Array([0, 12, ...dns12]), stV, false);
    eq("VLESS UDP 响应带 ver 头", sent[1], [0, 0, 0, 4, 1, 2, 3, 4]);
    eq("VLESS 头只发一次", stV.header, null);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---------- 随机密码：长度 / 字符集 / 默认值 ---------- */
{
  const A = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const p = W.randomPwd(64);
  eq("randomPwd 长度", p.length, 64);
  ok(
    "randomPwd 只用无歧义字符",
    [...p].every((c) => A.includes(c)),
    p,
  );
  eq("randomPwd 默认 16 位", W.randomPwd(0).length, 16);
  eq("randomPwd 负数回落到 16 位", W.randomPwd(-5).length, 16);
  const many = W.randomPwd(2000);
  ok("randomPwd 覆盖大小写与数字", /[a-z]/.test(many) && /[A-Z]/.test(many) && /[2-9]/.test(many));
}

/* ---------- IPv4 / NAT64 边界 ---------- */
eq("IPv4 字面量识别", W.isV4Literal("1.2.3.4"), true);
eq("IPv4 拒绝越界段", W.isV4Literal("1.2.3.999"), false);
eq("IPv4 拒绝前导零", W.isV4Literal("01.2.3.4"), false);
eq("NAT64 编码", W.nat64FromV4("1.2.3.4"), "[2001:67c:2960:6464::0102:0304]");
{
  let threw = false;
  try {
    W.nat64FromV4("1.2.3.999");
  } catch (e) {
    threw = true;
  }
  eq("NAT64 拒绝越界 IPv4", threw, true);
}

/* ---------- 统一 HTML 响应头 ---------- */
{
  const r = W.html("<b>x</b>", 200, { "content-security-policy": W.CSP_STATIC });
  eq("html content-type", r.headers.get("content-type"), "text/html;charset=utf-8");
  eq("html no-store", r.headers.get("cache-control"), "no-store");
  eq("html frame-options", r.headers.get("x-frame-options"), "DENY");
  eq("静态页 CSP 不含 script-src", r.headers.get("content-security-policy"), W.CSP_STATIC);
  ok("静态页 CSP 不给脚本", !String(W.CSP_STATIC).includes("script-src"));
}

/* ---------- Clash YAML 转义：密码里的引号/反斜杠不能拆坏配置 ---------- */
{
  const envY = { ...env, pwd: 'a"b\\c', nodes: 'bad"host:443:tls#x' };
  const y = W.renderClash(envY, new URL("https://x/" + UUID), UUID, "a.example.com", {}, []);
  ok(
    "Clash 密码转义引号",
    y.includes('password: "a\\"b\\\\c"'),
    y.split("\n").find((l) => l.includes("password")),
  );
  ok(
    "Clash 主机名按需加引号",
    y.includes('server: "bad\\"host"'),
    y.split("\n").find((l) => l.includes("server")),
  );
  ok("Clash 名字仍然带引号", y.includes('name: "vless-bad-host-443-T"'));

  const envN = { ...env, pwd: 'a"b\nc', nodes: "n.example.com:443:tls" };
  const yn = W.renderClash(envN, new URL("https://x/" + UUID), UUID, "a.example.com", {}, []);
  ok(
    "Clash 密码里的换行被转义",
    yn.includes('password: "a\\"b\\nc"'),
    yn.split("\n").find((l) => l.includes("password")),
  );
}

/* ---------- 上行队列：8MB 上限，读走才释放额度 ---------- */
{
  const handlers = {};
  let closed = null;
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send() {},
    close(code, reason) {
      closed = [code, reason];
    },
    addEventListener(t, f) {
      (handlers[t] = handlers[t] || []).push(f);
    },
    removeEventListener() {},
  };
  const emit = (t, data) => {
    for (const f of handlers[t] || []) f({ data });
  };
  const reader = W.wsToStream(ws, "").getReader();
  const MB = 1024 * 1024;

  // 正常读：3MB 进、3MB 出，额度应释放
  for (let i = 0; i < 3; i++) emit("message", new Uint8Array(MB));
  let got = 0;
  for (let i = 0; i < 3; i++) {
    const r = await reader.read();
    got += r.value.length;
  }
  eq("上行流正常读出 3MB", got, 3 * MB);

  // 不读，继续灌 12MB：超过 8MB 上限必须断开
  for (let i = 0; i < 12; i++) emit("message", new Uint8Array(MB));
  eq("上行队列溢出关闭 1013", closed && closed[0], 1013);
  let rejected = false;
  try {
    await reader.read();
  } catch (e) {
    rejected = true;
  }
  eq("溢出后流失效", rejected, true);
}

/* ---------- 直连统计按站点族合并 ---------- */
{
  W.S.hostDirect.clear();
  W.hostDirectMark("api.x.com", true);
  W.hostDirectMark("x.com", false);
  const d = W.S.hostDirect.get("x.com");
  eq("直连统计按站点族合并", [d.ok, d.bad], [1, 1]);
  W.S.hostDirect.clear();
}

/* ---------- 节点明细上限：默认 64，可按需放开 ---------- */
{
  const keys = [];
  for (let i = 0; i < 70; i++) keys.push(`n${i}:443`);
  for (const k of keys) W.nsGet(k);
  eq("nsOf 默认最多 64 条", Object.keys(W.nsOf(keys)).length, 64);
  eq("nsOf 可放开到全部", Object.keys(W.nsOf(keys, 70)).length, 70);
  for (const k of keys) W.S.nstat.delete(k);
}

/* ---------- nsOk 必须推进 at（否则衰减基准永远停在旧时刻） ---------- */
{
  const s = W.nsGet("at-check:443");
  s.at = Date.now() - 1000;
  W.nsOk("at-check:443", 50, 20);
  ok("nsOk 更新 at", Date.now() - s.at < 500, String(Date.now() - s.at));
  W.S.nstat.delete("at-check:443");
}

/* ---------- withTimeout：正常值 / 超时 ---------- */
{
  eq("withTimeout 正常返回", await W.withTimeout(Promise.resolve(7), 100), 7);
  let to = false;
  try {
    await W.withTimeout(new Promise(() => {}), 20);
  } catch (e) {
    to = true;
  }
  eq("withTimeout 超时", to, true);
}

/* ---------- refillPool：去重 + 各源统计 ---------- */
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("1.1.1.1:443#US\n2.2.2.2:8443\n1.1.1.1:443\n", { status: 200 });
  try {
    const rr = await W.refillPool({});
    eq("refillPool 去重后 2 条 + 内置 1 条", rr.pool.length, 3);
    eq("refillPool 记录全部来源", Object.keys(rr.sources).length, 6);
    eq("refillPool 首个来源新增 2 条", rr.sources[Object.keys(rr.sources)[0]].ok, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---------- 内网/保留地址：IPv6 必须按数值判断 ---------- */
{
  const priv = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0:0:0:0:0:0:0:1",
    "::1",
    "::",
    "::7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:127.0.0.1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "64:ff9b::7f00:1",
    "2001:67c:2960:6464::0102:0304",
    "localhost.",
    "foo.local",
    "0177.0.0.1",
    "0x7f000001",
    "2130706433",
    "1.2.3.999",
  ];
  for (const h of priv) ok(`私网拦截 ${h}`, W.isPrivateHost(h), h);
  const pub = ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888", "example.com", "::ffff:8.8.8.8"];
  for (const h of pub) ok(`公网放行 ${h}`, !W.isPrivateHost(h), h);
}

/* ---------- 地区列表：去重后再截断 ---------- */
{
  eq("regions 去重且最多 6 个", await W.regionListAsync({ regions: "HK,HK,JP,US,SG,DE,NL" }), [
    "HK",
    "JP",
    "US",
    "SG",
    "DE",
    "NL",
  ]);
  eq("regions 忽略非法值", await W.regionListAsync({ regions: "hk, jp ,X,US" }), ["HK", "JP", "US"]);
}

/* ---------- 全局候选名单：新探到的节点不能永远排在第 41 位 ---------- */
{
  W.S.alive.clear();
  W.S.nstat.clear();
  W.S.seed = {
    v: 6,
    ts: 0,
    poolGen: 0,
    poolN: 0,
    builtAt: 0,
    byColo: { "*": { ts: 1, nodes: [] } },
    cnt: null,
  };
  W.S.seedAt = 0;
  for (let i = 0; i < 40; i++) {
    W.S.seed.byColo["*"].nodes.push({ k: `old${i}:443`, h: `old${i}`, p: 443, cc: "", ms: 100 });
  }
  for (let i = 0; i < 5; i++) {
    W.S.alive.set(`new${i}:443`, { h: `new${i}`, p: 443, cc: "", ms: 50 + i });
  }
  let saved = null;
  const envSeed = {
    STATS: {
      get: async () => null,
      put: async (k, v) => {
        saved = v;
      },
    },
  };
  await W.SEEDS.write(envSeed, true, true);
  const doc = JSON.parse(saved);
  const names = doc.byColo["*"].nodes.map((n) => n.k);
  eq("名单仍截断在 40 条", names.length, 40);
  ok(
    "新探到的节点进入全局名单",
    names.some((k) => k.startsWith("new")),
  );
}

/* ---------- 落盘前读失败：不能拿空表覆盖旧快照 ---------- */
{
  W.S.seedAt = 0;
  W.S.seedReadFail = false;
  let puts = 0;
  const envDown = {
    STATS: {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        puts++;
      },
    },
  };
  const rw = await W.SEEDS.write(envDown, true, true);
  eq("seed 读失败时拒绝落盘", rw.ok, false);
  eq("seed 读失败时一次都没写", puts, 0);

  // 有原始值但解不出来（损坏 / KEK 变了）也必须按读失败处理
  W.S.seedAt = 0;
  W.S.seedReadFail = false;
  puts = 0;
  const envBad = { STATS: { get: async () => "not-json", put: async () => puts++ } };
  const rb = await W.SEEDS.write(envBad, true, true);
  eq("seed 值损坏时拒绝落盘", rb.ok, false);
  eq("seed 值损坏时一次都没写", puts, 0);

  W.S.snapChecked = 0;
  W.S.snapBusy = false;
  W.S.stats.set("flush-u", { up: 1, down: 2, conns: 1, first: Date.now(), last: Date.now() });
  await W.flushSnap(envDown, true);
  eq("snap 读失败时不覆盖旧快照", puts, 0);
  W.S.stats.delete("flush-u");

  const envDown2 = {
    STATS: envDown.STATS,
    METER: { idFromName: (x) => x, get: () => ({ fetch: async () => Response.json({}) }) },
  };
  await W.usageSnapWrite(envDown2, [{ id: "snap-u1" }]);
  eq("usage 快照读失败时不写", puts, 0);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
