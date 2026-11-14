import { connect } from "cloudflare:sockets";

/** 握手分片工程（M2 骨架）：把「拿到 ServerHello 之后不要关连接」做成可跨请求的会话。
 *  这里先只做两件事：① 发一个最小 ClientHello 并**留住 socket**；② 之后任意时刻回来读一段。
 *  目的：在真 DO 里量 socket 能活多久（3 s / 5 s），这是整个分片方案的前提。 */

export interface Chan {
  sock: ReturnType<typeof connect>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  chunks: Uint8Array[];
  ended: boolean;
  t: number;
}

const CH: Map<string, Chan> = new Map();

function u8(n: number): Uint8Array {
  const b = new Uint8Array(1);
  b[0] = n;
  return b;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = (n >> 8) & 255;
  b[1] = n & 255;
  return b;
}

function cat(...xs: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const x of xs) n += x.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

/** 最小 ClientHello：TLS1.3 + x25519，够让服务端回 ServerHello（会话只用于存活测试）。 */
export function hello(host: string): Uint8Array {
  const rnd = new Uint8Array(32);
  crypto.getRandomValues(rnd);
  const ks = new Uint8Array(32);
  crypto.getRandomValues(ks);
  const name = new TextEncoder().encode(host);
  const sni = cat(u16(name.length + 3), u8(0), u16(name.length), name);
  const exts = cat(
    u16(0x0000),
    u16(sni.length),
    sni, // server_name
    u16(0x002b),
    u16(3),
    u8(2),
    u16(0x0304), // supported_versions: TLS1.3
    u16(0x0033),
    u16(36),
    u16(32),
    u16(0x001d),
    u16(32),
    ks, // key_share: x25519
  );
  const body = cat(
    u16(0x0303),
    rnd,
    u8(0), // session_id
    u16(2),
    u16(0x1301), // cipher suite
    u8(1),
    u8(0), // compression
    u16(exts.length),
    exts,
  );
  const hs = cat(u8(1), u8(0), u16(body.length), body); // handshake: client_hello（长度占位）
  const rec = cat(u8(0x16), u16(0x0301), u16(hs.length), hs);
  return rec;
}

/** 开一条会话：connect + 发 ClientHello + 留住 socket。 */
export async function chOpen(id: string, host: string, port: number): Promise<Record<string, unknown>> {
  const sock = connect({ hostname: host, port });
  const writer = sock.writable.getWriter();
  await writer.write(hello(host));
  writer.releaseLock();
  const reader = sock.readable.getReader();
  const ch: Chan = { sock, reader, chunks: [], ended: false, t: Date.now() };
  CH.set(id, ch);
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) ch.chunks.push(value);
      }
    } catch {
      /* 连接断了就标记结束 */
    }
    ch.ended = true;
  })();
  return { id, ok: true, t: ch.t };
}

/** 回来读一段：把这段时间里收到的字节读出来（若有）。 */
export async function chRead(id: string, waitMs: number): Promise<Record<string, unknown>> {
  const ch = CH.get(id);
  if (!ch) return { id, ok: false, err: "no-session" };
  const t0 = Date.now();
  while (!ch.chunks.length && !ch.ended && Date.now() - t0 < waitMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!ch.chunks.length) return { id, ok: false, err: ch.ended ? "closed" : "idle", age: Date.now() - ch.t };
  const bytes = cat(...ch.chunks);
  ch.chunks = [];
  return { id, ok: true, age: Date.now() - ch.t, bytes: bytes.length, head: Array.from(bytes.slice(0, 8)) };
}

/** 收尾。 */
export function chClose(id: string): Record<string, unknown> {
  const ch = CH.get(id);
  if (!ch) return { id, ok: false };
  try {
    ch.sock.close();
  } catch {
    /* 已关 */
  }
  CH.delete(id);
  return { id, ok: true };
}
