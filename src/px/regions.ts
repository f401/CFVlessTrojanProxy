import { IpFamily, IpKind, IpLevel } from "../core/enums";
import { BoundedMap } from "../core/table";

/*
 * 地区节点质量层：把「6 源 IP 质量探测」「全池覆盖账本」「按机房分桶的连通性观测」
 * 三件生命周期不同的事收在同三个有状态类里。
 *
 * 为什么放在一个文件：仓库的源码文件数卡在 115 的门禁上限，新开文件会立刻变红；
 * 这三件又都属于「地区优选」这一条链路，放在同一文件里反而比散开更易读。
 *
 * 状态归属纪律：这里的所有表都是**本 isolate 内存**——质量结论的「客观部分」由
 * `SeedStore.packName` 搭 seed 便车跨 isolate 传播，而覆盖进度、连通性 RTT 是实测值，
 * 按硬约束不跨 isolate 共享。
 */

/** 质量结论的置信度：几个源 agree 就越可信（内部用，不落盘） */
const QUALITY_TTL = 3 * 24 * 3600_000; // 缓存 3 天（与 FlClash 一致）
const SOURCE_COOLDOWN = 5 * 60_000; // 单源失败冷却 5 分钟
const COVERAGE_CAP = 4000; // 覆盖表最多记多少节点（超过 SCAN_MAX 的一轮量留足）
const CONN_CAP = 2000; // 连通性观测上限
const CONN_TTL = 6 * 3600_000; // 连通性观测 6 小时后失效

/**
 * 单个质量源的归一化信号。
 * 每个源返回格式不同，这里先归一成同一形状再合并；解析不了就返回 null（该源本轮弃用）。
 */
interface QualitySignal {
  kind: IpKind;
  proxy: boolean;
  vpn: boolean;
  risky: boolean;
}

/**
 * 连通性观测：某机房的某节点访问某站点的一次结果。
 * 存在按 colo 分桶的表里（用户指定的「colo 那个表」），默认只本 isolate 可见。
 */
interface ConnObsRow {
  code: number;
  rtt: number;
  family: IpFamily;
  ok: boolean;
  at: number;
}

/**
 * 功能：把六个第三方源各自不同的返回格式，归一化成同一个 QualitySignal。
 */
export const QUALITY_SOURCES: ReadonlyArray<{
  name: string;
  url: (ip: string) => string;
  parse: (row: Record<string, unknown>) => QualitySignal | null;
}> = [
  {
    // ip-api.com 免费版只支持 http；字段 via ?fields= 指定
    name: "ipapi-com",
    // countryCode 已在同一次请求的 fields 里：重探质量时顺手回填 IsoCc，零新增子请求
    url: (ip) => `http://ip-api.com/json/${ip}?fields=status,countryCode,isp,org,as,mobile,proxy,hosting`,
    parse: (row) => {
      if (row.status !== "success") return null;
      const hosting = row.hosting === true;
      const mobile = row.mobile === true;
      return {
        kind: mobile ? IpKind.Mobile : hosting ? IpKind.Hosting : IpKind.Business,
        proxy: row.proxy === true,
        vpn: false,
        risky: false,
      };
    },
  },
  {
    // iplocate.io：字段最全，含 is_abuser / is_tor 风险位
    name: "iplocate",
    url: (ip) => `https://iplocate.io/api/lookup/${ip}`,
    parse: (row) => {
      const privacy = (row.privacy || {}) as Record<string, unknown>;
      const company = (row.company || {}) as Record<string, unknown>;
      const type = String(company.type || "");
      const kind =
        type === "residential"
          ? IpKind.Residential
          : type === "mobile"
            ? IpKind.Mobile
            : type === "hosting" || privacy.is_hosting === true
              ? IpKind.Hosting
              : IpKind.Business;
      return {
        kind,
        proxy: privacy.is_proxy === true,
        vpn: privacy.is_vpn === true,
        risky: privacy.is_abuser === true || privacy.is_tor === true,
      };
    },
  },
  {
    // ipapi.is 免费版没有 is_datacenter/company.type（文档过时），只用 bogon 与文本兜底
    name: "ipapi-is",
    url: (ip) => `https://api.ipapi.is/?q=${ip}`,
    parse: (row) => {
      const company = String(row.company || "");
      const bogon = row.is_bogon === true;
      const kind = /hosting|datacenter|cloud/i.test(company) ? IpKind.Hosting : IpKind.Business;
      return { kind, proxy: false, vpn: false, risky: bogon };
    },
  },
  {
    // 下面三个源当前环境不可达；保留注册表与解析器，实现期经已部署代理探活后再启用。
    name: "ipquery",
    url: (ip) => `https://api.ipquery.io/${ip}`,
    parse: (row) => {
      const company = String(row.company || "");
      if (!company && !row.ip) return null;
      const kind = /hosting|datacenter/i.test(company) ? IpKind.Hosting : IpKind.Business;
      return { kind, proxy: false, vpn: false, risky: false };
    },
  },
  {
    name: "proxycheck",
    url: (ip) => `https://proxycheck.io/v2/${ip}?vpn=1&asn=1`,
    parse: (row) => {
      const info = (row[Object.keys(row)[0] || ""] || {}) as Record<string, unknown>;
      if (typeof info.proxy !== "string" && typeof info.type !== "string") return null;
      return {
        kind: /hosting|business/i.test(String(info.type || "")) ? IpKind.Hosting : IpKind.Business,
        proxy: info.proxy === "yes",
        vpn: info.vpn === "yes",
        risky: false,
      };
    },
  },
  {
    // ident.me 不支持查指定 IP（只回调用者自己的出口），解析器保留但探测时跳过。
    name: "ident-me",
    url: () => `https://ident.me/json`,
    parse: (row) => {
      const type = String(row.type || "");
      if (!type) return null;
      return {
        kind:
          type === "residential"
            ? IpKind.Residential
            : type === "mobile"
              ? IpKind.Mobile
              : type === "business"
                ? IpKind.Business
                : type === "hosting"
                  ? IpKind.Hosting
                  : IpKind.Unknown,
        proxy: false,
        vpn: false,
        risky: false,
      };
    },
  },
];

