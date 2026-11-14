// TLS 1.3 探测：经（可选）中继对目标做真实握手 + GET，拿到隧道里的 HTTP 状态行。
// 用 vendored subtls（纯 JS + SubtleCrypto，只做 TLS 1.3），根证书精选 3 张（4.2KB）。
import { connect } from "cloudflare:sockets";
import { LazyReadFunctionReadQueue, ReadMode, startTls, TrustedCert } from "../vendor/subtls";
import ROOTS from "../vendor/roots";

export interface TlsProbeResult {
  ok: boolean;
  /** HTTP 状态码（0 = 没拿到状态行） */
  code: number;
  status: string;
  server: string;
  head: string;
  ms: number;
  hsMs: number;
  bytes: number;
  err: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 根证书库只解析一次（模块级缓存；顶层不放 let，架构门禁不允许）
const DB: { p: Promise<unknown> | null } = { p: null };

function db(): Promise<unknown> {
  if (!DB.p) DB.p = TrustedCert.databaseFromPEM(ROOTS).catch(() => ROOTS);
  return DB.p;
}

const EMPTY: TlsProbeResult = { ok: false, code: 0, status: "", server: "", head: "", ms: 0, hsMs: 0, bytes: 0, err: "" };

export async function probeTls(host: string, path = "/", relay = ""): Promise<TlsProbeResult> {
  const t0 = Date.now();
  const [rHost, rPort] = relay ? relay.split(":") : [host, "443"];
  let sock: ReturnType<typeof connect>;
  try {
    sock = connect({ hostname: rHost, port: Number(rPort) || 443 });
  } catch (e) {
    return { ...EMPTY, err: "connect: " + String((e as Error).message).slice(0, 80) };
  }

  const chunks: Uint8Array[] = [];
  let ended = false;
  let notify: (() => void) | null = null;
  const wake = () => {
    const f = notify;
    notify = null;
    if (f) f();
  };
  let pumpErr = false;
  const reader = sock.readable.getReader();
  const pump = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      if (r.value && r.value.length) {
        chunks.push(new Uint8Array(r.value));
        wake();
      }
    }
  })();
  // 必须接住 reject：未捕获的 promise 会让整次调用 1101
  pump.then(
    () => {
      ended = true;
      wake();
    },
    () => {
      ended = true;
      pumpErr = true;
      wake();
    },
  );

  // subtls 的读函数契约：必须返回「至少 bytes 个字节」，否则记录 EOF。
  // 直接返回「刚到的那一块」会触发 Not enough data returned by read function。
  const nextChunk = async (bytes: number): Promise<Uint8Array | undefined> => {
    const out = new Uint8Array(bytes);
    let got = 0;
    while (got < bytes) {
      const c = chunks[0];
      if (!c) {
        if (ended) return undefined;
        await new Promise<void>((res) => {
          notify = res;
        });
        continue;
      }
      const take = Math.min(c.length, bytes - got);
      out.set(c.subarray(0, take), got);
      got += take;
      if (take === c.length) chunks.shift();
      else chunks[0] = c.subarray(take);
    }
    return out;
  };

  const q = new LazyReadFunctionReadQueue(nextChunk);
  const writer = sock.writable.getWriter();
  const writeNet = (data: Uint8Array) => {
    writer.write(data).catch(() => {
      pumpErr = true;
    });
  };

  let tls: { read(bytes?: number): Promise<Uint8Array | undefined>; write(d: Uint8Array): Promise<void> };
  try {
    const rootDb = await db();
    // 必须把 mode 透传给读队列：mode=1 是 PEEK，吞掉一个字节会让 TLS 解析错位（Illegal TLS record type 0x3）
  tls = await startTls(host, rootDb, (n: number, mode?: ReadMode) => q.read(n, mode), writeNet, {});
  } catch (e) {
    try {
      sock.close();
    } catch {
      pumpErr = true;
    }
    return { ...EMPTY, err: "tls: " + String((e as Error).message).slice(0, 90), ms: Date.now() - t0 };
  }
  const hsMs = Date.now() - t0;

  const req = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
  try {
    await tls.write(new TextEncoder().encode(req));
  } catch (e) {
    pumpErr = true;
    return { ...EMPTY, err: "write: " + String((e as Error).message).slice(0, 60), ms: Date.now() - t0, hsMs };
  }

  let got: Uint8Array = new Uint8Array(0);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && got.length < 4096) {
    const part = await Promise.race([
      tls.read().catch(() => undefined),
      new Promise<undefined>((res) => setTimeout(() => res(undefined), 1500)),
    ]);
    if (!part) {
      if (got.length) break;
      if (pumpErr || ended) break;
      continue;
    }
    const next = new Uint8Array(got.length + part.length);
    next.set(got, 0);
    next.set(part, got.length);
    got = next;
  }
  try {
    sock.close();
  } catch {
    pumpErr = true;
  }

  const text = new TextDecoder().decode(got);
  const status = (text.split("\r\n")[0] || "").replace(/[^\x20-\x7e]/g, "").slice(0, 40);
  const server = ((text.match(/^server:\s*(.+)$/im) || [])[1] || "").trim().slice(0, 40);
  const bodyAt = text.indexOf("\r\n\r\n");
  const head = bodyAt >= 0 ? text.slice(bodyAt + 4, bodyAt + 24).replace(/\s+/g, " ") : "";
  const cm = /^HTTP\/1\.[01] (\d{3})/.exec(status);
  const code = cm ? Number(cm[1]) : 0;
  return { ok: code >= 200 && code < 400, code, status, server, head, ms: Date.now() - t0, hsMs, bytes: got.length, err: "" };
}
