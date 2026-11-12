import { S } from "../core/state";
import { connect } from "cloudflare:sockets";
import { timeoutSignal } from "../core/util";
import { isPrivateHost } from "../core/net";
export { DENY_PORTS, checkTarget, isPrivateHost } from "../core/net";

/** 查 AAAA 记录（用于绕过 CF 对 IPv4 的内部隔离） */
export const DOH_ENDPOINTS = [
  "https://dns.google/resolve", // 非 CF，优先
  "https://1.1.1.1/dns-query", // CF
  "https://doh.pub/dns-query", // 腾讯
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
      const r = await fetch(url, { signal: timeoutSignal(5000), headers: { accept: "application/dns-json" } });
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
  const seg = String(ip).split(".").map(Number);
  if (seg.length !== 4 || seg.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) {
    throw new Error("IPv4 非法");
  }
  const p = seg.map((x) => x.toString(16).padStart(2, "0"));
  return `[2001:67c:2960:6464::${p[0]}${p[1]}:${p[2]}${p[3]}]`;
}

// 四段 0–255：以前允许 999，会生成 "…::3e7:…" 这种畸形 NAT64 地址
export const isV4Literal = (h: string) =>
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(h);

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
