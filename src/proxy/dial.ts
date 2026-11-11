import { S } from "../core/state";
import { connect } from "cloudflare:sockets";

/* 出站网络：DNS / 三级拨号 / 目标校验 */
export const DENY_PORTS = new Set([
  23, 25, 135, 137, 138, 139, 445, 465, 587, 1433, 1521, 2049, 3306, 3389, 5432, 5900, 6379,
  9200, 11211, 27017,
]);

/**
 * 判断主机名/IP 是否属于内网、回环、链路本地、CGNAT、组播等禁止访问的地址。
 * @param {string} h 主机名或 IP 字面量
 * @returns {boolean} 命中保留地址返回 true
 */
export function isPrivateHost(h: string) {
  if (!h) return true;
  // 末尾的点（FQDN 写法）、方括号 IPv6 都要先归一化，否则 localhost. 能绕过
  let host = String(h).toLowerCase().trim().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return true;

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;

  if (host.includes(":")) {
    // IPv6
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(host)) return true;    // 组播
    if (/^2001:db8:/.test(host)) return true;         // 文档保留
    if (/^2002:/.test(host)) return true;             // 6to4，可编码内网 v4
    // NAT64（含本服务自己用的前缀）：可把 127.0.0.1 编成公网 IPv6
    if (/^64:ff9b::/.test(host) || /^2001:67c:2960:6464:/.test(host)) return true;
    if (host.startsWith("::ffff:")) {
      const rest = host.slice(7);
      if (rest.includes(".")) return isPrivateHost(rest);
      // ::ffff:7f00:1 这种十六进制写法等价于 127.0.0.1
      const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
      if (hx) {
        const hi = parseInt(hx[1], 16), lo = parseInt(hx[2], 16);
        return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
      return true;
    }
    return false;
  }

  // 非规范 IPv4 写法：127.1 / 2130706433 / 0x7f000001 / 0177.0.0.1
  // 这些在 inet_aton 眼里都是 IPv4，正则只认四段十进制会漏掉
  if (/^0x[0-9a-f]+$/.test(host) || /^\d+$/.test(host)) return true;
  if (/^[\d.]+$/.test(host)) {
    const parts = host.split(".");
    if (parts.length !== 4 || parts.some((p) => !p || !/^\d+$/.test(p))) return true;
    if (parts.some((p) => (p.length > 1 && p[0] === "0") || Number(p) > 255)) return true;
  }

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false; // 域名，交给 DNS

  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;  // 192.0.0/24 / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;           // 基准测试
  if (a === 198 && b === 51 && c === 100) return true;            // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;             // TEST-NET-3
  if (a === 192 && b === 88 && c === 99) return true;             // 6to4 中继
  if (a >= 224) return true; // 组播/保留
  return false;
}

/**
 * 连接目标的总闸：校验端口策略与地址是否允许外连（防 SSRF）。
 * @param {string} host 目标主机
 * @param {number} port 目标端口
 * @returns {string|null} 不允许时返回中文原因，允许返回 null
 */
export function checkTarget(host: string, port: number) {
  if (!host) return "空目标";
  if (!(port > 0 && port < 65536)) return "端口非法";
  if (DENY_PORTS.has(port)) return `端口 ${port} 被策略禁止`;
  if (isPrivateHost(host)) return `目标 ${host} 属于内网/保留地址`;
  return null;
}


/** 查 AAAA 记录（用于绕过 CF 对 IPv4 的内部隔离） */
export const DOH_ENDPOINTS = [
  "https://dns.google/resolve",                 // 非 CF，优先
  "https://1.1.1.1/dns-query",                  // CF
  "https://doh.pub/dns-query",                  // 腾讯
];

/**
 * 通过 DoH 依次尝试多个解析服务查询 DNS 记录。
 * @param {string} domain 域名
 * @param {'A'|'AAAA'} type 记录类型
 * @returns {Promise<string|null>} 解析到的地址，全部失败返回 null
 */
export async function dohQuery(domain: string, type: "A" | "AAAA") {
  for (const base of DOH_ENDPOINTS) {
    try {
      const url = `${base}?name=${encodeURIComponent(domain)}&type=${type}`;
      const r = await fetch(url, { headers: { accept: "application/dns-json" } });
      if (!r.ok) continue;
      const j = await r.json();
      const want = String(type).toUpperCase() === "AAAA" ? 28 : 1;
      const rec = ((j.Answer || []) as DohAnswer[]).find((x) => x.type === want);
      if (rec && rec.data) return rec.data;
    } catch (e) {
      /* 换下一个 */
    }
  }
  return null;
}

