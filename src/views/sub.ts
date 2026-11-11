import { secretPwd } from "../core/util";

/* sub */
export const DEFAULT_PORTS: Array<[number, boolean]> = [
  [443, true],
  [8443, true],
  [2053, true],
  [80, false],
  [8880, false],
];

/** Cloudflare colo 代码 → 城市中文名（常用部分） */
export const COLO_CITY = {
  HKG: "香港", NRT: "东京", KIX: "大阪", ICN: "首尔", TPE: "台北", KHH: "高雄",
  SIN: "新加坡", BKK: "曼谷", KUL: "吉隆坡", CGK: "雅加达", MNL: "马尼拉",
  SGN: "胡志明", HAN: "河内", DEL: "德里", BOM: "孟买", CCU: "加尔各答",
  SYD: "悉尼", MEL: "墨尔本", AKL: "奥克兰", PER: "珀斯",
  LAX: "洛杉矶", SJC: "圣何塞", SFO: "旧金山", SEA: "西雅图", DFW: "达拉斯",
  ORD: "芝加哥", IAD: "华盛顿", EWR: "纽瓦克", ATL: "亚特兰大", MIA: "迈阿密",
  DEN: "丹佛", PHX: "凤凰城", YYZ: "多伦多", YVR: "温哥华", GRU: "圣保罗",
  EZE: "布宜诺斯艾利斯", SCL: "圣地亚哥", BOG: "波哥大",
  LHR: "伦敦", MAN: "曼彻斯特", AMS: "阿姆斯特丹", FRA: "法兰克福",
  CDG: "巴黎", MAD: "马德里", BCN: "巴塞罗那", MXP: "米兰", FCO: "罗马",
  ZRH: "苏黎世", VIE: "维也纳", ARN: "斯德哥尔摩", CPH: "哥本哈根",
  OSL: "奥斯陆", HEL: "赫尔辛基", WAW: "华沙", PRG: "布拉格", BUD: "布达佩斯",
  BRU: "布鲁塞尔", DUB: "都柏林", LIS: "里斯本", SOF: "索非亚", KBP: "基辅",
  IST: "伊斯坦布尔", DME: "莫斯科", LED: "圣彼得堡", TLV: "特拉维夫",
  DXB: "迪拜", DOH: "多哈", RUH: "利雅得", JNB: "约翰内斯堡", LOS: "拉各斯",
  CAI: "开罗", NBO: "内罗毕", CPT: "开普敦",
};

/** 把入口地址压成可放进 URL 的标签：104.16.0.1 → 104-16-0-1 */
export const tagOf = (h: string) => String(h).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** 节点唯一标签 = 入口 + 端口（同一域名的 443/8443 是两个节点） */
export const nodeTag = (n: SubNode) => `${tagOf(n.host)}-${n.port}`;

/**
 * 解析 env.nodes 配置成入口节点列表（host:port:mode）。
 * @param {object} env Worker 环境
 * @param {string} host 当前请求的 Host
 * @returns {Array<{host:string,port:number,mode:string}>} 节点数组
 */
export function loadNodes(env: Env, host: string): SubNode[] {
  const raw = String(env.nodes || "").trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => {
        const p = s.trim().split(":");
        const h = p[0];
        const port = Number(p[1]);
        const tls = /^(tls|1|true)$/i.test(p[2] || "");
        const name = p[3] || h;
        return h && port ? { host: h, port, tls, name } : null;
      })
      .filter((x): x is SubNode => !!x);
  }
  return DEFAULT_PORTS.map(([port, tls]) => ({ host, port, tls, name: host }));
}

/**
 * 决定订阅里输出哪些协议（vless / trojan / both）。
 * @param {object} env Worker 环境
 * @param {URL} url 请求 URL
 * @param {boolean} hasTrojanOverride 是否被查询参数强制指定
 * @returns {string[]} 协议名数组
 */
