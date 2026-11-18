// 中继地址解析：`host:port` / `[v6]:port` / 裸 IPv6 一律由这里拆。
//
// 7.361 之前这个文件叫 `http80.ts`，因为它还装着「明文 HTTP/80 探测」那份实现；那份实现
// 本质就是一种探测传输，已并入 `src/core/transport.ts` 的 `Http80Transport`（注册名
// `http80`），于是本文件只剩地址解析 —— 名字与内容对不上，改叫 `relay-addr.ts`。

/**
 * 功能：把 `host:port` 拆成主机与端口，认裸 IPv6 与 `[v6]:port` 两种写法。
 *
 * 为什么不能 `split(":")`：IPv6 字面量本身就带冒号，`2a06:98c0::1:443` 会被拆成
 * host=`2a06`、port=`98c0`（→ 80），探测打到完全不相干的主机上。中继列表里的地址
 * 来自客户端与公开源，不能假定是 IPv4。
 * @param raw `host:port` / `[v6]:port` / 裸 host
 * @param defPort 没写端口时的默认端口
 * @returns 主机与端口
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
 * 功能：从 `host:port` / `[v6]:port` / 裸 host 里取出 IP 部分（中继表的键）。
 *
 * 为什么要有它：`ipOf` 这类解析在中继健康表与选路里各写过一份，一份带 `i > 0` 守卫、
 * 一份写成 `slice(0, lastIndexOf(":"))`（键没有冒号时会吃掉最后一个字符），
 * 于是同一张判定表的键在两处对不上；方括号 IPv6 也只有这里统一去掉方括号。
 * @param node 节点或中继地址
 * @returns 不含方括号与端口的 IP；空串原样返回
 */
export function relayIpOf(node: string): string {
  return splitRelay(node, 443)[0];
}
