// 明文 HTTP 探测：connect 到 <relay|host>:80，写一条 GET，读状态行。
// 用途：免费计划跑不动 TLS 客户端（DO 也会 CPU 超限），但 CF 边缘在 :80 同样按 Host 路由，
// 封锁/放行会体现为不同的状态码，因此这是「真实的 HTTP 证据」而不是流量推断。
import { connect } from "cloudflare:sockets";
import { CONNECT_MS, withTimeout } from "./util";

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

/**
 * 功能：把 `host:port` 拆成主机与端口，认裸 IPv6 与 `[v6]:port` 两种写法。
 *
 * 为什么不能 `split(":")`：IPv6 字面量本身就带冒号，`2a06:98c0::1:443` 会被拆成
 * host=`2a06`、port=`98c0`（→ 80），探测打到完全不相干的主机上。中继列表里的地址
 * 来自客户端与公开源，不能假定是 IPv4。
 * @param {string} raw `host:port` / `[v6]:port` / 裸 host
 * @param {number} defPort 没写端口时的默认端口
 * @returns {[string, number]} 主机与端口
 */
export function splitRelay(raw: string, defPort: number): [string, number] {
  const s = String(raw || "").trim();
  if (!s) return ["", defPort];
  // 方括号写法：[v6]:port
  if (s.startsWith("[")) {
    const br = s.lastIndexOf("]");
    if (br > 0) {
      const port = Number(s.slice(br + 1).replace(/^:/, ""));
      return [s.slice(1, br), port > 0 ? port : defPort];
    }
  }
  const i = s.lastIndexOf(":");
  if (i < 0) return [s, defPort];
  const head = s.slice(0, i);
  const tail = s.slice(i + 1);
  // 冒号后不是纯数字 = 没有端口；冒号前还有冒号 = 裸 IPv6（整串是主机）
  if (!/^\d{1,5}$/.test(tail) || head.includes(":")) return [s, defPort];
  const port = Number(tail);
  return [head, port > 0 ? port : defPort];
}

/**
 * 功能：明文 HTTP/80 探目标是否可达（比 TLS 探测便宜，用于判断「IP 层通不通」）。
 * @param host 目标主机名
 * @param relay 中继 host:port，空串表示直连
 * @param path 请求路径，默认 /
 * @returns 探测结果：ok / status / ms / bytes / err
 */
export async function probeHttp80(host: string, relay = "", path = "/"): Promise<HttpProbeResult> {
  const t0 = Date.now();
  const [rh, rp] = relay ? splitRelay(relay, 80) : [host, 80];
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
    // connect() 惰性：第一次 write 才真正建连，没有上限就会一直挂在这里。
    await withTimeout(w.write(new TextEncoder().encode(req)), CONNECT_MS, "timeout");
    w.releaseLock();
    await Promise.race([pump, new Promise((r) => setTimeout(r, CONNECT_MS))]);
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

