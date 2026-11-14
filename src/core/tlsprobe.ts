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
  // 根库解析在 DO 里可能挂住（实测 dbt 端点 10s 无响应），用 1.2s 计时器兜底退回原始 PEM 字符串：
  // subtls 在跳过校验时并不需要解析结果，正常路径下解析是 0ms。
  if (!DB.p)
    DB.p = Promise.race([
      TrustedCert.databaseFromPEM(ROOTS).catch(() => ROOTS),
      new Promise((res) => setTimeout(() => res(ROOTS), 1200)),
    ]);
  return DB.p;
}

const EMPTY: TlsProbeResult = { ok: false, code: 0, status: "", server: "", head: "", ms: 0, hsMs: 0, bytes: 0, err: "" };

// 真实计时器：Worker 里 Date.now() 在一次同步 CPU 段内是冻结的（只在 I/O 边界前推），
// 所以「等数据」这种纯等待必须用 setTimeout 竞速，否则永远等不到截止时间（这就是探测一直 timeout 的原因）。
function race<T>(p: Promise<T>, ms: number, onEnd: () => void): Promise<T | undefined> {
  return Promise.race([
    p.catch(() => undefined),
    new Promise<undefined>((res) => setTimeout(() => { onEnd(); res(undefined); }, ms)),
  ]);
}

