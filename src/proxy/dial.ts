import { S } from "../core/state";
import { connect } from "cloudflare:sockets";
import { CONNECT_MS, timeoutSignal, withTimeout } from "../core/util";
import { isCfIp, isPrivateHost } from "../core/net";
import { splitRelay } from "../core/http80";
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
 * 功能：判断站点是否配了 AAAA 记录 —— 唯一能「确证纯 v4」的廉价手段。
 * 与 `dohQuery` 的区别：它把「查到了但为空」与「一个 DoH 都没响应」分开，
 * 因为前者是事实（站点确实没有 v6 地址），后者只是抖动（不能当事实写）。
 * @param host 站点主机名
 * @returns {Promise<{ v6: boolean, answered: boolean }>} v6=是否有 AAAA；answered=是否至少一个 DoH 正常应答
 */
export async function probeFam(host: string): Promise<{ v6: boolean; answered: boolean }> {
  for (const base of DOH_ENDPOINTS) {
    try {
      const url = `${base}?name=${encodeURIComponent(host)}&type=AAAA`;
      const r = await fetch(url, { signal: timeoutSignal(5000), headers: { accept: "application/dns-json" } });
      if (!r.ok) continue;
      const j = await r.json();
      // Status: 0 = NOERROR（应答应可信）→ 此时「没有 AAAA 记录」是事实；
      // 其他状态（NXDOMAIN / SERVFAIL）只说明这次查询没结论。
      if (Number(j.Status ?? -1) !== 0) continue;
      const rec = ((j.Answer || []) as DohAnswer[]).find((x) => x.type === 28 && !!x.data);
      return { v6: !!rec, answered: true };
    } catch (e) {
      /* 换下一个 DoH */
    }
  }
  return { v6: false, answered: false };
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

/**
 * 解析域名的全部 A 记录（最多 4 条，带 10 分钟缓存）。
 * 单个 A 记录可能指向已黑洞的边缘 IP，多试几个能显著提升成功率。
 * @param {string} domain 域名
 * @returns {Promise<string[]>} IPv4 列表（可能为空）
 */
export async function resolveV4All(domain: string): Promise<string[]> {
  const hit = S.v4AllCache.get(domain);
  if (hit && Date.now() - hit.t < 600000) return hit.ips;
  const ips: string[] = [];
  for (const base of DOH_ENDPOINTS) {
    try {
      const url = `${base}?name=${encodeURIComponent(domain)}&type=A`;
      const r = await fetch(url, { signal: timeoutSignal(5000), headers: { accept: "application/dns-json" } });
      if (!r.ok) continue;
      const j = await r.json();
      for (const a of (j.Answer || []) as DohAnswer[]) {
        if (a.type === 1 && a.data && /^\d{1,3}(\.\d{1,3}){3}$/.test(a.data) && !ips.includes(a.data)) ips.push(a.data);
      }
      if (ips.length) break;
    } catch (e) {
      /* 换下一个 DoH */
    }
  }
  if (!ips.length) return [];
  if (S.v4AllCache.size > 300) S.v4AllCache.clear();
  S.v4AllCache.set(domain, { ips, t: Date.now() });
  return ips;
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
  // 拆法必须与 core/http80 的 splitRelay 一致：裸 IPv6 自带冒号，
  // 内联 `lastIndexOf` 会把 `2a06:98c0::103` 读成主机 `2a06:98c0:` + 端口 103。
  const [host, port] = splitRelay(s, 443);
  return { host, port };
}

/**
 * 三级拨号：原样连接 → sslip.io 编码 → NAT64，任一成功即返回。
 * @param {string} host 目标主机
 * @param {number} port 目标端口
 * @returns {Promise<Socket>} 已建立的连接
 */
export async function dial(host: string, port: number) {
  let lastErr = null;

  // IPv4 优先（仅 443）：connect({ hostname }) 走 A 还是 AAAA 由运行时决定，而 CF 边缘对「来自 CF
  // 网络的 IPv6 连接」会直接回纯文本 403 `IPv6`（x.com 这类 CF 托管站必撞）。先取 A 记录连字面量，
  // 等于把出口钉在 IPv4；DoH 拿不到结果时照旧走下面的三级，不会卡住主路径。
  // 只对 443 生效：明文 80 没有这个问题，而 DoH 会多一次子请求。
  if (port === 443 && !isV6Literal(host)) {
    const s4 = await dial4(host, port, 1500);
    if (s4) return s4;
  }

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

/** 用一次 HTTP 请求判定「本 isolate 的出口」访问该站点会被怎么对待。
 *  返回 {code, colo}：code 0 表示连 HTTP 都没拿到（当作未知）。
 *  只在 CF 托管目标上用：这些站点会把我们的出口 IP 透传给源站，403 就是被按 IP 拒。 */
export async function httpProbe(host: string, ms = CONNECT_MS): Promise<{ code: number; colo: string }> {
  try {
    const r = await withTimeout(
      fetch(`https://${host}/`, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36" },
      }),
      ms,
    );
    // cf-ray 尾部是机房码（HKG 之类），只作诊断；403 表示本出口被该站按 IP 拒了
    const ray = (r.headers.get("cf-ray") || "").split("-").pop() || "";
    return { code: r.status, colo: ray };
  // 连不上 / DNS 失败一律返回 0：调用方把 0 当「未知」，不会据此封任何通道
  } catch (e) {
    return { code: 0, colo: "" };
  }
}
/**
 * 功能：判断目标是否 CF 托管（A 记录落在 CF 网段）。DoH 失败一律按「否」处理，宁可多试一次直连。
 * @param host 目标主机名或 IP 字面量
 * @returns 是 CF 托管为 true
 */
export async function isCfHost(host: string) {
  if (isV4Literal(host)) return isCfIp(host);
  let ips: string[] = [];
  try {
    ips = await resolveV4All(host);
  } catch {
    return false; // 解析失败不能挡住直连
  }
  for (const ip of ips) if (isCfIp(ip)) return true;
  return false;
}
/**
 * 功能：解析 A 记录后依次尝试连接，返回第一个连上的 socket（IPv6 环境里强制走 v4 出口）。
 * @param host 目标主机名或 IP
 * @param port 端口
 * @param budget 解析+连接总预算毫秒，0 表示默认 3000
 * @returns socket；全部失败返回 null
 */
export async function dial4(host: string, port: number, budget = 0) {
  const raw = isV4Literal(host) ? [host] : await withTimeout(resolveV4All(host), budget || 3000).catch(() => []);
  const list: string[] = Array.isArray(raw) ? raw : [];
  for (const ip of list.slice(0, 3)) {
    if (!ip || isPrivateHost(ip)) continue;
    try {
      return await connect({ hostname: ip, port });
    } catch (_) {
      /* 换下一个 A 记录：x.com 这类站点有多个边缘 IP，单点失败不代表整站不可达 */
    }
  }
  return null;
}

/* ==================================================================
 * §6.1  流量统计
 * ================================================================== */