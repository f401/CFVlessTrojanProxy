// 明文 HTTP 探测：connect 到 <relay|host>:80，写一条 GET，读状态行。
// 用途：免费计划跑不动 TLS 客户端（DO 也会 CPU 超限），但 CF 边缘在 :80 同样按 Host 路由，
// 封锁/放行会体现为不同的状态码，因此这是「真实的 HTTP 证据」而不是流量推断。
import { connect } from "cloudflare:sockets";

export interface HttpProbeResult {
  ok: boolean;
  code: number;
  status: string;
  server: string;
  bytes: number;
  ms: number;
  err: string;
}

const EMPTY: HttpProbeResult = { ok: false, code: 0, status: "", server: "", bytes: 0, ms: 0, err: "" };

export async function probeHttp80(host: string, relay = "", path = "/"): Promise<HttpProbeResult> {
  const t0 = Date.now();
  const [rh, rp] = relay ? relay.split(":") : [host, "80"];
  let sock: ReturnType<typeof connect>;
  try {
    sock = connect({ hostname: rh, port: Number(rp) || 80 });
  } catch (e) {
    return { ...EMPTY, err: "connect: " + String((e as Error).message).slice(0, 80) };
  }
  const req =
    "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nUser-Agent: Mozilla/5.0 (probe)\r\nAccept: */*\r\nConnection: close\r\n\r\n";
  let buf = new Uint8Array(0);
  const reader = sock.readable.getReader();
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        const n = new Uint8Array(buf.length + value.length);
        n.set(buf);
        n.set(value, buf.length);
        buf = n;
        if (buf.length > 2048) break;
      }
    }
  })().catch(() => {});
  try {
    const w = sock.writable.getWriter();
    await w.write(new TextEncoder().encode(req));
    w.releaseLock();
    await Promise.race([pump, new Promise((r) => setTimeout(r, 2500))]);
  } catch (e) {
    try { sock.close(); } catch {}
    return { ...EMPTY, err: "io: " + String((e as Error).message).slice(0, 80), ms: Date.now() - t0 };
  }
  try { reader.releaseLock(); } catch {}
  try { sock.close(); } catch {}
  const text = new TextDecoder().decode(buf.slice(0, 2048));
  const line = text.split("\r\n")[0] || "";
  const m = line.match(/^HTTP\/1\.[01] (\d{3})/);
  const code = m ? Number(m[1]) : 0;
  const srv = (text.match(/\r\nserver:\s*([^\r\n]+)/i) || [])[1] || "";
  return {
    ok: code > 0,
    code,
    status: line.slice(0, 64),
    server: srv.trim().slice(0, 40),
    bytes: buf.length,
    ms: Date.now() - t0,
    err: code ? "" : "no-status",
  };
}
