/* 出站目标校验：纯函数，不依赖 sockets / 业务状态 */

export const DENY_PORTS = new Set([
  23, 25, 135, 137, 138, 139, 445, 465, 587, 1433, 1521, 2049, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017,
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
    if (/^ff[0-9a-f]{2}:/.test(host)) return true; // 组播
    if (/^2001:db8:/.test(host)) return true; // 文档保留
    if (/^2002:/.test(host)) return true; // 6to4，可编码内网 v4
    // NAT64（含本服务自己用的前缀）：可把 127.0.0.1 编成公网 IPv6
    if (/^64:ff9b::/.test(host) || /^2001:67c:2960:6464:/.test(host)) return true;
    if (host.startsWith("::ffff:")) {
      const rest = host.slice(7);
      if (rest.includes(".")) return isPrivateHost(rest);
      // ::ffff:7f00:1 这种十六进制写法等价于 127.0.0.1
      const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
      if (hx) {
        const hi = parseInt(hx[1], 16),
          lo = parseInt(hx[2], 16);
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
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24 / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 中继
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