/**
 * 解析域名的 AAAA 记录（带 5 分钟内存缓存）。
 * @param {string} domain 域名
 * @returns {Promise<string|null>} IPv6 地址或 null
 */
export async function resolveAAAA(domain: string) {
  const hit = S.aaaaCache.get(domain);
  if (hit && Date.now() - hit.t < 300000) return hit.ip;
  const ip = await dohQuery(domain, "AAAA");
  if (!ip) return null;
  if (S.aaaaCache.size > 500) S.aaaaCache.clear();
  S.aaaaCache.set(domain, { ip, t: Date.now() });
  return ip;
}

export const isV6Literal = (h: string) => typeof h === "string" && h.includes(":");

/**
 * 把压缩写法的 IPv6 展开成 8 段完整形式（connect() 对压缩形式不友好）。
 * @param {string} a IPv6 字符串
 * @returns {string} 展开后的 IPv6
 */
export function expandV6(a: string) {
  if (!a.includes("::")) return a;
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = 8 - h.length - t.length;
  return [...h, ...Array(Math.max(0, fill)).fill("0"), ...t].join(":");
}

/**
 * 解析域名的 A 记录（带 5 分钟内存缓存）；无记录时抛错。
 * @param {string} domain 域名
 * @returns {Promise<string>} IPv4 地址
 */
export async function resolveV4(domain: string) {
  const hit = S.dnsCache.get(domain);
  if (hit && Date.now() - hit.t < 300000) return hit.ip;
  const ip = await dohQuery(domain, "A");
  if (!ip) throw new Error("DNS 无 A 记录");
  if (S.dnsCache.size > 500) S.dnsCache.clear();
  S.dnsCache.set(domain, { ip, t: Date.now() });
  return ip;
}

/**
 * 把 IPv4 地址编码进公共 NAT64 前缀，得到可用 IPv6 地址。
 * @param {string} ip 点分 IPv4
 * @returns {string} 形如 [2001:67c:2960:6464::xxxx:xxxx] 的地址
 */
export function nat64FromV4(ip: string) {
  const p = ip.split(".").map((x) => Number(x).toString(16).padStart(2, "0"));
  if (p.length !== 4) throw new Error("IPv4 非法");
  return `[2001:67c:2960:6464::${p[0]}${p[1]}:${p[2]}${p[3]}]`;
}

export const isV4Literal = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

/**
 * 解析 proxyip 配置字符串。
 * @param {string} raw 支持 "host" / "host:port" / "[v6]:port"
 * @returns {{host: string, port: number}|null} 解析结果，空串返回 null
 */
export function parseProxyIp(raw: string) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (m6) return { host: m6[1], port: Number(m6[2]) || 443 };
  const i = s.lastIndexOf(":");
  if (i > 0 && /^\d+$/.test(s.slice(i + 1))) return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
  return { host: s, port: 443 };
}

/**
 * 三级拨号：原样连接 → sslip.io 编码 → NAT64，任一成功即返回。
 * @param {string} host 目标主机
 * @param {number} port 目标端口
 * @returns {Promise<Socket>} 已建立的连接
 */
export async function dial(host: string, port: number) {
  let lastErr = null;

  try {
    return await connect({ hostname: host, port });
  } catch (e) {
    lastErr = e;
  }

  if (isV4Literal(host)) {
    try {
      return await connect({ hostname: `${host}.sslip.io`, port });
    } catch (e) {
      lastErr = e;
    }
  }

  let v4 = null;
  if (isV4Literal(host)) {
    v4 = host;
  } else {
    try {
      v4 = await resolveV4(host);
    } catch (_) {
      throw lastErr || new Error("目标解析失败");
    }
  }
  // DNS 可能把域名解析到内网/元数据地址：NAT64 编码之前必须再验一次
  if (isPrivateHost(v4)) throw lastErr || new Error("目标解析到内网地址");
  return await connect({ hostname: nat64FromV4(v4), port });
}

/* ==================================================================
 * §6.1  流量统计
 * ================================================================== */

