import { secretPwd, probeUrlOf } from "../core/util";
import { S } from "../core/state";
import { IpFamily, IpLevel } from "../core/enums";
import { AliveBoard } from "../px/alive";
import { QUALITY, CONN_OBS } from "../px/regions";

// ---- 并入自 sub-links.ts ----
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
  const edgeIps = noEdge ? [] : X_EDGE_IPS.slice(0, edgeCount(url));
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
  for (const e of REGION_SUB.entries(regions, host, pass, protos, url, auth, id)) {
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

// ---- 并入自 sub-singbox.ts ----
/**
 * 功能：渲染 sing-box 配置（出站 + 分组 + 出站 DNS 策略）。
 * @param o 订阅输入
 * @returns JSON 字符串
 */
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

  for (const e of REGION_SUB.entries(regions, host, pass, protos, url, auth, id)) {
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
      url: probeUrlOf(url),
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
      url: probeUrlOf(url),
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
        // 局域网名字用本地解析器：路由器 / NAS / .local 这些名字在公网 DNS 上不存在，
        // 走 dns_remote（detour G_MAN）不但查不到，还会把内网主机名送到代理出口去
        rules: [{ domain_suffix: [".lan", ".local", ".home.arpa"], server: "dns_local" }],
        final: "dns_remote",
      },
      inbounds: [{ type: "tun", tag: "tun-in", address: ["172.19.0.1/30"], auto_route: true, strict_route: true }],
      outbounds: [...groups, ...outs, { type: "direct", tag: "direct" }],
      // tun + auto_route 会把整机流量接管，private 网段必须显式放直连，否则局域网
      // （路由管理页、NAS、局域网打印机）都会被送进隧道，再由 CF 出口去连 192.168.x —— 必然失败
      route: {
        rules: [{ ip_is_private: true, outbound: "direct" }],
        final: G_MAN,
        auto_detect_interface: true,
      },
    },
    null,
    2,
  );
}

// ---- 门面（对外导出面保持不变） ----
/* sub-common：订阅渲染共用的节点/标签/地区工具 */
/** ?x=1 用的 CF 边缘入口（钉 IP 是为了拿到不同的落地机房；都是 anycast，同一 IP 也会乱跳）。 */
export const X_EDGE_IPS = [
  "104.18.32.1",
  "172.66.0.96",
  "162.159.140.98",
  "104.26.0.1",
  "104.20.2.1",
  "104.16.0.5",
  "188.114.96.1",
  "104.20.1.1",
];


/**
 * 功能：订阅里发几个入口 IP（?ei=）。
 * 上限就是这个种子表的长度：再要更多也只能重复同样的地址，没有意义。
 * @param url 请求 URL
 * @returns 入口数（默认 8，允许 4 到种子数之间）
 */
export function edgeCount(url: URL): number {
  const s = url.searchParams.get("ei");
  const raw = Number(s);
  if (!s || !Number.isFinite(raw)) return X_EDGE_IPS.length;
  return Math.max(4, Math.min(X_EDGE_IPS.length, Math.floor(raw)));
}

export const DEFAULT_PORTS: Array<[number, boolean]> = [
  [443, true],
  [8443, true],
  [2053, true],
  [80, false],
  [8880, false],
];