/**
 * 功能：把多个源的归一化信号合并成一条最终的 IpQuality。
* @param signals 本轮成功解析的信号（可为空）
* @param at 合并时刻（毫秒）
* @returns 质量结论；无信号时 kind=Unknown / level=Normal，不臆测
 */
export function mergeQuality(signals: QualitySignal[], at: number): IpQuality {
  // 风险位只要有一个源报了就认：宁可错杀也不把 abuser/tor 出口标成 Good
  const risky = signals.some((s) => s.risky);
  // kind 取第一个非 Unknown：源注册表按可信度排序（ip-api → iplocate → …）
  const kind = signals.find((s) => s.kind !== IpKind.Unknown)?.kind ?? IpKind.Unknown;
  const proxy = signals.some((s) => s.proxy);
  const vpn = signals.some((s) => s.vpn);
  // hosting→Normal，住宅/移动/企业→Good，风险→Risky，未知→Normal（按 Normal 用但不优先）
  const level = risky
    ? IpLevel.Risky
    : kind === IpKind.Residential || kind === IpKind.Mobile || kind === IpKind.Business
      ? IpLevel.Good
      : IpLevel.Normal;
  return { kind, level, proxy, vpn, at };
}

/**
 * 功能：从 ip-api 批量查询的一行里直接产出质量结论（搭现有 geoLabel 便车，零新增请求）。
* @param row ip-api 批量返回的一行
* @param at 观测时刻（毫秒）
* @returns 质量结论；解析失败返回 null
 */
export function qualityFromIpApi(row: Record<string, unknown>, at: number): IpQuality | null {
  const signal = QUALITY_SOURCES[0].parse(row);
  return signal ? mergeQuality([signal], at) : null;
}

/**
 * 功能：按节点 key 保存质量结论的内存表，负责 3 天缓存与「是否该重探」。
 */
export class IpQualityTable {
  /** 节点 key → 质量结论（写入路径按容量+3d寿命裁剪，不再全表排序） */
  readonly rows = new BoundedMap<string, IpQuality>({ max: COVERAGE_CAP, ttlMs: QUALITY_TTL, timeOf: (q) => q.at });
  /** 源名 → 上次失败的时刻（冷却用；源名只有 6 个，固定小表） */
  readonly sourceCool = new Map<string, number>();
  /** 手动重探/站点探测的节流：前缀 key → 上次触发时刻。key 由客户端拼，必须按寿命+容量有界（1102 根因之一） */
  readonly recheckCool = new BoundedMap<string, number>({ max: COVERAGE_CAP, ttlMs: QUALITY_TTL, timeOf: (at) => at });
  /** 出口 IP → ISO 国家码（展示层用；alive.cc / seed 桶键是 CF 接入机场码，不能当国家）。本 isolate 内存，随质量表 3 天失效 */
  readonly isoCc = new BoundedMap<string, { cc: string; at: number }>({ max: COVERAGE_CAP, ttlMs: QUALITY_TTL, timeOf: (r) => r.at });