export function pickProtos(env: Env, url: URL, hasTrojanOverride?: boolean): string[] {
  const hasTrojan = hasTrojanOverride === undefined
    ? Boolean(secretPwd(env))
    : !!hasTrojanOverride;
  const q = url.searchParams.get("proto");
  if (q === "vless") return ["vless"];
  if (q === "trojan") return hasTrojan ? ["trojan"] : ["vless"];
  return hasTrojan ? ["vless", "trojan"] : ["vless"];
}

/**
 * 取该用户的密码（来自 env.pwd 或 KV 托管记录）。
 * @param {object} env Worker 环境
 * @param {string} id 用户 UUID
 * @returns {string} 密码，没有则空串
 */
export function trojanPasswordOf(env: Env, id: string, auth?: Auth) {
  // 面板创建的用户有自己的密码：优先用用户表，别拿 env 的公共密码去顶
  if (auth && auth.list) {
    const u = auth.list.find((x) => x.id === id);
    if (u && u.pwd) return u.pwd;
    if (u && u.managed) return "";      // 托管用户没密码 → 这个订阅不出 Trojan
  }
  const raw = secretPwd(env);
  if (!raw) return "";
  // 单密码模式：一个公共密码，所有用户共用
  if (!raw.includes(":")) return raw;
  for (const pair of raw.split(",")) {
    const i = pair.indexOf(":");
    if (i < 0) continue;
    if (pair.slice(0, i).trim().toLowerCase() === id) return pair.slice(i + 1).trim();
  }
  return "";
}

/**
 * 按 RTT 学习结果给入口节点排序（快的在前）。
 * @param {Array<object>} nodes 节点数组
 * @param {object} learned RTT 学习结果
 * @returns {Array<object>} 排序后的节点数组
 */
export function orderNodes(nodes: SubNode[], learned: Record<string, RttEntry>): RankedNode[] {
  return nodes
    .map((n: SubNode, i: number) => {
      const info = learned[nodeTag(n)];
      return { ...n, _i: i, _rtt: info && typeof info.rtt === "number" ? info.rtt : null, _colo: (info && info.colo) || "" };
    })
    .sort((a: RankedNode, b: RankedNode) => {
      // 未测过的按"中性值"处理：快的一定在前，慢的排后，未测的居中
      const av = a._rtt == null ? 120 : a._rtt;
      const bv = b._rtt == null ? 120 : b._rtt;
      if (av !== bv) return av - bv;
      return (a._i ?? 0) - (b._i ?? 0);
    });
}

/**
 * 生成节点的展示名（机房-城市）。
 * @param {object} n 节点对象
 * @returns {string} 展示名
 */
export function nodeLabel(n: RankedNode) {
  const tag = nodeTag(n);
  if (n._colo) {
    const city = (COLO_CITY as Record<string, string>)[n._colo] || "";
    return `${n._colo}${city ? "-" + city : ""}-${tag}`;
  }
  return tag;
}

/**
 * 生成节点在 WS 路径里的入口标识。
 * @param {object} n 节点对象
 * @returns {string} 路径标识
 */
export function nodePath(n: RankedNode) {
  return `/?ed=2560&ip=${nodeTag(n)}`;
}

/**
 * 生成订阅里各地区出口的节点定义。
 * @param {string[]} regions 国家码列表
 * @param {string} host 入口域名
 * @param {string} pass Trojan 密码
 * @param {string[]} protos 要输出的协议
 * @returns {Array<object>} 地区节点数组
 */
export function regionEntries(regions: string[], host: string, pass: string, protos: string[]): RegionEntry[] {
  const out: RegionEntry[] = [];
  for (const cc of regions) {
    for (const proto of protos) {
      if (proto === "trojan" && !pass) continue;
      out.push({
        cc,
        proto,
        name: `${proto}-region-${cc}`,
        server: host,
        port: 443,
        path: `/?ed=2560&ip=region-${cc}&rg=${cc.toLowerCase()}`,
      });
    }
  }
  return out;
}

