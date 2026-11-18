// 数据面模拟：假 WebSocket / 假 socket / 假 Response，把 handleUpgrade 真正跑起来
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const RealResponse = globalThis.Response;
function SimResponse(body, init) {
  if (init && init.status === 101) return { status: 101, webSocket: init.webSocket, headers: {} };
  return new RealResponse(body, init);
}
SimResponse.json = RealResponse.json.bind(RealResponse);
globalThis.Response = SimResponse;

class FakeWS {
  constructor() {
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    this.listeners = {};
    this.closeInfo = null;
  }
  accept() {}
  send(d) {
    // WebSocketPair 的 server 端 send 会送到 client；这里用 peer 模拟
    if (this.peer) this.peer.sent.push(d);
    else this.sent.push(d);
  }
  close(code, reason) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closeInfo = { code, reason };
    const ev = { code, reason };
    for (const f of this.listeners.close || []) f(ev);
    if (this.peer && this.peer.readyState === 1) this.peer.close(code, reason);
  }
  addEventListener(t, f) {
    (this.listeners[t] = this.listeners[t] || []).push(f);
  }
  removeEventListener() {}
  emit(t, ev) {
    for (const f of this.listeners[t] || []) f(ev);
  }
}
class FakePair {
  constructor() {
    const c = new FakeWS();
    const s = new FakeWS();
    c.peer = s;
    s.peer = c;
    this[0] = c;
    this[1] = s;
  }
}
globalThis.WebSocketPair = FakePair;

const created = [];
function makeSocket(key) {
  let ctrl;
  const readable = new ReadableStream({
    start(c) {
      ctrl = c;
    },
  });
  const received = [];
  const writable = new WritableStream({
    write(chunk) {
      received.push(new Uint8Array(chunk));
    },
  });
  return {
    key,
    readable,
    writable,
    received,
    closed: false,
    push(u8) {
      ctrl.enqueue(u8);
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      try {
        ctrl.close();
      } catch (e) {}
    },
  };
}
globalThis.__simConnect = async (o) => {
  const s = makeSocket(o.hostname + ":" + o.port);
  created.push(s);
  return s;
};

const W = await import("./_bundle.mjs");

let pass = 0,
  fail = 0;
const eq = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log(`FAIL ${n}\n  got : ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`);
  }
};
const ok = (n, c, info = "") => {
  if (c) pass++;
  else {
    fail++;
    console.log(`FAIL ${n} ${info}`);
  }
};
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const UUID = "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1";
const PWD = "test123";
const enc = new TextEncoder();

