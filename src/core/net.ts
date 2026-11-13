/* 出站目标校验：纯函数，不依赖 sockets / 业务状态 */

export const DENY_PORTS = new Set([
  23, 25, 135, 137, 138, 139, 445, 465, 587, 1433, 1521, 2049, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017,
]);

/** 把 IPv6 字面量拆成 8 个 16 位分组；解析不了返回 null（调用方按危险处理） */
function v6Words(raw: string): number[] | null {
  // 去掉 zone id（fe80::1%eth0），并处理尾部点分 IPv4
  let s = raw.split("%")[0];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const p = dotted[2].split(".").map(Number);
    if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return null;
    s = dotted[1] + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const at = s.indexOf("::");
  let parts: string[];
  if (at >= 0) {
    if (s.indexOf("::", at + 1) >= 0) return null;
    const head = s.slice(0, at).split(":").filter(Boolean);
    const tail = s
      .slice(at + 2)
      .split(":")
      .filter(Boolean);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = [...head, ...Array(fill).fill("0"), ...tail];
  } else {
    parts = s.split(":");
  }
  if (parts.length !== 8) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out;
}

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
    // 必须按数值判断：字符串前缀挡不住 0:0:0:0:0:0:0:1 / ::7f00:1 这些写法
    const w = v6Words(host);
    if (!w) return true;
    const v4 = () => `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
    // IPv4-mapped ::ffff:0:0/96（含展开写法）
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
      return isPrivateHost(v4());
    }
    // :: / ::1 / IPv4-compatible ::a.b.c.d
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
      if (w[6] === 0 && w[7] <= 1) return true;
      return isPrivateHost(v4());
    }
    if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((w[0] & 0xff00) === 0xff00) return true; // ff00::/8 组播
    if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // 2001:db8::/32 文档
    if (w[0] === 0x2002) return true; // 6to4，可编码内网 v4
    // NAT64（含本服务自己用的前缀）：可把 127.0.0.1 编成公网 IPv6
    if (w[0] === 0x0064 && w[1] === 0xff9b) return true;
    if (w[0] === 0x2001 && w[1] === 0x067c && w[2] === 0x2960 && w[3] === 0x6464) return true;
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
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24 / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 中继
  if (a >= 224) return true; // 组播/保留
  return false;
}

/**
/* ==================================================================
 * §Cloudflare 网段
 *   用途：目标站落在 CF 网段 → 从 Worker 直连会撞自家边缘（回环/风控），
 *   应改走 proxyip。名单来自 cloudflare.com/ips-v4，只做 IPv4（解析走 A 记录）。
 * ================================================================== */
const CF_V4: Array<[number, number]> = [
  [2918526976, 20], // 173.245.48.0/20
  [1729491968, 22], // 103.21.244.0/22
  [1729546240, 22], // 103.22.200.0/22
  [1730085888, 22], // 103.31.4.0/22
  [2372222976, 18], // 141.101.64.0/18
  [1822605312, 18], // 108.162.192.0/18
  [3193827328, 20], // 190.93.240.0/20
  [3161612288, 20], // 188.114.96.0/20
  [3320508416, 22], // 197.234.240.0/22
  [3324608512, 17], // 198.41.128.0/17
  [2728263680, 15], // 162.158.0.0/15
  [1745879040, 13], // 104.16.0.0/13
  [1746403328, 14], // 104.24.0.0/14
  [2889875456, 13], // 172.64.0.0/13
  [2197833728, 22], // 131.0.72.0/22
];

/**
 * 这个 IPv4 是否属于 Cloudflare 的公开网段。
 * @param {string} ip 点分 IPv4
 * @returns {boolean} 属于返回 true
 */
export function isCfIp(ip: string) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ""))) return false;
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.some((n) => n < 0 || n > 255)) return false;
  const v = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  for (const [base, bits] of CF_V4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((v & mask) >>> 0) === ((base & mask) >>> 0)) return true;
  }
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
