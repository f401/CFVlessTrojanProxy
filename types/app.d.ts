/**
 * 业务类型：节点统计 / 信誉表 / 计量 / 订阅渲染
 * 全局 ambient 声明；Env / 运行时类型已拆到 env.d.ts / runtime.d.ts
 */

/** ip-api 批量查询返回的一行 */
interface IpApiRow {
  status?: string;
  countryCode?: string;
}

/** 站点诊断的一行（真实样本或主动探测） */
interface DiagRow {
  node: string;
  n: number;
  ok: number;
  bad: number;
  cc?: string;
  bytes?: number;
  ttfb?: number;
}

/** 控制页模板的数据 */
interface PanelInfo {
  regions: string[];
  curLat: string;
  curTput: string;
  colo: string;
  funnel: string;
  aliveCount: number;
  used: string;
  today: string;
  quota: string;
  expire: string;
  policy: string;
  [k: string]: unknown;
}

/** SNI 探测结果 */
interface SniProbe {
  err: string;
  hs?: number;
  head?: string;
}

/** DNS-over-HTTPS 的 Answer 元素 */
interface DohAnswer {
  type: number;
  data: string;
}

/** 订阅里的入口节点 */
interface SubNode {
  host: string;
  port: number;
  tls: boolean;
  name: string;
  cc?: string;
}
interface RegionEntry {
  name: string;
  proto: string;
  server: string;
  port: number;
  path: string;
  cc?: string;
}
interface RankedNode extends SubNode {
  _i?: number;
  _rtt?: number | null;
  _colo?: string;
}

/** 选路模式 */
type Mode = "lat" | "tput";

/** 单个节点的统计（NSTAT 的值） */
interface NodeStats {
  ok: number;
  fail: number;
  at: number;
  msLocal: number;

  /** 熔断/冻结 */
  streak: number;
  blackUntil: number;
  freeUntil: number;
  lastTry: number;

  /** 探活：延迟样本与三段计时 */
  probeSamples: number;
  pSum: number;
  pSumSq: number;
  cusumSum: number;
  cusumBase: number;
  probeFails: number;
  tcp: number;
  tls: number;

  /** 真实流量：可用性 */
  trafficOkW: number;
  trafficFailW: number;
  okW: number;
  failW: number;
  eCloseP: number;

  /** 吞吐：直方图 + 卡顿 */
  stallMs: number;
  runMs: number;
  bytesDown: number;
  hist: number[];
  /** 直方图分位算出来的能力值（p90 与 p50×2.5 取小），采样时算一次，读 O(1) */
  capBps?: number;
  /** 加权直方图：权重和、权重平方和、近期有效字节、最后样本时刻 */
  sumW: number;
  sumW2: number;
  recentBytesW: number;
  lastSampleAt: number;
  /** 10 分钟滑动窗口：近期成功/失败（用于快速反映劣化与抖动） */
  winAt: number;
  winOk: number;
  winFail: number;

  /** 其它 */
  counted: number;
  [k: string]: unknown;
}

/**
 * 存活节点（ALIVE 的值）。
 *
 * 这里只放「这条中继本身是什么」：地址、端口、国家码、最近一次探活握手耗时。
 * 曾经的 `src`（pool/seed/probe 三种来源）在 7.173 删掉了：写进去三处、读的地方零处，
 * 而探活命中时又会把整条覆盖成 "probe"，也就是说连"来源"这个信息本身都不成立。
 */
interface NodeEntry {
  h: string;
  p: number;
  cc?: string;
  ms?: number;
  [k: string]: unknown;
}

/**
 * 信誉表里的一条（落盘用）。
 * 只有"名字与地址"：这几个字段是事实（这地址在这个机房连得上），跨 isolate 有意义。
 * ms/tcp/tls/n/f/b/sb/at 是 v6 的跨机房统计，v7 起 `packName` 不再写、也没有任何读端 ——
 * 类型里留着它们只会骗后来的人（照着类型写代码会读到永远 undefined 的字段）。
 */
