import { connect } from "cloudflare:sockets";

/** 握手分片工程（M1/M2）：可跨请求推进的最小 TLS 1.3 客户端。
 *  本轮只做到「A hello → B sh」：真密钥的 ClientHello + 解析 ServerHello + ECDH + HKDF 派生握手套，
 *  目的是实测「一次带密码学的分片」在 DO 里是否装得下 10 ms 级预算。 */

interface Chan {
  sock: ReturnType<typeof connect>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  chunks: Uint8Array[];
  ended: boolean;
  t: number;
  host: string;
  ch: Uint8Array;
  priv: CryptoKey;
  pub: Uint8Array;
}

const CH: Map<string, Chan> = new Map();

const enc = new TextEncoder();
const cat = (...xs: Uint8Array[]): Uint8Array => {
  let n = 0;
  for (const x of xs) n += x.length;
  const o = new Uint8Array(n);
  let k = 0;
  for (const x of xs) {
    o.set(x, k);
    k += x.length;
  }
  return o;
};
const u8 = (n: number): Uint8Array => Uint8Array.of(n);
const u16 = (n: number): Uint8Array => Uint8Array.of((n >> 8) & 255, n & 255);
const u24 = (n: number): Uint8Array => Uint8Array.of((n >> 16) & 255, (n >> 8) & 255, n & 255);

/** TLS 1.3 ClientHello（x25519 key_share）。 */
export function hello(host: string, pub: Uint8Array): Uint8Array {
  const rnd = new Uint8Array(32);
  crypto.getRandomValues(rnd);
  const name = enc.encode(host);
  // SNI 扩展体的结构：2 字节列表长度 + 1 字节名字类型(0=host) + 2 字节名字长度 + 名字
  const sni = cat(u16(name.length + 3), u8(0), u16(name.length), name);
  // 只发三个扩展：SNI(0x0000)、supported_versions(0x002b，只报 TLS1.3)、key_share(0x0033，x25519 32 字节公钥)；
  // 少一个都可能被服务端回 HelloRetryRequest（我们没实现，等于失败）
  const exts = cat(
    u16(0x0000),
    u16(sni.length),
    sni,
    u16(0x002b),
    u16(3),
    u8(2),
    u16(0x0304),
    u16(0x0033),
    u16(36),
    u16(32),
    u16(0x001d),
    u16(32),
    pub,
  );
  // 正文顺序固定：legacy_version(0x0303) + 32 字节 random + 空 session_id + 密码套件(TLS_AES_128_GCM_SHA256) + 空压缩方法 + 扩展
  const body = cat(u16(0x0303), rnd, u8(0), u16(2), u16(0x1301), u8(1), u8(0), u16(exts.length), exts);
  const hs = cat(u8(1), u24(body.length), body);
  // 外层 TLS 记录头：类型 0x16(handshake) + 版本 0x0301 + 长度；版本写 1.0 是兼容老中间件的惯例
  return cat(u8(0x16), u16(0x0301), u16(hs.length), hs);
}

/** HKDF-Expand-Label（单步：Extract 由调用方先做完）。 */
async function expand(prk: Uint8Array, label: string, ctx: Uint8Array, len: number): Promise<Uint8Array> {
  const l = enc.encode("tls13 " + label);
  const info = cat(u16(len), u8(l.length), l, u8(ctx.length), ctx);
  const key = await crypto.subtle.importKey("raw", prk, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

/** Extract：salt 为空时用 32 字节零。 */
async function extract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new Uint8Array(0) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

const Z32 = new Uint8Array(32);

/** 开一条会话：真 x25519 密钥 + ClientHello + 留住 socket。 */
export async function chOpen(id: string, host: string, port: number): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const ch = hello(host, pub);
  const sock = connect({ hostname: host, port });
  const w = sock.writable.getWriter();
  await w.write(ch);
  w.releaseLock();
  const reader = sock.readable.getReader();
  const c: Chan = { sock, reader, chunks: [], ended: false, t: Date.now(), host, ch, priv: kp.privateKey, pub };
  CH.set(id, c);
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) c.chunks.push(value);
      }
    } catch {
      /* 关闭即结束 */
    }
    c.ended = true;
  })();
  return { id, ok: true, ms: Date.now() - t0, chLen: ch.length, x25519: true };
}

/**
 * 功能：阻塞直到通道攒够 n 字节（或关闭/超时），返回已攒到的数据。
 * @param c 通道
 * @param n 期望字节数
 * @returns 数据；通道已关闭且空时返回 null
 */
function need(c: Chan, n: number): Uint8Array | null {
  let have = 0;
  for (const x of c.chunks) have += x.length;
  if (have < n) return null;
  const all = cat(...c.chunks);
  c.chunks = have > n ? [all.slice(n)] : [];
  return all.slice(0, n);
}

