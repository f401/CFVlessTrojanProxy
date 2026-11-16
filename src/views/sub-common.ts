import { secretPwd } from "../core/util";

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