/** Cloudflare colo 代码 → 城市中文名（常用部分） */
export const COLO_CITY = {
  HKG: "香港",
  NRT: "东京",
  KIX: "大阪",
  ICN: "首尔",
  TPE: "台北",
  KHH: "高雄",
  SIN: "新加坡",
  BKK: "曼谷",
  KUL: "吉隆坡",
  CGK: "雅加达",
  MNL: "马尼拉",
  SGN: "胡志明",
  HAN: "河内",
  DEL: "德里",
  BOM: "孟买",
  CCU: "加尔各答",
  SYD: "悉尼",
  MEL: "墨尔本",
  AKL: "奥克兰",
  PER: "珀斯",
  LAX: "洛杉矶",
  SJC: "圣何塞",
  SFO: "旧金山",
  SEA: "西雅图",
  DFW: "达拉斯",
  ORD: "芝加哥",
  IAD: "华盛顿",
  EWR: "纽瓦克",
  ATL: "亚特兰大",
  MIA: "迈阿密",
  DEN: "丹佛",
  PHX: "凤凰城",
  YYZ: "多伦多",
  YVR: "温哥华",
  GRU: "圣保罗",
  EZE: "布宜诺斯艾利斯",
  SCL: "圣地亚哥",
  BOG: "波哥大",
  LHR: "伦敦",
  MAN: "曼彻斯特",
  AMS: "阿姆斯特丹",
  FRA: "法兰克福",
  CDG: "巴黎",
  MAD: "马德里",
  BCN: "巴塞罗那",
  MXP: "米兰",
  FCO: "罗马",
  ZRH: "苏黎世",
  VIE: "维也纳",
  ARN: "斯德哥尔摩",
  CPH: "哥本哈根",
  OSL: "奥斯陆",
  HEL: "赫尔辛基",
  WAW: "华沙",
  PRG: "布拉格",
  BUD: "布达佩斯",
  BRU: "布鲁塞尔",
  DUB: "都柏林",
  LIS: "里斯本",
  SOF: "索非亚",
  KBP: "基辅",
  IST: "伊斯坦布尔",
  DME: "莫斯科",
  LED: "圣彼得堡",
  TLV: "特拉维夫",
  DXB: "迪拜",
  DOH: "多哈",
  RUH: "利雅得",
  JNB: "约翰内斯堡",
  LOS: "拉各斯",
  CAI: "开罗",
  NBO: "内罗毕",
  CPT: "开普敦",
};

/** 把入口地址压成可放进 URL 的标签：104.16.0.1 → 104-16-0-1 */
export const tagOf = (h: string) =>
  String(h)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** 节点唯一标签 = 入口 + 端口（同一域名的 443/8443 是两个节点） */
export const nodeTag = (n: SubNode) => `${tagOf(n.host)}-${n.port}`;

/**
 * 解析 env.nodes 配置成入口节点列表（host:port:mode）；全部非法时回落默认端口。
 */