/**
 * 生成 Clash / Mihomo 订阅 YAML。
 * @param {object} env Worker 环境
 * @param {URL} url 请求 URL
 * @param {string} id 用户 UUID
 * @param {string} host 入口域名
 * @param {object} [learned] RTT 学习结果
 * @param {string[]} [regions] 地区列表
 * @returns {string} YAML 文本
 */
export function renderClash(env: Env, url: URL, id: string, host: string, learned: Record<string, RttEntry> = {}, regions: string[] = [], auth?: Auth) {
  const nodes = orderNodes(loadNodes(env, host), learned);
  const pass = trojanPasswordOf(env, id, auth);
  const protos = pickProtos(env, url, Boolean(pass));
  const out: string[] = [];
  const byMode: Record<string, string[]> = { lat: [], tput: [] };
  const all = [];
  const G_LAT = "\u26a1 \u901f\u7387\u4f18\u5148";
  const G_TPUT = "\ud83d\ude80 \u541e\u5410\u4f18\u5148";
  const G_REG = "\ud83c\udf0d \u5730\u533a";
  const G_MAN = "\ud83c\udfaf \u624b\u52a8";

  const emit = (name: string, proto: string, server: string, port: number, path: string, tls: boolean, extra: string) => {
    out.push(`  - name: "${name}"`);
    out.push(`    type: ${proto}`);
    out.push(`    server: ${server}`);
    out.push(`    port: ${port}`);
    if (proto === "vless") out.push(`    uuid: ${id}`);
    else out.push(`    password: "${pass}"`);
    out.push(`    udp: false`);
    out.push(`    tls: ${tls ? "true" : "false"}`);
    if (tls) out.push(`    servername: ${host}`);
    out.push(`    network: ws`);
    out.push(`    ws-opts:`);
    out.push(`      path: "${path}"`);
    out.push(`      headers: { Host: ${host} }`);
    if (extra) out.push(`    # ${extra}`);
  };

  // 每个模式一份入口副本：模式是服务端行为，客户端只能靠 path 上的参数区分
  for (const mode of ["tput", "lat"]) {
    const suffix = mode === "lat" ? "L" : "T";
    for (const proto of protos) {
      for (const n of nodes) {
        if (proto === "trojan" && !pass) continue;
        const name = `${proto}-${nodeLabel(n)}-${suffix}`;
        emit(name, proto, n.host, n.port, `${nodePath(n)}&mode=${mode}`, n.tls, n._rtt != null ? `rtt ~${n._rtt}ms` : "");
        byMode[mode].push(name);
        all.push(name);
      }
    }
  }

  // 地区出口节点（强制走该国的中转），不分模式
  const regNames = [];
  for (const e of regionEntries(regions, host, pass, protos)) {
    emit(e.name, e.proto, e.server, e.port, e.path, true, "");
    regNames.push(e.name);
    all.push(e.name);
  }

  const q = (arr: string[]) => `    proxies: [${arr.map((x) => `"${x}"`).join(", ")}]`;
  const pick = (arr: string[], n: number) => arr.slice(0, Math.max(1, Math.min(n, arr.length)));

  const groups = [];
  groups.push(`  - name: "${G_TPUT}"`);
  groups.push(`    type: url-test`);
  groups.push(`    url: http://www.gstatic.com/generate_204`);
  groups.push(`    interval: 300`);
  groups.push(`    tolerance: 30`);
  groups.push(`    lazy: false`);
  groups.push(q(pick(byMode.tput, 5)));

  groups.push(`  - name: "${G_LAT}"`);
  groups.push(`    type: url-test`);
  groups.push(`    url: http://www.gstatic.com/generate_204`);
  groups.push(`    interval: 300`);
  groups.push(`    tolerance: 30`);
  groups.push(`    lazy: false`);
  groups.push(q(pick(byMode.lat, 5)));

  if (regNames.length) {
    groups.push(`  - name: "${G_REG}"`);
    groups.push(`    type: select`);
    groups.push(q(regNames));
  }

  groups.push(`  - name: "${G_MAN}"`);
  groups.push(`    type: select`);
  groups.push(`    proxies: ["${G_TPUT}", "${G_LAT}"${regNames.length ? `, "${G_REG}"` : ""}, ${all.map((x) => `"${x}"`).join(", ")}, "DIRECT"]`);

  return [
    "port: 7890",
    "allow-lan: true",
    "mode: rule",
    "log-level: info",
    "unified-delay: true",
    "global-client-fingerprint: chrome",
    "dns:",
    "  enable: true",
    "  enhanced-mode: fake-ip",
    "  fake-ip-range: 198.18.0.1/16",
    "  nameserver: [223.5.5.5, 119.29.29.29]",
    "",
    "proxies:",
    ...out,
    "",
    "proxy-groups:",
    ...groups,
    "",
    "rules:",
    "  - GEOIP,CN,DIRECT",
    `  - MATCH,${G_TPUT}`,
  ].join("\n");
}