function uuidToBytes(u) {
  const h = u.replace(/-/g, "");
  const a = new Uint8Array(16);
  for (let i = 0; i < 16; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}
function vless(uuid, host = "example.com", port = 80, cmd = 1, payload = [0x41, 0x42]) {
  const d = enc.encode(host);
  const b = new Uint8Array(1 + 16 + 1 + 1 + 2 + 1 + 1 + d.length + payload.length);
  let o = 0;
  b[o++] = 0;
  b.set(uuidToBytes(uuid), o);
  o += 16;
  b[o++] = 0;
  b[o++] = cmd;
  b[o++] = (port >> 8) & 0xff;
  b[o++] = port & 0xff;
  b[o++] = 2;
  b[o++] = d.length;
  b.set(d, o);
  o += d.length;
  b.set(payload, o);
  return b;
}
const req = (path = "/") => ({
  url: "https://a.example.com" + path,
  headers: { get: () => null },
  cf: { colo: "HKG", clientTcpRtt: 42 },
});
const ctx = { waitUntil: () => {} };
const env = () => ({ uuids: UUID, pwd: PWD, proxyip: "" });

function reset() {
  W.S.pend.clear();
  W.S.stats.clear();
  W.S.inflight.clear();
  W.PEND.flushTimer && clearTimeout(W.PEND.flushTimer);
  W.PEND.flushTimer = null;
  created.length = 0;
}

/* ---------- 1. VLESS TCP 直连：首包 → 上游 → 回程 ---------- */
reset();
{
  const resp = await W.handleUpgrade(req(), env(), ctx);
  const client = resp.webSocket;
  const server = client.peer;
  eq("升级返回 101", resp.status, 101);
  server.emit("message", { data: vless(UUID) });
  await tick();
  ok("首包拨到目标", created.some((s) => s.key === "example.com:80"), created.map((s) => s.key).join(","));
  const target = created.find((s) => s.key === "example.com:80");
  eq("首包 payload 已写入上游", target.received.map((u) => [...u]), [[0x41, 0x42]]);
  target.push(new Uint8Array([9, 9]));
  await tick();
  eq("回程带 VLESS 响应头", client.sent.map((u) => [...u]), [[0, 0, 9, 9]]);
  target.close();
  await tick();
  eq("有数据后服务端正常关闭", client.closeInfo && client.closeInfo.code, 1000);
}

/* ---------- 2. 直连 0 字节关闭 → 手动 proxyip 重试 ---------- */
reset();
{
  const e = { ...env(), proxyip: "9.9.9.9:443" };
  const resp = await W.handleUpgrade(req(), e, ctx);
  const client = resp.webSocket;
  const server = client.peer;
  server.emit("message", { data: vless(UUID, "blocked.example.com") });
  await tick();
  const first = created.find((s) => s.key === "blocked.example.com:80");
  ok("直连先建立", !!first);
  first.close(); // 0 字节关闭
  await tick(30);
  const px = created.find((s) => s.key === "9.9.9.9:443");
  ok("直连空关闭后切到 proxyip", !!px, created.map((s) => s.key).join(","));
  if (px) {
    px.push(new Uint8Array([7, 7]));
    await tick();
    eq("proxyip 回程带响应头", client.sent.map((u) => [...u]), [[0, 0, 7, 7]]);
    px.close();
    await tick();
  }
}

/* ---------- 3. 地区硬要求：只拨 DE 节点 ---------- */
reset();
{
  W.S.alive.clear();
  W.S.alive.set("de.example.com:443", { h: "de.example.com", p: 443, cc: "DE", ms: 50 });
  const e = { ...env(), proxyip: "auto" };
  const resp = await W.handleUpgrade(req("/?rg=DE"), e, ctx);
  const client = resp.webSocket;
  client.peer.emit("message", { data: vless(UUID, "target.example.com") });
  await tick();
  ok("地区请求拨到 DE 节点", created.some((s) => s.key === "de.example.com:443"), created.map((s) => s.key).join(","));
  ok("地区请求不走直连", !created.some((s) => s.key === "target.example.com:80"), created.map((s) => s.key).join(","));
  const de = created.find((s) => s.key === "de.example.com:443");
  if (de) {
    de.push(new Uint8Array([5, 5]));
    await tick();
    eq("地区节点回程", client.sent.map((u) => [...u]), [[0, 0, 5, 5]]);
    de.close();
    await tick();
  }
}

/* ---------- 4. 地区无节点：直接 1011，不回直连 ---------- */
reset();
{
  W.S.alive.clear();
  const e = { ...env(), proxyip: "auto" };
  const resp = await W.handleUpgrade(req("/?rg=JP"), e, ctx);
  const client = resp.webSocket;
  client.peer.emit("message", { data: vless(UUID, "target.example.com") });
  await tick();
  eq("无地区节点直接关闭 1011", client.closeInfo && client.closeInfo.code, 1011);
  eq("无地区节点不发起任何连接", created.length, 0);
}

/* ---------- 5. VLESS UDP/53：DNS 查询 → DoH 响应 ---------- */
reset();
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new RealResponse(new Uint8Array([1, 2, 3, 4]));
  try {
    const resp = await W.handleUpgrade(req(), env(), ctx);
    const client = resp.webSocket;
    const dns12 = new Uint8Array(12).fill(9);
    const payload = new Uint8Array(2 + 12);
    payload[0] = 0;
    payload[1] = 12;
    payload.set(dns12, 2);
    client.peer.emit("message", { data: vless(UUID, "dns.example.com", 53, 2, [...payload]) });
    await tick(30);
    eq("UDP DNS 回程", client.sent.map((u) => [...u]), [[0, 0, 0, 4, 1, 2, 3, 4]]);
    eq("UDP DNS 不拨 TCP", created.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---------- 6. 地区首选连不上 → 同国备选 + 坏节点冷却 ---------- */
reset();
{
  W.S.alive.clear();
  W.S.nstat.clear();
  W.S.alive.set("de1.example.com:443", { h: "de1.example.com", p: 443, cc: "DE", ms: 30 });
  W.S.alive.set("de2.example.com:443", { h: "de2.example.com", p: 443, cc: "DE", ms: 90 });
  const hook = globalThis.__simConnect;
  const failKeys = new Set(["de1.example.com:443"]);
  globalThis.__simConnect = async (o) => {
    const key = o.hostname + ":" + o.port;
    if (failKeys.has(key)) throw new Error("dial fail");
    const s = makeSocket(key);
    created.push(s);
    return s;
  };
  try {
    const resp = await W.handleUpgrade(req("/?rg=DE"), { ...env(), proxyip: "auto" }, ctx);
    const client = resp.webSocket;
    client.peer.emit("message", { data: vless(UUID, "target.example.com") });
    await tick(30);
    ok("首选失败后换同国备选", created.some((s) => s.key === "de2.example.com:443"), created.map((s) => s.key).join(","));
    ok("首选节点进入冷却", (W.S.nstat.get("de1.example.com:443") || {}).blackUntil > Date.now());
    const de2 = created.find((s) => s.key === "de2.example.com:443");
    if (de2) {
      de2.push(new Uint8Array([6, 6]));
      await tick();
      eq("备选回程", client.sent.map((u) => [...u]), [[0, 0, 6, 6]]);
      de2.close();
      await tick();
    }
  } finally {
    globalThis.__simConnect = hook;
  }
}

/* ---------- 7. Trojan TCP ---------- */
reset();
{
  const hash = W.toHex(W.sha224Bytes(enc.encode(PWD)));
  const host = enc.encode("trojan.example.com");
  const b = new Uint8Array(56 + 2 + 1 + 1 + 1 + host.length + 2 + 2 + 2);
  let o = 0;
  b.set(enc.encode(hash), o);
  o += 56;
  b[o++] = 0x0d;
  b[o++] = 0x0a;
  b[o++] = 1;
  b[o++] = 3;
  b[o++] = host.length;
  b.set(host, o);
  o += host.length;
  b[o++] = 0x00;
  b[o++] = 80;
  b[o++] = 0x0d;
  b[o++] = 0x0a;
  b[o++] = 0x51;
  b[o++] = 0x52;
  const resp = await W.handleUpgrade(req(), env(), ctx);
  const client = resp.webSocket;
  client.peer.emit("message", { data: b.slice(0, o) });
  await tick();
  ok("Trojan 拨到目标", created.some((s) => s.key === "trojan.example.com:80"), created.map((s) => s.key).join(","));
  const t = created.find((s) => s.key === "trojan.example.com:80");
  if (t) {
    eq("Trojan payload", t.received.map((u) => [...u]), [[0x51, 0x52]]);
    t.push(new Uint8Array([3, 3]));
    await tick();
    eq("Trojan 回程无 VLESS 头", client.sent.map((u) => [...u]), [[3, 3]]);
  }
}

/* ---------- 8. Trojan UDP/53：地址前缀 + DNS 响应 ---------- */
reset();
{
  const hash = W.toHex(W.sha224Bytes(enc.encode(PWD)));
  const dns12 = new Uint8Array(12).fill(8);
  const udp = new Uint8Array(1 + 4 + 2 + 2 + 12);
  let o = 0;
  udp[o++] = 1;
  udp.set([8, 8, 8, 8], o);
  o += 4;
  udp[o++] = 0;
  udp[o++] = 53;
  udp[o++] = 0;
  udp[o++] = 12;
  udp.set(dns12, o);
  const b = new Uint8Array(56 + 2 + 1 + 1 + 4 + 2 + 2 + udp.length);
  o = 0;
  b.set(enc.encode(hash), o);
  o += 56;
  b[o++] = 0x0d;
  b[o++] = 0x0a;
  b[o++] = 3;
  b[o++] = 1;
  b.set([8, 8, 8, 8], o);
  o += 4;
  b[o++] = 0;
  b[o++] = 53;
  b[o++] = 0x0d;
  b[o++] = 0x0a;
  b.set(udp, o);
  o += udp.length;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new RealResponse(new Uint8Array([1, 2, 3, 4]));
  try {
    const resp = await W.handleUpgrade(req(), env(), ctx);
    const client = resp.webSocket;
    client.peer.emit("message", { data: b.slice(0, o) });
    await tick(30);
    eq("Trojan UDP 响应带地址前缀", client.sent.map((u) => [...u]), [[1, 8, 8, 8, 8, 0, 53, 0, 4, 1, 2, 3, 4]]);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\nsim：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
