// 原始 TLS 探活：一条候选到底能不能中转。
// probeProxy 用「证书链里有没有 cloudflare」判开放反代；probeSni 用手写 ClientHello 看目标会不会回
// ServerHello（诊断「某节点能不能把这个站转出去」）。两者都不完成握手 —— 那需要自己实现密钥交换。

import type { Socket } from "cloudflare:sockets";
import { checkTarget } from "../core/net";
import { CONNECT_MS, dec, enc, toHex, withTimeout } from "../core/util";
import { connect } from "cloudflare:sockets";

/* 代理节点：探活与池子抓取 */
export const PROBE_HELLO = (() => {
  const hx =
    "16030100d2010000ce030380f2b59e000bbca2041abbd20c3ad59999e3ee3a101aa9956fc2b767da0a0b36000038c02cc030009fcca9cca8ccaac02bc02f009ec024c028006bc023c0270067c00ac0140039c009c0130033009d009c003d003c0035002f00ff0100006d0000001700150000127777772e636c6f7564666c6172652e636f6d000b000403000102000a000c000a001d0017001e00190018002300000016000000170000000d002a0028040305030603080708080809080a080b080408050806040105010601030303010302040205020602";
  const a = new Uint8Array(hx.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hx.substr(i * 2, 2), 16);
  return a;
})();

/**
 * 探测某个候选是否为开放反代：TLS 握手后看证书链里是否出现 cloudflare。
 * @param {string} h 候选主机
 * @param {number} p 候选端口
 * @returns {Promise<{h:string,p:number,ms:number,ts:number,bad?:string}|null>} 成功返回节点信息，失败返回 null
 */
export async function probeProxy(h: string, p: number) {
  if (checkTarget(h, p)) return null; // 纵深防御：任何路径都不许探内网
  const t0 = Date.now();
  let sock = null;
  try {
    try {
      sock = await connect({ hostname: h, port: p });
    } catch (e0) {
      // IPv4 字面量在 Workers 上常常连不上，退回 sslip.io
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) throw e0;
      sock = await connect({ hostname: h + ".sslip.io", port: p });
    }
    const tcp = Date.now() - t0; // ① 建连：纯网络 S.rtt
    const w = sock.writable.getWriter();
    // connect() 是惰性的：真正的 TCP 建连发生在第一次 write。只给 read 包超时不够 ——
    // 黑洞候选会让这里一直挂着，而探活是按 SC.PROBE_CONC 个一批跑的，挂住一个就卡住整轮。
    await withTimeout(w.write(PROBE_HELLO), CONNECT_MS, "timeout");
    w.releaseLock();

    const r = sock.readable.getReader();
    let buf = new Uint8Array(0);
    const deadline = Date.now() + 4000;

    while (Date.now() < deadline && buf.length < 8192) {
      const wait = Math.max(200, deadline - Date.now());
      let got = null;
      try {
        got = (await withTimeout(r.read(), wait, "timeout")) as { value?: Uint8Array };
      } catch (e) {
        break; // 超时/断开：跳出，走下面的诊断返回
      }
      const v = got && got.value;
      if (!v || !v.length) break;
      const merged = new Uint8Array(buf.length + v.length);
      merged.set(buf, 0);
      merged.set(v, buf.length);
      buf = merged;

      if (buf[0] !== 0x16)
        return {
          h,
          p,
          ms: Date.now() - t0,
          tcp,
          tls: 0,
          ts: Date.now(),
          bad: "not-tls",
          head: toHex(buf.slice(0, 16)),
        };
      if (/cloudflare/i.test(dec.decode(buf))) {
        // ② TLS 往返：建连完成到收到第一段证书字节。丢包会让这段异常变长。
        return { h, p, ms: Date.now() - t0, tcp, tls: Math.max(0, Date.now() - t0 - tcp), ts: Date.now() };
      }
    }
    return {
      h,
      p,
      ms: Date.now() - t0,
      tcp,
      tls: 0,
      ts: Date.now(),
      bad: "no-cf-cert",
      len: buf.length,
      head: toHex(buf.slice(0, 24)),
    };
  } catch (e) {
    return null;
  } finally {
    try {
      sock && sock.close();
    } catch (e) {}
  }
}

/**
 * 构造一个只带 SNI 的最小 TLS ClientHello。
 *
 * 用途：诊断"某个节点能不能把这个站转出去"。
 * 我们不需要完成握手（那要自己实现密钥交换），只要让中转读到 SNI、
 * 把 TCP 接到目标，看目标会不会回 ServerHello —— 回了就说明链路通。
 *
 * @param {string} sni 目标域名
 * @returns {Uint8Array} 完整的 ClientHello 记录
 */
