import type { Socket } from "cloudflare:sockets";
import { logErr } from "../nodes/metrics";
import { checkTarget } from "../core/net";
import { aliveList } from "./pool";
import { S } from "../core/state";
import { dec, enc, toHex, withTimeout } from "../core/util";
import { connect } from "cloudflare:sockets";

/* 代理节点：探活与池子抓取 */
export const PROBE_HELLO = (() => {
  const hx =
    "16030100d2010000ce030380f2b59e000bbca2041abbd20c3ad59999e3ee3a101aa9956fc2b767da0a0b36000038c02cc030009fcca9cca8ccaac02bc02f009ec024c028006bc023c0270067c00ac0140039c009c0130033009d009c003d003c0035002f00ff0100006d0000001700150000127777772e636c6f7564666c6172652e636f6d000b000403000102000a000c000a001d0017001e00190018002300000016000000170000000d002a0028040305030603080708080809080a080b080408050806040105010601030303010302040205020602";
  const a = new Uint8Array(hx.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hx.substr(i * 2, 2), 16);
  return a;
})();

// 额外候选主机（不是列表，是"池域名"，解析后是多台机器）
export const EXTRA_HOSTS = ["pyip.ygkkk.dpdns.org"];

// 候选池来源（按价值排序；单源失败不影响其余源）
//   1. IPDB 官方 GitHub 镜像 —— API 站从 Worker 访问恒 403，镜像可通
//   2. CB-X2-Jun —— IP:PORT:CC 格式，上游已做存活校验
//   3. jsDelivr —— 与 2 同内容，防 raw.githubusercontent 429
//   4. IPDB 精选带国家码
//   5. 老源（唯一长期验证可用的原始源）
//   6. 官方 API —— 目前 403，留作对方解封后的兜底
export const POOL_SOURCES = [
  "https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestProxy/proxy.txt",
  "https://raw.githubusercontent.com/CB-X2-Jun/cf-proxyip-lists/main/proxyip.txt",
  "https://cdn.jsdelivr.net/gh/CB-X2-Jun/cf-proxyip-lists@main/proxyip.txt",
  "https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestProxy/bestproxy%26country.txt",
  "https://raw.githubusercontent.com/xgonce/Cloudflare_IP/main/result.csv",
  "https://ipdb.api.030101.xyz/?type=proxy",
];