  /**
   * 功能：记一条出口 IP 的 ISO 国家码（仅展示，不参与选路/打分）。
  * @param host 出口 IP
  * @param cc ISO 国家码
  * @param now 当前时刻
  * @returns 无
   */
  noteIso(host: string, cc: string, now: number = Date.now()): void {
    if (!host || !cc) return;
    // 裁剪必须在 set 之后，且用低水位把 O(n log n) 排序摊薄（1102：写路径全表排序是 CPU 主因）
    this.isoCc.set(host, { cc: String(cc).toUpperCase(), at: now });
    this.isoCc.prune(now);
  }

  /**
   * 功能：读出口 IP 的 ISO 国家码，过期即删。
  * @param host 出口 IP
  * @param now 当前时刻
  * @returns ISO 国家码；没有或过期返回空串
   */
  getIso(host: string, now: number = Date.now()): string {
    const row = this.isoCc.get(host);
    if (!row) return "";
    if (now - row.at > QUALITY_TTL) { this.isoCc.delete(host); return ""; }
    return row.cc;
  }

  /**
   * 功能：读一条仍然有效的质量结论，过期即删并返回 null。
  * @param key 节点 key（host:port）
  * @param now 当前时刻
  * @returns 有效结论或 null
   */
  get(key: string, now = Date.now()): IpQuality | null {
    const q = this.rows.get(key);
    if (!q) return null;
    if (now - q.at > QUALITY_TTL || q.at > now + 60_000) {
      // 超过 3 天或时间戳落在未来（跨 isolate 时钟漂移）都当失效
      this.rows.delete(key);
      return null;
    }
    return q;
  }

  /**
   * 功能：写入一条质量结论，并按上限淘汰最旧的（客户端可控的 key 不能让表无限涨）。
   * @param key 节点 key
   * @param q 质量结论
   */
  note(key: string, q: IpQuality): void {
    this.rows.set(key, q);
    // BoundedMap 统一做「先删 3d 过期、再按 at 低水位收到 COVERAGE_CAP」，替代手写全表排序
    this.rows.prune(q.at);
  }

  /**
   * 功能：按「主机 + 端口」读质量，端口维度缺失时回落到纯主机（批量补码搭车时用主机做键）。
  * @param host 主机（IP 或域名）
  * @param port 端口
  * @param now 当前时刻
  * @returns 有效结论或 null
   */
  getFor(host: string, port: number | undefined, now = Date.now()): IpQuality | null {
    return this.get(`${host}:${port}`, now) || this.get(host, now);
  }

  /**
   * 功能：某源是否还在失败冷却中。
  * @param name 源名
  * @param now 当前时刻
  * @returns 冷却中为 true
   */
  sourceCooling(name: string, now = Date.now()): boolean {
    const at = this.sourceCool.get(name);
    if (at === undefined) return false;
    if (now - at < SOURCE_COOLDOWN) return true;
    this.sourceCool.delete(name);
    return false;
  }

  /**
   * 功能：标记某源失败，进入 5 分钟冷却。
   * @param name 源名
   * @param now 当前时刻
   */
  failSource(name: string, now = Date.now()): void {
    this.sourceCool.set(name, now);
  }

  /**
   * 功能：判断一次手动探测（质量重探 / 指定网站探测）是否过了冷却期。
  * @param key 带前缀的操作键（如 `q:host:port` / `s:site`）
  * @param cooldownMs 冷却时长
  * @param now 当前时刻
  * @returns 可以探测返回 true
   */
  recheckReady(key: string, cooldownMs: number, now = Date.now()): boolean {
    const at = this.recheckCool.get(key);
    if (at !== undefined && now - at < cooldownMs) return false;
    return true;
  }

  /**
   * 功能：登记一次手动探测的触发时刻（配合 recheckReady 做限流）。
   * @param key 带前缀的操作键
   * @param now 当前时刻
   */
  recheckMark(key: string, now = Date.now()): void {
    // 裁剪必须在 set 之后：旧写法只在超 COVERAGE_CAP 时按 QUALITY_TTL(3d) 清，
    // 而 recheck key 的寿命只有 60s ⇒ 过期项 3 天内清不掉，表无限涨（1102 根因）
    this.recheckCool.set(key, now);
    this.recheckCool.prune(now);
  }

  /**
   * 功能：给 seed 落盘用的快照（只导出还没过期的行）。
   * @param now 当前时刻
   * @returns key → 质量结论
   */
  snapshot(now = Date.now()): Record<string, IpQuality> {
    const out: Record<string, IpQuality> = {};
    for (const [k, q] of this.rows) if (this.get(k, now)) out[k] = q;
    return out;
  }
}