export function loadNodes(env: Env, host: string): SubNode[] {
  const raw = String(env.nodes || "").trim();
  if (raw) {
    const list = raw
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
    // env.nodes 全是坏行时不能返回空：空 proxies / outbounds 会让整份订阅非法
    if (list.length) return list;
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
  const hasTrojan = hasTrojanOverride === undefined ? Boolean(secretPwd(env)) : !!hasTrojanOverride;
  // 规范名是 ?p=，?proto= 是历史别名（两个都认，p 优先）；取值兼容文档写法 tj / both
  const q = (url.searchParams.get("p") || url.searchParams.get("proto") || "").trim().toLowerCase();
  if (q === "vless" || q === "vl") return ["vless"];
  if (q === "tj" || q === "trojan") return hasTrojan ? ["trojan"] : ["vless"];
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
    if (u && u.managed) return ""; // 托管用户没密码 → 这个订阅不出 Trojan
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
      return {
        ...n,
        _i: i,
        _rtt: info && typeof info.rtt === "number" ? info.rtt : null,
        _colo: (info && info.colo) || "",
      };
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
// prettier-ignore
/**
 * 功能：按地区生成订阅条目（每个地区 × 每个协议一条）。
 * @param regions 地区列表
 * @param host 入口域名
 * @param pass 密码
 * @param protos 协议列表
 * @param url 当前 URL（可带参数）
 * @returns 条目数组
 */
export function regionEntries(regions: string[], host: string, pass: string, protos: string[], url?: URL): RegionEntry[] {
  const out: RegionEntry[] = [];
  // 监听端口按订阅自身的 URL 推断（https=443 / http=80，显式端口优先）：客户端连的就是这个入口
  // url 是可选参数。旧写法 `Number(url && url.port) || (url && url.protocol === "http:" ? 80 : 443)`
  // 在 url 省略时靠三元里的 `url &&` 守卫得到 443 —— 结果是对的，但正确性藏在一个守卫的副作用里，
  // 读起来像是会算出 `NaN || undefined`。这里把「没 URL 就是 443」写在最外层，读代码不用再推一遍。
  const listen = url ? Number(url.port) || (url.protocol === "http:" ? 80 : 443) : 443;
  for (const cc of regions) {
    for (const proto of protos) {
      // Trojan 必须有密码，没配就跳过这条协议，别发一条注定连不上的条目
      if (proto === "trojan" && !pass) continue;
      out.push({
        cc,
        proto,
        name: `${proto}-region-${cc}`,
        server: host,
        port: listen,
        // rg 让服务端把这条连接归到指定地区；ip=region-xx 只用于日志区分，不参与选路
        path: `/?ed=2560&ip=region-${cc}&rg=${cc.toLowerCase()}`,
      });
    }
  }
  return out;
}


// ---- 地区节点订阅：用户在面板选的地区 → ?node= 硬钉条目（地区/质量重设计） ----
/**
 * 按用户配置把「地区 + 质量 + 目标站点延迟」变成 ?node= 订阅条目。
 * views 在 px 之后，读 QUALITY/CONN_OBS/AliveBoard 都是向下依赖，无环；
 * 无用户配置时 entries() 回落原 regionEntries()，老订阅逐字节不变。
 */
export class RegionSubscription {
  /**
   * 生成订阅条目：有用户选择就按地区+topN 挑具体节点（Good 优先、Risky 排除），
   * 每个节点 × 每种协议一条；无配置回落原 ?rg= 行为。
   * @param regions 地区列表（回落用）
   * @param host 入口域名
   * @param pass Trojan 密码
   * @param protos 协议列表
   * @param url 当前 URL
   * @param auth 鉴权（含用户配置）
   * @param id 用户 UUID
   * @returns 订阅条目数组
   */
  entries(regions: string[], host: string, pass: string, protos: string[], url: URL | undefined, auth: Auth | undefined, id: string): RegionEntry[] {
    const cfg = auth && auth.list ? auth.list.find((u) => u.id === id) : undefined;
    if (!cfg || !cfg.regions || !cfg.regions.length) return regionEntries(regions, host, pass, protos, url);
    const topN = Math.max(1, Math.min(8, cfg.regionTopN || 3));
    const now = Date.now();
    const live = new AliveBoard().list();
    const out: RegionEntry[] = [];
    // 一次算好每个节点的 rank：原写法在 filter 与 sort comparator 里反复调 rank()（内部走 QUALITY.getFor），
    // 32 地区 × 800 节点 × 排序比较会放大成几十万次画像查询；缓存后降为 O(alive) 次。
    const ranked = live.map((n) => ({ n, r: this.rank(n, now) }));
    for (const cc of cfg.regions) {
      const ccUpper = cc.toUpperCase();
      // Risky 直接排除，Unknown 按 Normal；再按质量与 key 稳定排序（用缓存的 rank）
      const picked = ranked
        .filter((x) => String(x.n.cc || "").toUpperCase() === ccUpper && x.r < 3)
        .sort((a, b) => a.r - b.r || a.n.h.localeCompare(b.n.h));
      for (const { n } of picked.slice(0, topN)) {
        const q = QUALITY.getFor(n.h, n.p, now);
        const level = q ? q.level : IpLevel.Normal;
        const fam = String(n.h).includes(":") ? IpFamily.IPv6 : IpFamily.IPv4;
        const rtt = cfg.targetHost ? CONN_OBS.rttOf(S.colo || "", `${n.h}:${n.p}`, cfg.targetHost, now) : null;
        const labelParts = [`${ccUpper}-${level}`, fam, n.h];
        if (rtt != null) labelParts.push(`${rtt}ms`);
        for (const proto of protos) {
          if (proto === "trojan" && !pass) continue;
          out.push({
            proto,
            name: `📍${labelParts.join("-")}-${proto}`,
            server: n.h, port: n.p,
            // node= 是硬钉住：用户点名即只走这条，失败不回落
            path: `/?ed=2560&node=${encodeURIComponent(`${n.h}:${n.p}`)}`,
          });
        }
      }
    }
    return out;
  }

  /**
   * 质量排序键：0=Good 最优先、1=Normal/Unknown、3=Risky 排除。
   * @param n 节点
   * @param now 当前时间
   * @returns 排序键
   */
  private rank(n: NodeEntry, now: number): number {
    const q = QUALITY.getFor(n.h, n.p, now);
    if (!q) return 1;
    return q.level === IpLevel.Good ? 0 : q.level === IpLevel.Risky ? 3 : 1;
  }
}

/** 地区节点订阅单例（views 层，保留实例便于测试注入） */
export const REGION_SUB = new RegionSubscription();
