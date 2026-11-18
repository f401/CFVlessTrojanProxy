import { logErr } from "../nodes/metrics";
import { cnt } from "../core/counter";
import { checkTarget } from "../core/net";
import { timeoutSignal, CONNECT_MS, dec, enc, toHex, withTimeout } from "../core/util";
import type { Socket } from "cloudflare:sockets";
import { CallGate } from "../core/call-gate";

// ---- 并入自 poolsrc.ts ----
// 池子从哪来：公开源清单、去重解析、逐源抓取，以及「哪个源该排到最后」的健康度。
// 这一层只管「拿到候选名单」，探活（能不能真的中转）在 ./rawprobe，地理标注在 ./geo。


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

/**
 * 一轮最多抓几个池子源。
 *
 * `env.poolSrc` 可以覆盖源列表，但抓取次数必须有个上界：一次 cron 调用的 fetch 子请求
 * 硬上限是 50（`SC.SCAN_SUB = 48` 留余量），而固定支出里「源」那一笔是按这个常量记的。
 * 7.240 之前自定义源列表不限条数、`refillPool` 又逐个抓 —— 配 30 个源就是 30 次 fetch，
 * 加上恢复用量（12）、DoH（6）与快照（4）会直接越过硬上限、整轮 cron 1102。
 */
export const REFILL_MAX = 6;

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
  // 源里的行三种写法：ip、ip:port、ip:port#国家码；端口缺省 443，越界也回 443（源数据脏是常态）
  const ip = m[1];
  let port = m[2] ? Number(m[2]) : 443;
  if (!(port >= 1 && port <= 65535)) port = 443;
  if (checkTarget(ip, port)) return false;
  // 只接受 IPv4 字面量：域名会带来 DNS 依赖，而候选池要的是能直接 connect 的地址
  const oct = ip.split(".").map(Number);
  if (oct.some((x) => !(x >= 0 && x <= 255))) return false;
  // 去重键是 ip:port——同一 IP 不同端口是两条不同的出口，不能合并
  const key = ip + ":" + port;
  if (seen.size >= POOL_MAX) return false; // 上游源可能大到离谱，硬上限防内存/ KV 值爆掉
  if (!seen.has(key)) seen.set(key, { h: ip, p: port, src });
  return true;
}

export const POOL_TTL_MS = 24 * 3600e3; // 候选池重建周期（上游源每天都会变）

export const POOL_MAX = 1600; // 候选池硬上限

/**
 * 功能：冷却中的源可以被跳过的最小已有条目数（冷启动兜底）。
 * 低于它就照旧全抓：宁可多花几个子请求，也不能让池子在建池阶段变小。
 */
export const POOL_ENOUGH = 300;

/** 一次抓取的结果：池子 + 每个源的行数/新增数（/proxyip?refill=1 直接展示） */
interface PoolRefill {
  pool: PoolEntry[];
  sources: Record<string, { lines: number; ok: number; skip?: boolean }>;
}

/**
 * 功能：池子源健康度表（每个 isolate 一份，不跨 isolate 共享）。
 *
 * 镜像源经常整站挂掉或被限流，逐个重试会白烧子请求预算（免费计划每轮约 50 个子请求）。
 * 这里只影响「先抓谁」，**不删除源**：全部冷却时仍会按冷却到期时间全部重试一遍。
 */
export class SourceHealth {
  /** 源 URL → { 连续失败次数, 冷却截止时间 } */
  private bad = new Map<string, { n: number; until: number }>();

  /**
   * 功能：按健康度排序：可用源按配置顺序在前，连续失败且仍在冷却的源排最后。
   * @param env Worker 环境（可含 poolSrc 覆盖源列表）
   * @returns 源 URL 数组（与 poolSources 同一集合，只是顺序不同）
   */
  rank(env: Env): string[] {
    const now = Date.now();
    return poolSources(env)
      .map((src, i) => {
        const h = this.bad.get(src);
        const bad = this.cooling(src, now);
        return { src, i, bad, until: h ? h.until : 0 };
      })
      .sort((a, b) => (a.bad === b.bad ? (a.bad ? a.until - b.until : a.i - b.i) : a.bad ? 1 : -1))
      .map((x) => x.src);
  }

  /**
   * 功能：记录一次抓取结果。成功清零，失败累加并刷新 1 小时冷却。
   * @param src 源 URL
   * @param ok 本次抓取是否成功
   * @returns 无
   */
  note(src: string, ok: boolean): void {
    const h = this.bad.get(src) || { n: 0, until: 0 };
    // 失败只影响「先抓谁」的顺序，不清空计数就无从判断冷却是否该结束
    if (ok) this.bad.set(src, { n: 0, until: 0 });
    else this.bad.set(src, { n: h.n + 1, until: Date.now() + 3600_000 });
  }