export function renderSingbox(env: Env, url: URL, id: string, host: string, learned: Record<string, RttEntry> = {}, regions: string[] = [], auth?: Auth) {
  const nodes = orderNodes(loadNodes(env, host), learned);
  const pass = trojanPasswordOf(env, id, auth);
  const protos = pickProtos(env, url, Boolean(pass));
  const outs = [];
  const byMode: Record<string, string[]> = { lat: [], tput: [] };
  const tags = [];
  const G_LAT = "\u26a1 \u901f\u7387\u4f18\u5148";
  const G_TPUT = "\ud83d\ude80 \u541e\u5410\u4f18\u5148";
  const G_MAN = "\ud83c\udfaf \u624b\u52a8";

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
          tls: n.tls ? { enabled: true, server_name: host } : { enabled: false },
          transport: { type: "ws", path: `${nodePath(n)}&mode=${mode}`, headers: { Host: host } },
        };
        if (proto === "vless") o.uuid = id;
        else o.password = pass;
        outs.push(o);
      }
    }
  }

  for (const e of regionEntries(regions, host, pass, protos)) {
    tags.push(e.name);
    const o: Record<string, unknown> = {
      type: e.proto,
      tag: e.name,
      server: e.server,
      server_port: e.port,
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
    {
      type: "urltest",
      tag: G_LAT,
      outbounds: pick(byMode.lat, 5),
      url: "http://www.gstatic.com/generate_204",
      interval: "5m",
      tolerance: 30,
    },
    { type: "selector", tag: G_MAN, outbounds: [G_TPUT, G_LAT, ...tags, "direct"] },
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
      inbounds: [
        { type: "tun", tag: "tun-in", address: ["172.19.0.1/30"], auto_route: true, strict_route: true },
      ],
      outbounds: [...groups, ...outs, { type: "direct", tag: "direct" }],
      route: { final: G_MAN, auto_detect_interface: true },
    },
    null,
    2
  );
}

export function renderLinks(env: Env, url: URL, id: string, host: string, learned: Record<string, RttEntry> = {}, regions: string[] = [], auth?: Auth) {
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
          `host=${host}`,
          n.tls ? `sni=${host}` : "",
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
  for (const e of regionEntries(regions, host, pass, protos)) {
    const q = [
      "encryption=none",
      "security=tls",
      "type=ws",
      `host=${host}`,
      `sni=${host}`,
      `path=${encodeURIComponent(e.path)}`,
      `#${encodeURIComponent(e.name)}`,
    ].join("&");
    if (e.proto === "vless") lines.push(`vless://${id}@${host}:443?${q}`);
    else lines.push(`trojan://${encodeURIComponent(pass)}@${host}:443?${q}`);
  }
  return btoa(lines.join("\n"));
}

/**
 * 把字节数格式化成人类可读的大小。
 * @param {number} n 字节数
 * @returns {string} 形如 "1.25 TB"
 */