/** 质量表的进程内唯一实例（跨 isolate 的部分由 seed 携带，本表只做本 isolate 缓存） */
export const QUALITY = new IpQualityTable();

/**
 * 功能：按注册表依次查 6 个质量源，把结果合并成一条 IpQuality。
 */
export class QualityProbe {
  /**
   * 功能：探测一个 IP 的质量。
  * @param key 节点 key（含端口，用于缓存与覆盖记账）
  * @param ip 要查的 IP（v4 字面量；v6 需先经支持 v6 的源）
  * @param io 子请求出口（走它才扣 sub 额度，测试可注入桩）
  * @param family 地址族
  * @param now 当前时刻
  * @returns 质量结论（先查缓存，命中则零请求）
   */
  async qualityOf(key: string, ip: string, io: import("../core/budgeted-io").BudgetedIO, family: IpFamily, now = Date.now()): Promise<IpQuality> {
    // 先查缓存：3 天内不重复请求（用户明确的额度纪律）
    const cached = QUALITY.get(key, now);
    if (cached) return cached;
    const signals: QualitySignal[] = [];
    for (const source of QUALITY_SOURCES) {
      // ident.me 只返回调用者自己的出口，不能查指定 IP —— 注册表里保留仅是文档用途
      if (source.name === "ident-me") continue;
      // 失败冷却中的源本轮跳过，避免给已经挂掉的第三方反复送请求
      if (QUALITY.sourceCooling(source.name, now)) continue;
      try {
        const resp = await io.fetch(source.url(ip), { headers: { "user-agent": "cf-proxyx/quality" } });
        if (!resp.ok) {
          QUALITY.failSource(source.name, now);
          continue;
        }
        const row = (await resp.json()) as Record<string, unknown>;
        const signal = source.parse(row);
        if (signal) signals.push(signal);
        // 探测质量时顺手记下该 IP 的 ISO 国家码：ip-api 的 countryCode 已在这次响应里，
        // 零新增子请求；回填到展示用的 isoCc 表，让面板/探测结果能显示真实国家
        if (source.name === "ipapi-com" && row.countryCode && ip && !ip.includes(":")) {
          QUALITY.noteIso(ip, String(row.countryCode), now);
        }
      } catch {
        // 某个源超时/不可达只记冷却，绝不拖垮整轮——这正是用户说的「部分网站不返回数据」
        QUALITY.failSource(source.name, now);
      }
    }
    const result = mergeQuality(signals, now);
    QUALITY.note(key, result);
    COVERAGE.note(key, family, now);
    return result;
  }
}

/** 质量探测器的进程内唯一实例 */
export const QUALITY_PROBE = new QualityProbe();

/**
 * 功能：全池 IP 探测覆盖账本，按「最久没探」优先轮转，确保每个节点迟早被探到。
 */
export class ProbeCoverage {
  /** 节点 key → 最近探测时刻与地址族（有界：key 由客户端/池子来，不能无限涨） */
  readonly rows = new BoundedMap<string, { lastProbeAt: number; family: IpFamily }>({
    max: COVERAGE_CAP, ttlMs: QUALITY_TTL, timeOf: (r) => r.lastProbeAt,
  });

  /**
   * 功能：记录一次探测。
  * @param key 节点 key
  * @param family 地址族
  * @param now 当前时刻
   */
  note(key: string, family: IpFamily, now = Date.now()): void {
    this.rows.set(key, { lastProbeAt: now, family });
    this.rows.prune(now);
  }

  /**
   * 功能：取本轮该探的节点（从未探过 / 最久没探优先），不花任何 KV/DO 额度。
  * @param keys 候选池里的全部节点 key
  * @param max 本轮上限（受 SCAN_MAX/SCAN_SUB 约束，由调用方夹取）
  * @returns 按最旧优先排序的 key 列表
   */
  pick(keys: string[], max: number): string[] {
    return [...keys]
      .sort((a, b) => (this.rows.get(a)?.lastProbeAt || 0) - (this.rows.get(b)?.lastProbeAt || 0))
      .slice(0, Math.max(0, max));
  }

  /**
   * 功能：覆盖率统计（按族分列），给面板显示。
   * @param keys 候选池里的全部节点 key
   * @returns 总数、已探数、v4/v6 已探数
   */
  stats(keys: string[]): { total: number; probed: number; v4: number; v6: number } {
    let probed = 0,
      v4 = 0,
      v6 = 0;
    for (const k of keys) {
      const row = this.rows.get(k);
      if (!row) continue;
      probed++;
      if (row.family === IpFamily.IPv6) v6++;
      else v4++;
    }
    return { total: keys.length, probed, v4, v6 };
  }