  /**
   * 功能：这个源是否在冷却期（连续失败 ≥2 且冷却未到期）。
   * @param src 源 URL
   * @param now 当前时间（测试里注入假时间）
   * @returns 在冷却期返回 true
   */
  cooling(src: string, now = Date.now()): boolean {
    const h = this.bad.get(src);
    return !!h && h.n >= 2 && h.until > now;
  }

  /**
   * 功能：当前 isolate 的源健康快照（调试端点与面板用）。
   * @returns 源 URL → { n, until } 的浅拷贝，调用方改动不会影响内部表
   */
  snap(): Record<string, { n: number; until: number }> {
    const out: Record<string, { n: number; until: number }> = Object.create(null);
    for (const [k, v] of this.bad) out[k] = { n: v.n, until: v.until };
    return out;
  }

  /**
   * 功能：源健康度概览 —— /health 用，回答「补货是不是一直失败」。
   *
   * 为什么必须有这个数：补货成功与否决定了能不能维持活跃池的规模，而 6 个公开源实测
   * 每轮都有 1~2 个失败（可达 1/6、4/6、5/6），失败时不看脸色，只能靠这个数。
   * @param now 当前时间（毫秒时间戳；测试可注入假时间）
   * @returns {bad, retryAt} 当前冷却中的源数量、最早恢复时间
   */
  stat(now = Date.now()): { bad: number; retryAt: number } {
    let bad = 0;
    let retryAt = 0;
    for (const v of this.bad.values()) {
      // 已到期的条目不参与统计：它下一轮就会被 rank() 当作健康源重新尝试
      if (!v.until || v.until <= now) continue;
      bad += 1;
      if (!retryAt || v.until < retryAt) retryAt = v.until;
    }
    return { bad, retryAt };
  }
}

/** 进程内单例：池子源健康度（每个 isolate 各自一份，不跨 isolate 共享） */
export const SOURCES = new SourceHealth();

/**
 * 功能：把数组切成每段不超过 n 个。用于「同时打开的连接数」受限的场景
 * （免费计划 connect() 并发上限见 SC.PROBE_CONC）。
 * @param arr 原数组
 * @param n 每段上限
 * @returns 分段后的二维数组；n 非法时按 1 处理
 */
export function chunks<T>(arr: T[], n: number): T[][] {
  const lim = Math.max(1, Math.floor(n) || 1);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += lim) out.push(arr.slice(i, i + lim));
  return out;
}

/**
 * 功能：池子源列表：env.poolSrc 优先，非法项回退内置 6 个源。
 * @param env 环境变量
 * @returns 源 URL 数组
 */
