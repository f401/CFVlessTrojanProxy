/**
 * 业务类型：Env 绑定 / 节点统计 / 信誉表
 * 目前是"渐进式"的：先给出形状，允许 optional，便于逐步替换 any
 */

interface Env {
  // —— 身份 ——
  uuid: string;
  uuids?: string;
  pwd?: string;            // Trojan 密码（裸密码或 uuid:密码）
  adminKey?: string;
  pageKey?: string;
  expireAt?: string;
  quotaBytes?: string;

  // —— 入口与订阅 ——
  nodes?: string;
  regions?: string;

  // —— 中转池 ——
  proxyip?: string;
  pxDwellMin?: string;
  pxFailMax?: string;
  pxForceAt?: string;
  pxSchedH?: string;
  pxShadow?: string;
  defaultMode?: string;
  cfIpv6?: string;

  // —— 存储 ——
  STATS: KVNamespace;
  METER: DurableObjectNamespace;
  kek?: string;

  [k: string]: any;
}

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
  pN: number;
  pSum: number;
  pSumSq: number;
  pF: number;
  tcp: number;
  tls: number;

  /** 真实流量：可用性 */
  tS: number;
  tF: number;
  okW: number;
  failW: number;
  eCloseP: number;
  eCloseD: number;

  /** 吞吐：直方图 + 卡顿 */
  stallMs: number;
  runMs: number;
  bytesDown: number;
  hist: number[];
  seedBps: number;

  /** 其它 */
  counted: number;
  [k: string]: any;
}

/** 存活节点（ALIVE 的值） */
interface NodeEntry {
  h: string;
  p: number;
  cc?: string;
  ms?: number;
  src?: string;
  [k: string]: any;
}

/** 信誉表里的一条（落盘用） */
interface SeedNode {
  k: string;
  h?: string;
  p?: number;
  cc?: string;
  ms?: number;
  tcp?: number;
  tls?: number;
  n?: number;
  f?: number;
  b?: number;
  at?: number;
}

/** 一个机房的桶 */
interface SeedBucket {
  ts?: number;
  lastSwitch?: number;
  nodes?: SeedNode[];
  /** 站点偏好：{h:族名, k:节点, ttfb, n, bad, at}，只存样本够的 */
  hp?: any[];
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
  cnt?: Record<string, any> | null;
  lastColo?: string;
}

/** 采样窗口 */
interface ConnWin {
  t0: number;
  bytes: number;
  drained: number;
  last?: number;
}

/** 一条 WS 连接的状态（数据面里传得最广的对象） */
interface ConnState {
  ipTag?: string;
  node?: string;          // 实际使用的中转节点 "h:p"，为空表示直连
  mode?: string;          // lat | tput
  trial?: boolean;        // 是否影子连接
  via?: string;           // direct | node | v6

  win?: ConnWin;
  lastEmit?: number;

  markedOk?: boolean;
  markedFail?: boolean;

  sock?: any;
  writer?: any;
  header?: any;
  headerSent?: boolean;

  up: number;
  down: number;
  reportedUp?: number;
  reportedDown?: number;
  t0?: number;
  id?: string | null;

  env?: any;
  ctx?: any;

  retried?: boolean;
  pxTries?: number;
  triedV6?: boolean;
  stallMs?: number;
  sockDown?: number;
  counted?: number;
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

/** usage:snap —— 各用户的用量水位（只增不减） */
interface UsageSnap {
  ts: number;
  users: Record<string, { up: number; down: number; conns: number; first?: number }>;
}

/** snap —— 当日统计快照 */
interface SnapDoc {
  v: number;
  ts: number;
  date: string;
  stats: Record<string, { up: number; down: number; conns: number; first?: number; last?: number }>;
  rtt: Record<string, RttEntry>;
  errs: any[];
  cnt?: Record<string, number>;
}

/** Meter DO 里存的用量累计 */
interface UsageMeter { up: number; down: number; conns: number; first: number; ts: number; d?: string; dU?: number; dD?: number }

/** 某个节点在某个站点上的画像（诊断用：谁对这个站不行） */
interface HNStat { n: number; ok: number; bad: number; bytes: number; ttfb: number; at: number }

/** 直连对照：这个站直连到底通不通 */
interface HDirect { ok: number; bad: number; at: number }

/** Meter DO 里存的节点快照（跨 isolate 展示用） */
interface NodeSnap { med: number; p90: number; cap: number; n: number; ts?: number; tf?: number; at: number }

/** 日计数（d + 若干计数字段） */
interface CounterDoc { d: string; [k: string]: any }

/** /add 的请求体（用量 + 计数 + 节点快照 + 错误） */
interface MeterBody {
  up?: number;
  down?: number;
  conns?: number;
  first?: number;
  c?: Record<string, any>;
  spd?: Record<string, NodeSnap>;
  e?: ErrItem[];
}

/** 一条错误日志 */
interface ErrItem { t: number; m: string; tag?: string }

/** Worker 侧的 WebSocket（客户端连接与服务端连接共用） */
interface WebSocketLike {
  accept(): void;
  send(data: any): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  bufferedAmount: number;
  binaryType?: string;
  addEventListener(t: string, f: (...a: any[]) => void): void;
  removeEventListener(t: string, f: (...a: any[]) => void): void;
}

/** 地址解析：成功 */
interface AddrOk { host: string; next: number; err?: undefined }
/** 地址解析：失败 */
interface AddrErr { err: string; host?: undefined; next?: undefined }