// 一行候选：IP[:PORT][#CC | ,… | :CC | 空白]
export const PX_LINE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:[#,:]|\s|$)/;

/**
 * 解析候选池的一行文本并写入去重表；私网/保留地址直接丢弃。
 * @param {string} line 一行文本（IP[:PORT][#CC|,|:CC]）
 * @param {string} src 来源 URL
 * @param {Map<string,object>} seen 去重表（key = ip:port）
 * @returns {boolean} 是否为有效新增
 */
export function takePoolLine(line: string, src: string, seen: Map<string, PoolEntry>) {
  const m = PX_LINE.exec(line.trim());
  if (!m) return false;
  const ip = m[1];
  let port = m[2] ? Number(m[2]) : 443;
  if (!(port >= 1 && port <= 65535)) port = 443;
  if (checkTarget(ip, port)) return false;
  const oct = ip.split(".").map(Number);
  if (oct.some((x) => !(x >= 0 && x <= 255))) return false;
  const key = ip + ":" + port;
  if (seen.size >= POOL_MAX) return false; // 上游源可能大到离谱，硬上限防内存/ KV 值爆掉
  if (!seen.has(key)) seen.set(key, { h: ip, p: port, src });
  return true;
}

export const POOL_TTL_MS = 24 * 3600e3; // 候选池重建周期（上游源每天都会变）
export const POOL_MAX = 800; // 候选池硬上限
// 换节点策略（可用环境变量覆盖）
//   pxDwellMin : 切换后最少驻留多少分钟（默认 360 = 6 小时）
//   pxFailMax  : 连续失败多少次才允许换（默认 5）
//   pxForceAt  : 失败到这个数就无视驻留强制换（默认 8）
/**
 * 读取轮换策略（可用 env 覆盖）。
 * @param {object} env Worker 环境
 * @returns {{dwell:number, fail:number, force:number}} 驻留毫秒、失败阈值、强制换阈值
 */
export function pxPolicy(env: Env) {
  const d = Number(env.pxDwellMin);
  const f = Number(env.pxFailMax);
  const x = Number(env.pxForceAt);
  return {
    dwell: (Number.isFinite(d) && d >= 0 ? d : 0) * 60000,
    fail: Number.isFinite(f) && f > 0 ? f : 3,
    force: Number.isFinite(x) && x > 0 ? x : 5,
  };
}

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
    await w.write(PROBE_HELLO);
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

/** 一次抓取的结果：池子 + 每个源的行数/新增数（/proxyip?refill=1 直接展示） */
export interface PoolRefill {
  pool: PoolEntry[];
  sources: Record<string, { lines: number; ok: number }>;
}

/**
 * 从所有上游源抓取候选池并按 ip:port 去重（单源失败不影响其他源）。
 * @param {object} env Worker 环境
 * @returns {Promise<PoolRefill>} 合并后的候选池与各源统计
 */
export async function refillPool(env: Env): Promise<PoolRefill> {
  const seen = new Map<string, PoolEntry>();
  const sources: Record<string, { lines: number; ok: number }> = Object.create(null);
  for (const src of POOL_SOURCES) {
    let lines = 0;
    const before = seen.size;
    try {
      const r = await fetch(src, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          accept: "text/html,application/json,text/plain,*/*",
          "accept-language": "en-US,en;q=0.9",
          referer: "https://www.google.com/",
        },
      });
      if (!r.ok) {
        lines = -r.status;
      } else {
        const txt = (await r.text()).slice(0, 2 * 1024 * 1024); // 防异常大响应把 CPU/内存打满
        for (const line of txt.split("\n")) {
          if (PX_LINE.test(line.trim())) lines++;
          takePoolLine(line, src, seen);
        }
      }
    } catch (e) {
      lines = -1;
    }
    sources[src] = { lines, ok: seen.size - before };
  }
  for (const h of EXTRA_HOSTS) {
    // seen 的键是 "ip:port"：以前用不带端口的 h 去重，永远判不存在，
    // 上游列表里已有同名条目时会插进两条一样的节点。
    const key = h + ":443";
    if (!seen.has(key)) seen.set(key, { h, p: 443, src: "builtin" });
  }

  const pool = [...seen.values()];
  if (pool.length) logErr("pool refilled: " + pool.length, "");
  return { pool, sources };
}

/**
 * 批量查询 IP 归属国（第三方免费接口，单次最多 100 个）。
 * @param {string[]} ips IP 列表
 * @returns {Promise<Record<string,string>>} IP → 两位国家码
 */
export async function geoLabel(ips: string[]) {
  const out: Record<string, string> = {};
  if (!ips.length) return out;
  try {
    const r = await fetch("http://ip-api.com/batch?fields=status,countryCode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ips.slice(0, 100)),
    });
    if (r.ok) {
      const arr = await r.json();
      (arr as IpApiRow[]).forEach((x, i) => {
        if (x && x.status === "success" && x.countryCode) out[ips[i]] = String(x.countryCode).toUpperCase();
      });
    }
  } catch (e) {
    /* 查不到就不打标，不影响可用性 */
  }
  return out;
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
export async function probeSni(nodeHost: string, nodePort: number, sni: string, ms = 2500): Promise<SniProbe> {
  if (checkTarget(nodeHost, nodePort)) return { err: "denied" };
  const t0 = Date.now();
  let sock: Socket | null = null;
  try {
    sock = await connect({ hostname: nodeHost, port: nodePort });
    // 注意：Workers 的 connect() 是惰性的，真正的 TCP 建连发生在第一次 write/read，
    // 所以这里不单独报 tcp，只报"从发起到收到 ServerHello"的总耗时。
    const w = sock.writable.getWriter();
    await w.write(tlsHello(sni));
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

/**
 * 得出订阅里要输出的地区列表（配置固定值或按 alive 自动推断）。
 * @param {object} env Worker 环境
 * @returns {Promise<string[]>} 最多 6 个两位国家码
 */
export async function regionListAsync(env: Env) {
  const raw = String(env.regions || "").trim();
  if (raw && raw.toLowerCase() !== "auto") {
    return raw
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => /^[A-Z]{2}$/.test(x))
      .slice(0, 6);
  }
  const list = await aliveList(env);
  const set: string[] = [];
  for (const x of list) {
    const cc = (x.cc || "").toUpperCase();
    if (cc && !set.includes(cc)) set.push(cc);
  }
  return set.slice(0, 6);
}