export function poolSources(env: Env): string[] {
  const custom = String(env.poolSrc || "").trim();
  if (!custom) return POOL_SOURCES;
  const list = custom.split(/[,\s]+/).filter((x) => /^https?:\/\//.test(x));
  // 只取前 REFILL_MAX 条：rank / 冷却记账与实际抓取必须是同一个集合，多出来的源等于没配
  return list.length ? list.slice(0, REFILL_MAX) : POOL_SOURCES;
}

/**
 * 功能：按源健康度顺序抓取并合并去重（失败的源排到最后，不删除）。
 *
 * 冷却中的源在已经抓到足够条目时会**直接跳过**（`skip: true`，记 `srcSkip`）：
 * 只调顺序、照抓不误的话，冷却从来没省下过子请求（免费计划一次调用只有 50 个）。
 * `keep` 是当前池子大小，跳过之后新池子不能比它小太多，否则 `commitPool` 的缩水守卫会拒掉整轮刷新。
 *
 * @param env 环境变量
 * @param keep 当前池子大小（0 表示冷启动，只要够 `POOL_ENOUGH` 就可以跳过冷却源）
 * @returns 本次抓取统计：新增数、总数、每源行数（被跳过的源带 `skip`）
 */
export async function refillPool(env: Env, keep = 0): Promise<PoolRefill> {
  const seen = new Map<string, PoolEntry>();
  const sources: Record<string, { lines: number; ok: number; skip?: boolean }> = Object.create(null);
  // 冷却中的源在「已经抓到足够条目」时直接跳过：rank 只决定先抓谁，
  // 全部照抓的话冷却等于没做（每轮仍然白烧 5 个子请求）。keep 是当前池子大小，
  // 跳过之后新池子不能比它小太多，否则 commitPool 的缩水守卫会拒掉整轮刷新。
  const enough = Math.max(POOL_ENOUGH, Math.ceil(keep * 0.75));
  for (const src of SOURCES.rank(env)) {
    if (seen.size >= enough && SOURCES.cooling(src)) {
      sources[src] = { lines: 0, ok: 0, skip: true };
      cnt("srcSkip");
      continue;
    }
    let lines = 0;
    const before = seen.size;
    try {
      const r = await fetch(src, {
        signal: timeoutSignal(10000),
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
    SOURCES.note(src, lines >= 0);
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

// ---- 并入自 rawprobe.ts ----
// 原始 TLS 探活：一条候选到底能不能中转。
// probeProxy 用「证书链里有没有 cloudflare」判开放反代；probeSni 用手写 ClientHello 看目标会不会回
// ServerHello（诊断「某节点能不能把这个站转出去」）。两者都不完成握手 —— 那需要自己实现密钥交换。


/* 代理节点：探活与池子抓取 */
export const PROBE_HELLO = (() => {
  const hx =
    "16030100d2010000ce030380f2b59e000bbca2041abbd20c3ad59999e3ee3a101aa9956fc2b767da0a0b36000038c02cc030009fcca9cca8ccaac02bc02f009ec024c028006bc023c0270067c00ac0140039c009c0130033009d009c003d003c0035002f00ff0100006d0000001700150000127777772e636c6f7564666c6172652e636f6d000b000403000102000a000c000a001d0017001e00190018002300000016000000170000000d002a0028040305030603080708080809080a080b080408050806040105010601030303010302040205020602";
  const a = new Uint8Array(hx.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hx.substr(i * 2, 2), 16);
  return a;
})();

/**
 * 一次原始探测的会话：建连 → 写报文 → 按预算收首段字节。两条探测（开放反代 / SNI）除
 * 「首段字节怎么判」外完全一样，所以六个预算数字与「迟到连上要关」只在这里写一遍。
 */
export class RawProbe {
  private sock: Socket | null = null;
  private startedAt = 0;
  private connectedAt = 0;
  /** @param host 候选主机 @param port 候选端口 @param gate 建连额度闸门（默认不限额） */
  constructor(readonly host: string, readonly port: number, private readonly gate: CallGate = CallGate.unlimited()) {}

  /** 建连；IPv4 字面量在 Workers 上常连不上时，可按需退回 sslip.io 让 DNS 承担一次。 */
  async open(sslipFallback = false): Promise<void> {
    this.startedAt = Date.now();
    try {
      this.sock = await this.gate.openSocket(this.host, this.port);
    } catch (e0) {
      if (!sslipFallback || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(this.host)) throw e0;
      this.sock = await this.gate.openSocket(this.host + ".sslip.io", this.port);
    }
    this.connectedAt = Date.now();
  }
  /** 建连耗时（毫秒）：纯网络 RTT。 */
  get tcpMs(): number {
    return Math.max(0, this.connectedAt - this.startedAt);
  }
  /** 从发起到此刻的耗时（毫秒）。 */
  get elapsedMs(): number {
    return Math.max(0, Date.now() - this.startedAt);
  }

  /** 写出探测报文：`connect()` 是惰性的，真正的建连发生在第一次写，所以必须有时限。 */
  async send(bytes: Uint8Array, budgetMs: number): Promise<void> {
    if (!this.sock) throw new Error("probe socket not open");
    const w = this.sock.writable.getWriter();
    // 结算后无论成败都要放锁，否则下一次写会撞上 "writer locked"
    await withTimeout(w.write(bytes), budgetMs, "timeout").finally(() => w.releaseLock());
  }

  /**
   * 读到够用、到点或对端断开为止。
   * @param maxBytes 收够就不等（反代探测要读到证书，SNI 探测只要 8 字节）
   * @param budgetMs 本轮总预算
   * @param waitFloorMs 单次读的最小等待，避免剩余时间归零时立刻空转
   * @param done 可选提前结束判据，每段重算（必须幂等）
   * @returns 已收到的字节（可能为空）
   */
  async peek(maxBytes: number, budgetMs: number, waitFloorMs: number, done?: (buf: Uint8Array) => boolean): Promise<Uint8Array> {
    if (!this.sock) return new Uint8Array(0);
    const r = this.sock.readable.getReader();
    const deadline = Date.now() + budgetMs;
    let buf = new Uint8Array(0);
    try {
      while (Date.now() < deadline && buf.length < maxBytes && !(done && done(buf))) {
        const wait = Math.max(waitFloorMs, deadline - Date.now());
        let got: { value?: Uint8Array } | null = null;
        try {
          got = (await withTimeout(r.read(), wait, "timeout")) as { value?: Uint8Array };
        } catch (e) {
          break; // 超时/断开：跳出，交给调用方按已有字节出结论
        }
        const v = got && got.value;
        if (!v || !v.length) break;
        // 分片长度不定，拼成连续内存再判报文头
        const merged = new Uint8Array(buf.length + v.length);
        merged.set(buf, 0);
        merged.set(v, buf.length);
        buf = merged;
      }
    } finally {
      try {
        r.releaseLock();
      } catch (e) {
        // 读端已随 socket 一起关掉
      }
    }
    return buf;
  }

  /** 关掉底层 socket：迟到连上的也要关，否则会一直占着 `connect()` 名额。 */
  close(): void {
    try {
      if (this.sock) this.sock.close();
    } catch (e) {} // 已经关了
    this.sock = null;
  }
}
/**
 * 探测某个候选是否为开放反代：TLS 握手后看证书链里是否出现 cloudflare。
 * @param {string} h 候选主机
 * @param {number} p 候选端口
 * @returns {Promise<{h:string,p:number,ms:number,ts:number,bad?:string}|null>} 成功返回节点信息，失败返回 null
 */
export async function probeProxy(h: string, p: number, gate: CallGate = CallGate.unlimited()) {
  if (checkTarget(h, p)) return null; // 纵深防御：任何路径都不许探内网
  const probe = new RawProbe(h, p, gate);
  try {
    await probe.open(true);
    const tcp = probe.tcpMs; // ① 建连：纯网络 RTT
    await probe.send(PROBE_HELLO, CONNECT_MS);
    // 已能下结论（不是 TLS 或已看到 cf 证书）就不再等下一段，否则 ms 会被拖长
    const buf = await probe.peek(8192, 4000, 200, (b) => b.length > 0 && (b[0] !== 0x16 || /cloudflare/i.test(dec.decode(b))));
    const ms = probe.elapsedMs;
    if (buf.length && buf[0] !== 0x16) return { h, p, ms, tcp, tls: 0, ts: Date.now(), bad: "not-tls", head: toHex(buf.slice(0, 16)) };
    if (buf.length && /cloudflare/i.test(dec.decode(buf))) {
      // ② TLS 往返：建连完成到收到第一段证书字节。丢包会让这段异常变长。
      return { h, p, ms, tcp, tls: Math.max(0, ms - tcp), ts: Date.now() };
    }
    return { h, p, ms, tcp, tls: 0, ts: Date.now(), bad: "no-cf-cert", len: buf.length, head: toHex(buf.slice(0, 24)) };
  } catch (e) {
    return null;
  } finally {
    probe.close();
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
export async function probeSni(nodeHost: string, nodePort: number, sni: string, ms = CONNECT_MS, gate: CallGate = CallGate.unlimited()): Promise<SniProbe> {
  if (checkTarget(nodeHost, nodePort)) return { err: "denied" };
  const probe = new RawProbe(nodeHost, nodePort, gate);
  try {
    // 注意：Workers 的 connect() 是惰性的，真正的 TCP 建连发生在第一次 write/read，
    // 所以这里不单独报 tcp，只报"从发起到收到 ServerHello"的总耗时。
    await probe.open(false);
    await probe.send(tlsHello(sni), ms);
    // 只要 8 字节：够判「是不是 TLS 记录」就停，剩下的等下去只会拖长诊断
    const buf = await probe.peek(8, ms, 150, (x) => x.length >= 8);
    if (!buf.length) return { err: "no-data" };
    if (buf[0] !== 0x16) return { err: "not-tls", head: toHex(buf.slice(0, 8)) };
    return { hs: probe.elapsedMs, err: "" };
  } catch (e) {
    return { err: "tcp" };
  } finally {
    probe.close();
  }
}

// ---- 并入自 geo.ts ----
// 地理标注：批量问第三方免费接口拿两位国家码（单次最多 100 个），查不到就不打标。


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
      signal: timeoutSignal(5000),
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

// ---- 并入自 failpolicy.ts ----
// 失败阈值策略：连续失败几次判坏、失败到几次无视驻留时间强制换（都可用 env 覆盖）。


// 换节点策略（可用环境变量覆盖；驻留时间见 selector.dwellOf）
//   pxFailMax  : 连续失败多少次才允许换（默认 3）
//   pxForceAt  : 失败到这个数就无视驻留强制换（默认 5）
/**
 * 读取失败阈值策略（可用 env 覆盖）。
 * @param {object} env Worker 环境
 * @returns {{fail:number, force:number}} 失败阈值、强制换阈值
 */
export function pxPolicy(env: Env) {
  const f = Number(env.pxFailMax);
  const x = Number(env.pxForceAt);
  return {
    fail: Number.isFinite(f) && f > 0 ? f : 3,
    force: Number.isFinite(x) && x > 0 ? x : 5,
  };
}

// ---- 门面（对外导出面保持不变） ----
// 探活与池子抓取的门面：`probe.ts` 曾经 524 行、把四件事挤在一起，现在只做再导出。
// 实现分别在 ./poolsrc（源清单与抓取）、./rawprobe（原始 TLS 探活）、
// ./geo（国家码）、./failpolicy（失败阈值策略）—— 调用点与单测一行都不用改。