export async function probeTls(
  host: string,
  path = "/",
  relay = "",
  mark?: (stage: string) => void,
): Promise<TlsProbeResult> {
  const t0 = Date.now();
  const mk = (x: string) => {
    if (mark) mark(x);
  };
  mk("start");
  // 硬截止：调用方（DO / 请求路径）都有很紧的 CPU 上限，探测不能把请求拖死
  const hardEnd = t0 + 3000;
  const [rHost, rPort] = relay ? relay.split(":") : [host, "443"];
  let sock: ReturnType<typeof connect>;
  try {
    sock = connect({ hostname: rHost, port: Number(rPort) || 443 });
  } catch (e) {
    return { ...EMPTY, err: "connect: " + String((e as Error).message).slice(0, 80) };
  }

  const chunks: Uint8Array[] = [];
  let ended = false;
  let stopped = false;
  // 等待者队列（不能只存一个回调：pump 在「检查 chunks 为空」与「登记等待者」之间插入一次 push 时，
  // 单槽 notify 会丢掉唤醒，读函数就永远挂着 —— 这正是探测一直 timeout / 被 CPU 上限打断的原因）
  const waiters: Array<() => void> = [];
  const wake = () => {
    while (waiters.length) {
      const f = waiters.shift();
      if (f) f();
    }
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
      if (Date.now() > hardEnd) {
        ended = true;
        try {
          sock.close();
        } catch {
          pumpErr = true;
        }
        return undefined;
      }
      const c = chunks[0];
      if (!c) {
        if (ended) return undefined;
        // 先再检查一次，再登记等待者：push 与 drain 都在同一个微任务里完成，不存在丢唤醒窗口
        if (chunks.length) continue;
        // 用真实计时器兜底：握手停顿（服务器不回包）时不能无限等，否则调用方只能靠外层超时
        await race(
          new Promise<void>((res) => {
            waiters.push(res);
          }),
          1500,
          () => {
            stopped = true;
            try {
              sock.close();
            } catch {
              pumpErr = true;
            }
          },
        );
        if (stopped) return undefined;
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

  mk("hs-before");
  const q = new LazyReadFunctionReadQueue(nextChunk);
  const writer = sock.writable.getWriter();
  const writeNet = (data: Uint8Array) => {
    writer.write(data).catch(() => {
      pumpErr = true;
    });
  };

  let tls: { read(bytes?: number): Promise<Uint8Array | undefined>; write(d: Uint8Array): Promise<void> };
  try {
    mk("db-before");
    const rootDb = await db();
    mk("db-after");
    // 必须把 mode 透传给读队列：mode=1 是 PEEK，吞掉一个字节会让 TLS 解析错位（Illegal TLS record type 0x3）
  // 握手同样要有时限：用计时器竞速，超时即关 socket 并返回明确错误（而不是让整次调用被外层掐死）
  const hs = await race(startTls(host, rootDb, (n: number, mode?: ReadMode) => q.read(n, mode), writeNet, {}), 6000, () => {
    stopped = true;
    try {
      sock.close();
    } catch {
      pumpErr = true;
    }
  });
  if (!hs) return { ...EMPTY, err: "handshake-timeout", ms: Date.now() - t0 };
  tls = hs;
  } catch (e) {
    try {
      sock.close();
    } catch {
      pumpErr = true;
    }
    return { ...EMPTY, err: "tls: " + String((e as Error).message).slice(0, 90), ms: Date.now() - t0 };
  }
  mk("hs-after");
  const hsMs = Date.now() - t0;

  const req = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
  try {
    mk("write-before");
    await tls.write(new TextEncoder().encode(req));
    mk("write-after");
  } catch (e) {
    pumpErr = true;
    return { ...EMPTY, err: "write: " + String((e as Error).message).slice(0, 60), ms: Date.now() - t0, hsMs };
  }

  let got: Uint8Array = new Uint8Array(0);
  // 每次读取都自带 1.5s 计时器，这里给一个次数上限就足够（Date.now() 在同步段内不走）
  for (let i = 0; i < 8 && got.length < 4096 && !stopped; i++) {
    const part = await Promise.race([
      tls.read().catch(() => undefined),
      new Promise<undefined>((res) => setTimeout(() => res(undefined), 1500)),
    ]);
    if (!part) {
      if (got.length) break;
      if (pumpErr || ended || stopped) break;
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

// —— 诊断：只发 ClientHello、只读首个记录，完全不碰密码学 ——
// 用来判断「DO / 请求路径被 CPU 上限打断」到底是握手算力问题，还是这套 stream 读泵的开销问题。
export async function probeRaw(host: string, relay = "", stage = "sh"): Promise<TlsProbeResult> {
  const t0 = Date.now();
  const hardEnd = t0 + 2500;
  const [rHost, rPort] = relay ? relay.split(":") : [host, "443"];
  let sock: ReturnType<typeof connect>;
  try {
    sock = connect({ hostname: rHost, port: Number(rPort) || 443 });
  } catch (e) {
    return { ...EMPTY, err: "connect: " + String((e as Error).message).slice(0, 80) };
  }
  const chunks: Uint8Array[] = [];
  let ended = false;
  const waiters: Array<() => void> = [];
  const wake = () => {
    while (waiters.length) {
      const f = waiters.shift();
      if (f) f();
    }
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
  const take = async (bytes: number): Promise<Uint8Array | undefined> => {
    const out = new Uint8Array(bytes);
    let got = 0;
    while (got < bytes) {
      if (Date.now() > hardEnd) return undefined;
      const c = chunks[0];
      if (!c) {
        if (ended) return undefined;
        if (chunks.length) continue;
        await new Promise<void>((res) => {
          waiters.push(res);
        });
        continue;
      }
      const n = Math.min(c.length, bytes - got);
      out.set(c.subarray(0, n), got);
      got += n;
      if (n === c.length) chunks.shift();
      else chunks[0] = c.subarray(n);
    }
    return out;
  };

  // 最小 ClientHello（x25519 的 key_share 是随机字节，服务器仍会回 ServerHello / HRR）
  const rnd = new Uint8Array(32);
  crypto.getRandomValues(rnd);
  const ks = new Uint8Array(32);
  crypto.getRandomValues(ks);
  const sni = new TextEncoder().encode(host);
  const ext = (t: number, body: Uint8Array) => {
    const o = new Uint8Array(4 + body.length);
    o[0] = t >> 8;
    o[1] = t & 0xff;
    o[2] = body.length >> 8;
    o[3] = body.length & 0xff;
    o.set(body, 4);
    return o;
  };
  const u16 = (n: number) => new Uint8Array([n >> 8, n & 0xff]);
  const cat = (...parts: Uint8Array[]) => {
    const len = parts.reduce((a, p) => a + p.length, 0);
    const o = new Uint8Array(len);
    let at = 0;
    for (const p of parts) {
      o.set(p, at);
      at += p.length;
    }
    return o;
  };
  const sniBody = cat(u16(sni.length + 3), new Uint8Array([0]), u16(sni.length), sni);
  const groups = cat(u16(2), u16(29));
  const share = cat(u16(4 + ks.length), u16(29), u16(ks.length), ks);
  const alpn = cat(u16(3), new Uint8Array([2]), new TextEncoder().encode("h2"));
  const exts = cat(
    ext(0, sniBody),
    ext(10, groups),
    ext(51, share),
    ext(43, cat(new Uint8Array([2]), u16(0x0304))),
    ext(16, alpn),
  );
  const body = cat(
    u16(0x0303),
    rnd,
    new Uint8Array([32]),
    new Uint8Array(32),
    u16(2),
    u16(0x1301),
    new Uint8Array([1, 0]),
    u16(exts.length),
    exts,
  );
  const hs = cat(new Uint8Array([1]), new Uint8Array([(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]), body);
  const hello = cat(new Uint8Array([0x16, 0x03, 0x01]), u16(hs.length), hs);

  let wrote = 0;
  try {
    const w = sock.writable.getWriter();
    await w.write(hello);
    w.releaseLock();
    wrote = hello.length;
  } catch (e) {
    return { ...EMPTY, err: "write: " + String((e as Error).message).slice(0, 60), ms: Date.now() - t0 };
  }
  const tWrite = Date.now() - t0;
  if (stage === "hello") {
    try {
      sock.close();
    } catch {
      pumpErr = true;
    }
    return { ...EMPTY, ms: tWrite, bytes: wrote, err: "stop:hello" };
  }
  const hdr = await take(5);
  const tHdr = Date.now() - t0;
  if (!hdr) {
    try {
      sock.close();
    } catch {
      pumpErr = true;
    }
    return { ...EMPTY, ms: tHdr, bytes: wrote, err: pumpErr ? "reset" : ended ? "eof" : "no-hdr" };
  }
  const rlen = (hdr[3] << 8) | hdr[4];
  const rec = rlen > 0 && rlen < 8192 ? await take(rlen) : undefined;
  try {
    sock.close();
  } catch {
    pumpErr = true;
  }
  const head = rec ? Array.from(rec.subarray(0, 12)).map((b) => b.toString(16).padStart(2, "0")).join(" ") : "";
  return {
    ok: !!rec,
    code: 0,
    status: "",
    server: "",
    head,
    ms: Date.now() - t0,
    hsMs: tHdr,
    bytes: wrote + (rec ? rec.length + 5 : 0),
    err: rec ? "" : "short",
  };
}
