import * as W from "./_bundle.mjs";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n  got : ${a}\n  want: ${b}`); }
};
const ok = (name, cond, info = "") => eq(name, !!cond, true) || (!cond && console.log("  info:", info));

/* ---------- 1. SHA-224 官方向量 ---------- */
eq("sha224('')", W.toHex(W.sha224Bytes(new TextEncoder().encode(""))),
   "d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f");
eq("sha224('abc')", W.toHex(W.sha224Bytes(new TextEncoder().encode("abc"))),
   "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7");
eq("sha224('test123')", W.toHex(W.sha224Bytes(new TextEncoder().encode("test123"))),
   "4f555b1bb8bc729a665b8892df73119e2ef2eb50dffaf0d5c546cf23");
eq("sha224('Passw0rd!')", W.toHex(W.sha224Bytes(new TextEncoder().encode("Passw0rd!"))),
   "72f6c09f12fe97e7ab06d44fa4abc999904811729a7af49f040ee454");

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
  b[o++] = 0;                       // ver
  b.set(uuidToBytes(uuid), o); o += 16;
  b[o++] = 0;                       // optLen
  b[o++] = cmd;
  b[o++] = (port >> 8) & 0xff; b[o++] = port & 0xff;
  b[o++] = atyp;
  b[o++] = d.length; b.set(d, o); o += d.length;
  b[o++] = 0x41; b[o++] = 0x42;     // payload
  return b.slice(0, o);
}

function trojanBuf(pwd, host = "example.com", port = 80, cmd = 1, atyp = 3) {
  const hash = enc.encode(W.toHex(W.sha224Bytes(enc.encode(pwd))));
  const d = enc.encode(host);
  const b = new Uint8Array(56 + 2 + 1 + 1 + 1 + d.length + 2 + 2 + 4);
  let o = 0;
  b.set(hash, o); o += 56;
  b[o++] = 0x0d; b[o++] = 0x0a;
  b[o++] = cmd;
  b[o++] = atyp;
  b[o++] = d.length; b.set(d, o); o += d.length;
  b[o++] = (port >> 8) & 0xff; b[o++] = port & 0xff;
  b[o++] = 0x0d; b[o++] = 0x0a;
  b[o++] = 0x41; b[o++] = 0x42;
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
  b[o++] = 0; b.set(uuidToBytes(uuid), o); o += 16;
  b[o++] = 0; b[o++] = 1;
  b[o++] = 0x01; b[o++] = 0xbb; b[o++] = 3;
  b.set(V6, o); o += 16;
  b[o++] = 0x41;
  return b.slice(0, o);
}
function trojanBufV6(pwd) {
  const hash = enc.encode(W.toHex(W.sha224Bytes(enc.encode(pwd))));
  const b = new Uint8Array(56 + 2 + 1 + 1 + 16 + 2 + 2 + 4);
  let o = 0;
  b.set(hash, o); o += 56;
  b[o++] = 0x0d; b[o++] = 0x0a; b[o++] = 1; b[o++] = 4;
  b.set(V6, o); o += 16;
  b[o++] = 0x01; b[o++] = 0xbb;
  b[o++] = 0x0d; b[o++] = 0x0a; b[o++] = 0x41;
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
eq("clash 节点数", (cl.match(/^    type: (vless|trojan)$/gm) || []).length, 8);  // 2 节点 x 2 协议 x 2 模式

const sb = JSON.parse(W.renderSingbox(env, url, UUID, "a.example.com"));
eq("singbox outbounds 数", sb.outbounds.length, 12); // 2 urltest + 1 selector + 8 节点 + direct
eq("singbox 首个为 urltest", sb.outbounds[0].type, "urltest");

const ty = atob(W.renderLinks(env, url, UUID, "a.example.com"));
ok("分享串含 vless://", ty.includes("vless://" + UUID + "@a.example.com:443"));
ok("分享串含 trojan://", ty.includes("trojan://"));

const onlyVless = W.renderClash({ ...env }, new URL("https://x/?proto=vless"), UUID, "a.example.com");
eq("proto=vless 只出 vless", (onlyVless.match(/^    type: (vless|trojan)$/gm) || []).length, 4);

/* ---------- 6. 无 trojan 配置时不输出 trojan ---------- */
const nolTrojan = W.renderClash({ uuids: UUID, nodes: "a.com:443:tls" }, url, UUID, "a.com");
eq("无密码不出 trojan", nolTrojan.includes("type: trojan"), false);


/* ---------- 7. 新增：标签 / RTT 学习 / 排序 / 订阅头 ---------- */
eq("tagOf(ip)", W.tagOf("104.16.0.1"), "104-16-0-1");
eq("tagOf(domain)", W.tagOf("a.example.com"), "a-example-com");
eq("城市表命中", W.COLO_CITY["HKG"], "香港");

ok("path 带 ip 标签", cl.includes("path: \"/?ed=2560&ip=a-example-com-443&mode=tput\""));

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
ok("Subscription-Userinfo 含用量", h["Subscription-Userinfo"].includes("upload=111") && h["Subscription-Userinfo"].includes("download=222"));
ok("expire 被转成秒", /expire=1[78]\d{8}/.test(h["Subscription-Userinfo"]));

/* ---------- admin 入口链接 / 订阅复制 ---------- */
{
  const html = W.renderAdmin(new URL("https://edge.example.com/admin"), {
    list: [{ id: UUID, pwd: "pw123", note: "n", enabled: true, managed: true }],
  }, {}, "KEY42");
  ok("admin 每行有控制页跳转", html.includes(`https://edge.example.com/${UUID}?k=KEY42`), "");
  ok("admin 每行有 cl 订阅复制", html.includes(`https://edge.example.com/${UUID}/cl?k=KEY42`), "");
  ok("admin 每行有 sb 订阅复制", html.includes(`https://edge.example.com/${UUID}/sb?k=KEY42`), "");
  ok("admin 有复制脚本", html.includes("navigator.clipboard") && html.includes('data-copy'), "");
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