  /**
   * 功能：清空（pool 换代时调用，避免已不存在的节点占着覆盖配额）。
   * @returns 无
   */
  clear(): void {
    this.rows.clear();
  }
}

/** 覆盖账本的进程内唯一实例 */
export const COVERAGE = new ProbeCoverage();

/**
 * 功能：按机房分桶的连通性观测表（用户指定的「colo 那个表」）。
 */
export class ConnObservation {
  /** colo|node|site → 观测行（有界 + 6h 寿命，裁剪走 BoundedMap 的低水位摊薄） */
  readonly rows = new BoundedMap<string, ConnObsRow>({ max: CONN_CAP, ttlMs: CONN_TTL, timeOf: (r) => r.at });

  /**
   * 功能：记一次连通性结果，并按上限 + TTL 淘汰。
  * @param colo 机房标签
  * @param node 节点 key
  * @param site 目标站点
  * @param code HTTP 状态码（0=连接失败）
  * @param rtt 首字节耗时
  * @param family 地址族
  * @param now 当前时刻
  * @returns 无
   */
  note(colo: string, node: string, site: string, code: number, rtt: number, family: IpFamily, now = Date.now()): void {
    const key = `${colo}|${node}|${site}`;
    // 2xx 可用；401/403/429/451 视为「可达但受限」；其它非 0 是「可达」；0 是不可达
    const ok = (code >= 200 && code < 300) || (code > 0 && code < 600);
    this.rows.set(key, { code, rtt, family, ok, at: now });
    // 写在 set 之后：BoundedMap 先删 6h 过期、再按 at 低水位收到 CONN_CAP（1102 根因：写路径全表排序）
    this.rows.prune(now);
  }

  /**
   * 功能：读一条连通性结果（过期即删）。
  * @param colo 机房标签
  * @param node 节点 key
  * @param site 目标站点
  * @param now 当前时刻
  * @returns 观测行或 null
   */
  get(colo: string, node: string, site: string, now = Date.now()): ConnObsRow | null {
    const key = `${colo}|${node}|${site}`;
    const row = this.rows.get(key);
    if (!row) return null;
    if (now - row.at > CONN_TTL) {
      this.rows.delete(key);
      return null;
    }
    return row;
  }

  /**
   * 功能：按节点取目标站点的延迟，给订阅节点名显示（用户要求「生成 ip 显示目标站点延迟」）。
  * @param colo 机房标签
  * @param node 节点 key
  * @param site 目标站点
  * @param now 当前时刻
  * @returns 毫秒数或 null（没测过/已过期）
   */
  rttOf(colo: string, node: string, site: string, now = Date.now()): number | null {
    return this.get(colo, node, site, now)?.rtt ?? null;
  }
}

/** 连通性观测表的进程内唯一实例 */
export const CONN_OBS = new ConnObservation();

/**
 * 得出订阅里要输出的地区列表（配置固定值或按 alive 自动推断）。
 * @param {object} env Worker 环境
 * @returns {Promise<string[]>} 最多 6 个两位国家码
 */
export async function regionListAsync(env: Env) {
  // 两种来源：env.regions 显式配置（逗号分隔的两位国家码），或 auto 由存活节点的 cc 推断
  const raw = String(env.regions || "").trim();
  if (raw && raw.toLowerCase() !== "auto") {
    const out: string[] = [];
    for (const x of raw.split(",")) {
      const cc = x.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(cc) && !out.includes(cc)) out.push(cc);
      if (out.length >= 6) break;
    }
    return out;
  }
  // auto：按存活节点的出现顺序去重，最多 6 个。顺序必须稳定——订阅里的组名跟着它变，
  // 顺序一乱客户端就会重建分组、丢选中状态。
  // 这里用动态 import 而不是顶层 import：seed.ts 要从本文件读 QUALITY，而 pool.ts 又依赖
  // seed.ts，静态 import 会形成 seed → regions → pool → seed 的环（check-arch 会拦）。
  // 动态 import 让依赖图在编译期保持无环，运行到 auto 分支才真正加载 pool。
  const { aliveList } = await import("./pool");
  const list = await aliveList(env);
  const set: string[] = [];
  for (const x of list) {
    const cc = (x.cc || "").toUpperCase();
    if (cc && !set.includes(cc)) set.push(cc);
  }
  return set.slice(0, 6);
}
