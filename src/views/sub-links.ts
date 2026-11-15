import { X_EDGE_IPS, loadNodes, nodeLabel, nodePath, orderNodes, pickProtos, regionEntries, trojanPasswordOf } from "./sub-common";

/**
 * 功能：渲染「链接列表」形式的订阅（每行一条 vless/trojan URL）。
 * @param o 订阅输入（主机、端口、凭据等）
 * @returns 纯文本
 */
export function renderLinks(
  env: Env,
  url: URL,
  id: string,
  host: string,
  learned: Record<string, RttEntry> = {},
  regions: string[] = [],
  auth?: Auth,
) {
  const nodes = orderNodes(loadNodes(env, host), learned);
  const pass = trojanPasswordOf(env, id, auth);
  const protos = pickProtos(env, url, Boolean(pass));
  const lines = [];
  // 链接格式没有 `ip-version` 之类的开关，钉 IPv4 只能靠把 server 写成 IP 字面量，
  // 再把 `host=` / `sni=` 指回域名（TLS 与 WS 路由都不变）——这和 Clash 里
  // `server: <ip> + servername: <域名>` 是同一手法。不钉的话，客户端在双栈网络上
  // 会把域名解析成 AAAA，CF→CF 把 v6 出口原样透传给目标，直接吃 4 字节 403。
  const manual = String(env.nodes || "").trim();
  const noEdge = Boolean(manual) || url.searchParams.get("e") === "0";
  const edgeIps = noEdge ? [] : X_EDGE_IPS.slice(0, 8);
  // 轮转分配：同一个入口的 443/8443 落到不同边缘 IP 上，用户手动切就有得挑
  let ei = 0;
  const pickEdge = (fallback: string) => (edgeIps.length ? String(edgeIps[ei++ % edgeIps.length]) : fallback);

  // 和 Clash / sing-box 对齐：每个入口出两套（吞吐优先 T / 速率优先 L），
  // 否则明文订阅只有服务端默认模式，客户端根本选不了。
  for (const mode of ["tput", "lat"]) {
    const suffix = mode === "lat" ? "L" : "T";
    for (const proto of protos) {
      for (const n of nodes) {
        if (proto === "trojan" && !pass) continue;
        const q = [
          "encryption=none",
          `security=${n.tls ? "tls" : "none"}`,
          "type=ws",
          `host=${encodeURIComponent(host)}`,
          n.tls ? `sni=${encodeURIComponent(host)}` : "",
          `path=${encodeURIComponent(`${nodePath(n)}&mode=${mode}`)}`,
          `#${encodeURIComponent(`${proto}-${nodeLabel(n)}-${suffix}`)}`,
        ]
          .filter(Boolean)
          .join("&");
        const srv = pickEdge(n.host);
        if (proto === "vless") lines.push(`vless://${id}@${srv}:${n.port}?${q}`);
        else lines.push(`trojan://${encodeURIComponent(pass)}@${srv}:${n.port}?${q}`);
      }
    }
  }
  for (const e of regionEntries(regions, host, pass, protos, url)) {
    const q = [
      "encryption=none",
      "security=tls",
      "type=ws",
      `host=${encodeURIComponent(host)}`,
      `sni=${encodeURIComponent(host)}`,
      `path=${encodeURIComponent(e.path)}`,
      `#${encodeURIComponent(e.name)}`,
    ].join("&");
    const srv = pickEdge(host);
    if (e.proto === "vless") lines.push(`vless://${id}@${srv}:${e.port}?${q}`);
    else lines.push(`trojan://${encodeURIComponent(pass)}@${srv}:${e.port}?${q}`);
  }
  return btoa(lines.join("\n"));
}