interface SeedNode {
  k: string;
  h?: string;
  p?: number;
  cc?: string;
}

/** 一个机房的桶 */
interface SeedBucket {
  ts?: number;
  lastSwitch?: number;
  nodes?: SeedNode[];
}

/** px:seed 的整体结构 */
interface Seed {
  /** 老结构：整张表只属于一个机房 */
  nodes?: SeedNode[];
  v: number;
  ts: number;
  poolGen: number;
  poolN: number;
  builtAt: number;
  byColo: Record<string, SeedBucket>;
  cnt?: CounterDoc | null;
}

/** 本 isolate 的本地计数 */
interface StatsLocal {
  up: number;
  down: number;
  conns: number;
  first: number;
  last: number;
}

/** 对外展示的用量视图（DO / KV / 本地合并后） */
interface StatsView {
  up: number;
  down: number;
  conns: number;
  todayUp: number;
  todayDown: number;
  firstSeen: number | null;
  lastSeen: number | null;
  isolateLocal?: { up: number; down: number; conns: number };
  backend?: string;
  persisted?: boolean;
  [k: string]: unknown;
}

/** 待推送的计量增量 */
interface PendEntry {
  up: number;
  down: number;
  conns: number;
}

/** 节点排行一行 */
interface RankRow {
  k: string;
  v: number;
}

/** 面板块速率限制 */
interface RlBucket {
  n: number;
  t: number;
}

/** 首包解析：成功 */
interface ParseOk {
  ok: true;
  proto: string;
  id: string;
  host: string;
  port: number;
  offset: number;
  udp?: boolean;
  ver?: number;
}
/** 首包解析：失败 */
interface ParseErr {
  ok: false;
  err: string;
  id?: string;
}
type ParseResult = ParseOk | ParseErr;

/** 用户记录（面板管理 + env 静态配置合并后的结果） */
interface UserRec {
  id: string;
  pwd: string;
  note: string;
  enabled: boolean;
  managed: boolean;
  ts?: number;
}

/** loadUsers 的返回：鉴权用的索引 + 面板展示用的列表 */
interface Auth {
  uuids: Set<string>;
  trojan: Map<string, string>;
  list: UserRec[];
  /** false = KV 读失败且无可用缓存（可能缺托管用户），cron 不要拿它写快照 */
  ok?: boolean;
}

/** 候选池里的一条 */
interface PoolEntry {
  h: string;
  p: number;
  src?: string;
}

/** RTT 学习表里的一条（按入口标签聚合） */
interface RttEntry {
  rtt: number;
  colo?: string;
  bw?: number;
  hits: number;
  ok?: number;
  fail?: number;
  ts: number;
}

/** usage:snap —— 各用户的用量水位（只增不减；d/dU/dD 用于同日灾备） */
interface UsageSnap {
  ts: number;
  /** 下一轮的起点（用户数超过每轮上限时轮转；没有它，排在后面的用户永远停在旧水位） */
  idx?: number;
  users: Record<
    string,
    { up: number; down: number; conns: number; first?: number; d?: string; dU?: number; dD?: number }
  >;
}

/** snap —— 当日统计快照 */
interface SnapDoc {
  v: number;
  ts: number;
  date: string;
  stats: Record<string, StatsLocal>;
  rtt: Record<string, Record<string, RttEntry>>;
  errs: ErrItem[];
  cnt?: Record<string, number>;
}

/** Meter DO 里存的用量累计 */
interface UsageMeter {
  up: number;
  down: number;
  conns: number;
  first: number;
  ts: number;
  d?: string;
  dU?: number;
  dD?: number;
}

/** 看板的节点行（views 只负责渲染，数据由 nodes/stats-rows 组装） */
interface StatsNodeRow {
  k: string;
  cc: string;
  ms: number;
  score: number;
  kbps: string;
  rate: string;
  tip: string;
}

