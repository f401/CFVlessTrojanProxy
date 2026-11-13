import { loadNodes, nodeLabel, nodePath, orderNodes, pickProtos, regionEntries, trojanPasswordOf } from "./sub-common";

export function renderSingbox(
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
  const outs = [];
  const byMode: Record<string, string[]> = { lat: [], tput: [] };
  const tags = [];
  const G_LAT = "\u26a1 \u901f\u7387\u4f18\u5148";
  const G_TPUT = "\ud83d\ude80 \u541e\u5410\u4f18\u5148";
  const G_MAN = "\ud83c\udfaf \u624b\u52a8";
  const G_REG = "\ud83c\udf0d \u5730\u533a";
  const regNames: string[] = [];

  for (const mode of ["tput", "lat"]) {
    const suffix = mode === "lat" ? "L" : "T";
    for (const proto of protos) {
      for (const n of nodes) {
        if (proto === "trojan" && !pass) continue;
        const tag = `${proto}-${nodeLabel(n)}-${suffix}`;
        tags.push(tag);
        byMode[mode].push(tag);
        const o: Record<string, unknown> = {
          type: proto,
          tag,
          server: n.host,
          server_port: n.port,
    domain_strategy: "ipv4_only",
          tls: n.tls ? { enabled: true, server_name: host } : { enabled: false },
          transport: { type: "ws", path: `${nodePath(n)}&mode=${mode}`, headers: { Host: host } },
        };
        if (proto === "vless") o.uuid = id;
        else o.password = pass;
        outs.push(o);
      }
    }
  }

  for (const e of regionEntries(regions, host, pass, protos, url)) {
    tags.push(e.name);
    regNames.push(e.name);
    const o: Record<string, unknown> = {
      type: e.proto,
      tag: e.name,
      server: e.server,
      server_port: e.port,
    domain_strategy: "ipv4_only",
      tls: { enabled: true, server_name: host },
      transport: { type: "ws", path: e.path, headers: { Host: host } },
    };
    if (e.proto === "vless") o.uuid = id;
    else o.password = pass;
    outs.push(o);
  }

  const pick = (arr: string[], n: number) => arr.slice(0, Math.max(1, Math.min(n, arr.length)));
  const groups = [
    {
      type: "urltest",
      tag: G_TPUT,
      outbounds: pick(byMode.tput, 5),
      url: "http://www.gstatic.com/generate_204",
      interval: "5m",
      tolerance: 30,
    },
    ...(regNames.length
      ? [
          {
            type: "selector",
            tag: G_REG,
            outbounds: regNames,
          },
        ]
      : []),
    {
      type: "urltest",
      tag: G_LAT,
      outbounds: pick(byMode.lat, 5),
      url: "http://www.gstatic.com/generate_204",
      interval: "5m",
      tolerance: 30,
    },
    {
      type: "selector",
      tag: G_MAN,
      outbounds: [G_TPUT, G_LAT, ...(regNames.length ? [G_REG] : []), ...tags, "direct"],
    },
  ];

  return JSON.stringify(
    {
      log: { level: "info" },
      dns: {
        servers: [
          { tag: "dns_local", address: "223.5.5.5" },
          { tag: "dns_remote", address: "https://1.1.1.1/dns-query", detour: G_MAN },
        ],
        final: "dns_remote",
      },
      inbounds: [{ type: "tun", tag: "tun-in", address: ["172.19.0.1/30"], auto_route: true, strict_route: true }],
      outbounds: [...groups, ...outs, { type: "direct", tag: "direct" }],
      route: { final: G_MAN, auto_detect_interface: true },
    },
    null,
    2,
  );
}