/** B 段：读 ServerHello → ECDH → HKDF 派生握手套（一次请求内做完，用来看 CPU 是否够）。 */
export async function chSh(id: string, waitMs: number): Promise<Record<string, unknown>> {
  const c = CH.get(id);
  if (!c) return { ok: false, err: "no-session" };
  const t0 = Date.now();
  // 等客户端把 ServerHello 收够：至少 5 字节（类型 + 版本 + 长度）才值得解析，
  // 超时或对端关闭就退出，避免一次请求里空转
  while (Date.now() - t0 < waitMs) {
    let have = 0;
    for (const x of c.chunks) have += x.length;
    if (have >= 5) break;
    if (c.ended) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  let have = 0;
  for (const x of c.chunks) have += x.length;
  if (have < 5) return { ok: false, err: c.ended ? "closed" : "idle", ms: Date.now() - t0 };
  // 先拼已有字节、只看记录头：不够或不像是握手就原样返回，让客户端稍后再问（不阻塞请求）
  const pre = cat(...c.chunks);
  const type = pre[0];
  const len = (pre[3] << 8) | pre[4];
  if (type !== 0x16 || have < 5 + len) {
    return { ok: false, err: "not-handshake", type, len, have, head: Array.from(pre.slice(0, 8)), ms: Date.now() - t0 };
  }
  // need 内部按 20ms 轮询直到这条记录收齐；拿不到就是 short（客户端还在传）
  const rec = need(c, 5 + len);
  if (!rec) return { ok: false, err: "short" };
  const hs = rec.slice(5);
  const hsType = hs[0];
  const hsLen = (hs[1] << 16) | (hs[2] << 8) | hs[3];
  if (hsType !== 2) return { ok: false, err: "not-serverhello", hsType, ms: Date.now() - t0 };
  const sh = hs.slice(4, 4 + hsLen);
  const suite = (sh[2] << 8) | sh[3];
  const random = sh.slice(4, 36);
  // ServerHello 正文布局：2 字节版本之后是 32 字节 random，再往后是 session_id（长度+内容），
  // 然后才是扩展区；游标 o 顺着推，越界由 while 条件兜住
  let o = 34 + 1;
  const sidLen = sh[o];
  o += 1 + sidLen;
  const extLen = (sh[o] << 8) | sh[o + 1];
  o += 2;
  const extEnd = o + extLen;
  let group = 0;
  let peer: Uint8Array | null = null;
  // 扫扩展找 key_share(0x0033)：只有它带对端 X25519 公钥；缺了说明服务端要 HelloRetryRequest，直接判失败
  while (o + 4 <= extEnd) {
    const et = (sh[o] << 8) | sh[o + 1];
    const el = (sh[o + 2] << 8) | sh[o + 3];
    const body = sh.slice(o + 4, o + 4 + el);
    if (et === 0x0033) {
      group = (body[0] << 8) | body[1];
      const kl = (body[2] << 8) | body[3];
      peer = body.slice(4, 4 + kl);
    }
    o += 4 + el;
  }
  if (!peer) return { ok: false, err: "no-key-share", ms: Date.now() - t0 };
  const peerKey = await crypto.subtle.importKey("raw", peer, { name: "X25519" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peerKey }, c.priv, 256));
  // transcript 必须含 ClientHello 与这条 ServerHello 的原始字节（含 4 字节记录头与 4 字节 handshake 头），
  // 少一个字节，HKDF 派生出的密钥就对不上
  const transcript = cat(c.ch, rec.subarray(0, 4 + 4 + hsLen));
  const thHash = new Uint8Array(await crypto.subtle.digest("SHA-256", transcript));
  // TLS 1.3 密钥链：early（salt=0, ikm=0）→ derived（空 transcript）→ handshake（ECDH 共享密钥）
  // → c hs / s hs traffic；长度 32 即 SHA-256
  const early = await extract(Z32, Z32);
  const derived = await expand(early, "derived", new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(0))), 32);
  const hsSecret = await extract(derived, secret);
  const cHs = await expand(hsSecret, "c hs traffic", thHash, 32);
  const sHs = await expand(hsSecret, "s hs traffic", thHash, 32);
  return {
    id,
    ok: true,
    ms: Date.now() - t0,
    suite,
    group,
    peer: peer.length,
    shLen: hsLen,
    randomLen: random.length,
    hs: { c: cHs.length, s: sHs.length, th: thHash.length },
  };
}

/**
 * 功能：关闭通道会话（标记结束并唤醒等待方）。
 * @param id 会话 id
 * @returns {id, ok}
 */
export function chClose(id: string): Record<string, unknown> {
  const c = CH.get(id);
  if (!c) return { id, ok: false };
  try {
    c.sock.close();
  } catch {
    /* 已关 */
  }
  CH.delete(id);
  return { id, ok: true };
}
/**
 * 功能：从通道会话读数据，最多等 waitMs。
 * @param id 会话 id
 * @param waitMs 等待毫秒
 * @returns {id, ok, data?, err?}
 */
export async function chRead(id: string, waitMs: number): Promise<Record<string, unknown>> {
  const c = CH.get(id);
  if (!c) return { id, ok: false, err: "no-session" };
  const t0 = Date.now();
  while (!c.chunks.length && !c.ended && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 20));
  if (!c.chunks.length) return { id, ok: false, err: c.ended ? "closed" : "idle", age: Date.now() - c.t };
  const bytes = cat(...c.chunks);
  c.chunks = [];
  return { id, ok: true, age: Date.now() - c.t, bytes: bytes.length, head: Array.from(bytes.slice(0, 8)) };
}

