import { loadNodes, nodeLabel, nodePath, orderNodes, pickProtos, regionEntries, trojanPasswordOf } from "./sub-common";

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
        if (proto === "vless") lines.push(`vless://${id}@${n.host}:${n.port}?${q}`);
        else lines.push(`trojan://${encodeURIComponent(pass)}@${n.host}:${n.port}?${q}`);
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
    if (e.proto === "vless") lines.push(`vless://${id}@${host}:${e.port}?${q}`);
    else lines.push(`trojan://${encodeURIComponent(pass)}@${host}:${e.port}?${q}`);
  }
  return btoa(lines.join("\n"));
}