/** 某个节点在某个站点上的画像（诊断用：谁对这个站不行） */
interface HNStat {
  n: number;
  ok: number;
  bad: number;
  bytes: number;
  ttfb: number;
  at: number;
  /** 站点级吞吐样本（EWMA）与样本数、采集时刻 */
  bps?: number;
  bpsN?: number;
  bpsAt?: number;
}

/** 直连对照：这个站直连到底通不通 */
interface HDirect {
  ok: number;
  bad: number;
  at: number;
}

/** Meter DO 里存的节点快照（跨 isolate 展示用） */
interface NodeSnap {
  med: number;
  p90: number;
  cap: number;
  n: number;
  ts?: number;
  tf?: number;
  at: number;
}

/** 日计数（d + 若干计数字段） */
interface CounterDoc {
  d: string;
  [k: string]: number | string | undefined;
}

/** /add 的请求体（用量 + 计数 + 节点快照 + 错误） */
interface MeterBody {
  up?: number;
  down?: number;
  conns?: number;
  first?: number;
  /** 恢复历史累计时一并带回的当日字段（d 必须是今天才采纳） */
  d?: string;
  dU?: number;
  dD?: number;
  c?: Record<string, number | string>;
  spd?: Record<string, NodeSnap>;
  e?: ErrItem[];
  cl?: ClRec[];
  /** `host|node` → 到期时间：中继对该站点被 403 的判定（跨 isolate 共享） */
  blk?: Record<string, number>;
  vt?: Array<{ k: string; s: number; t: number }>;
  /**
   * 中继存活度增量：ip + ok/bad/dead 计数。
   * `t` 是这条证据的最后观测时间（7.160 起带上）：接收端靠它决定证据有多旧，
   * 缺省时按「刚刚」算——老版本 isolate 发上来的行没有这个字段。
   */
  hl?: Array<{ i: string; o: number; b: number; d: number; t?: number }>;
  /** 出口族事实增量：中继 IP + 族（4/6）+ 观测时间（v8 §3 的 eg） */
  eg?: Array<{ i: string; f: number; at: number }>;
  ps?: Array<{ k: string; q: number; n: number; at: number; top?: number }>;
  dead?: Array<{ i: string; n: number; at: number }>;
  blk2?: Array<{ k: string; n: number; at: number }>;
  dns?: Array<{ h: string; v: number; at: number }>;
  /** 老快照：全局计数 / 节点快照 */
  g?: Record<string, number>;
  s?: Record<string, NodeSnap>;
}

/** 一条错误日志 */
interface ErrItem {
  t: number;
  m: string;
  tag?: string;
}

/** 连接观测按节点聚合：离线标定 ttfb/抖动权重的最小样本（40 条原始记录盖不住 2000 个节点） */
interface ClRec {
  k: string; // 节点 key，直连为 "direct"
  n: number; // 连接数
  ok: number; // 未失败数
  p50: number; // 首字节中位数
  p95: number; // 首字节 p95
  dn: number; // 下行字节合计
  /**
   * 最近一次更新的时间（DO 侧填）。
   *
   * 为什么需要它：n/ok/dn 是**累计**，而 p50/p95 只代表最近一次上报的那一批样本 ——
   * 没有时间戳的话，读表的人无法判断「这条 p50 是刚测的还是三小时前的」，
   * 而 60 条上限的淘汰也只能按插入序切（先写进来的先被删），
   * 于是最该保留的「样本最多、刚刚还在用」的节点反而最先消失。
   */
  t?: number; // 最近一次更新的时间
}

/** 地址解析：成功 */
interface AddrOk {
  host: string;
  next: number;
  err?: undefined;
}
/** 地址解析：失败 */
interface AddrErr {
  err: string;
  host?: undefined;
  next?: undefined;
}