export function tlsHello(sni: string): Uint8Array {
  const name = enc.encode(sni);
  const out: number[] = [];
  const u16 = (n: number) => {
    out.push((n >> 8) & 0xff, n & 0xff);
  };
  const u24 = (n: number) => {
    out.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  };

  // ---- extensions ----
  const ext: number[] = [];
  const e16 = (n: number) => {
    ext.push((n >> 8) & 0xff, n & 0xff);
  };
  // server_name
  e16(0x0000);
  e16(name.length + 5);
  e16(name.length + 3);
  ext.push(0x00);
  e16(name.length);
  for (let i = 0; i < name.length; i++) ext.push(name[i]);
  // supported_groups: x25519, secp256r1
  //   ext_len = 6（list_len 2 字节 + 两个 group），写 4 会让解析器读串位 → decode_error
  e16(0x000a);
  e16(6);
  e16(4);
  e16(0x001d);
  e16(0x0017);
  // ec_point_formats: uncompressed（TLS1.2 走 ECDHE 时服务端要求）
  e16(0x000b);
  e16(2);
  ext.push(0x01, 0x00);
  // signature_algorithms: ecdsa_secp256r1_sha256, rsa_pss_rsae_sha256（list_len 4 → ext_len 6）
  e16(0x000d);
  e16(6);
  e16(4);
  e16(0x0403);
  e16(0x0804);
  // supported_versions: **只报 TLS1.2**。
  //   报 1.3 就必须带 key_share，否则服务端直接 missing_extension；
  //   而 1.2 的 ServerHello + Certificate 是明文，能顺带看到证书。
  e16(0x002b);
  e16(3);
  ext.push(0x02);
  e16(0x0303);

  // ---- handshake body ----
  const hs: number[] = [];
  hs.push(0x03, 0x03); // legacy_version
  const rnd = crypto.getRandomValues(new Uint8Array(32));
  for (let i = 0; i < 32; i++) hs.push(rnd[i]);
  hs.push(0x00); // session_id len
  hs.push(0x00, 0x08, 0xc0, 0x2f, 0xc0, 0x30, 0x00, 0x9c, 0x00, 0x9d); // cipher suites（TLS1.2 ECDHE/RSA）
  hs.push(0x01, 0x00); // compression: null
  hs.push((ext.length >> 8) & 0xff, ext.length & 0xff);
  for (const b of ext) hs.push(b);

  // ---- record ----
  out.push(0x16, 0x03, 0x01); // handshake, TLS1.0 record version
  u16(hs.length + 4);
  out.push(0x01); // client_hello
  u24(hs.length);
  for (const b of hs) out.push(b);
  return new Uint8Array(out);
}

/**
 * 通过某个中转，向目标发一个 ClientHello，看能不能拿到 ServerHello。
 * 用来区分"节点连不上这个站"和"节点能连、只是被站点拒了"。
 *
 * @param {string} nodeHost 中转主机
 * @param {number} nodePort 中转端口
 * @param {string} sni 目标域名
 * @param {number} [ms] 超时毫秒
 * @returns {Promise<{tcp:number, hs?:number, err:string}>} 结果
 */
export async function probeSni(nodeHost: string, nodePort: number, sni: string, ms = CONNECT_MS): Promise<SniProbe> {
  if (checkTarget(nodeHost, nodePort)) return { err: "denied" };
  const t0 = Date.now();
  let sock: Socket | null = null;
  try {
    sock = await connect({ hostname: nodeHost, port: nodePort });
    // 注意：Workers 的 connect() 是惰性的，真正的 TCP 建连发生在第一次 write/read，
    // 所以这里不单独报 tcp，只报"从发起到收到 ServerHello"的总耗时。
    const w = sock.writable.getWriter();
    // 同上：惰性 connect 的第一次 write 才是真正建连，必须有时限。
    await withTimeout(w.write(tlsHello(sni)), ms, "timeout");
    w.releaseLock();

    const r = sock.readable.getReader();
    const deadline = Date.now() + ms;
    let buf = new Uint8Array(0);
    while (Date.now() < deadline && buf.length < 8) {
      const wait = Math.max(150, deadline - Date.now());
      let got: { value?: Uint8Array } | null = null;
      try {
        got = (await withTimeout(r.read(), wait, "timeout")) as { value?: Uint8Array };
      } catch (e) {
        break;
      }
      const v = got && got.value;
      if (!v || !v.length) break;
      const merged = new Uint8Array(buf.length + v.length);
      merged.set(buf, 0);
      merged.set(v, buf.length);
      buf = merged;
    }
    if (!buf.length) return { err: "no-data" };
    if (buf[0] !== 0x16) return { err: "not-tls", head: toHex(buf.slice(0, 8)) };
    return { hs: Math.max(0, Date.now() - t0), err: "" };
  } catch (e) {
    return { err: "tcp" };
  } finally {
    try {
      if (sock) sock.close();
    } catch (e) {}
  }
}
