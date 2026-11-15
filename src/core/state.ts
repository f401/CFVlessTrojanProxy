/**
 * 全局可变状态（每个 isolate 一份）
 *
 * 以前这些是散落在 px.ts / store.ts / metrics.ts 里的裸 `let`，任何一个文件
 * 都能随手改，改坏了很难定位。现在统一收进 AppState，由 S 单例持有：
 *   · 想改状态 → 只能通过 S.xxx
 *   · 想知道"谁动了它" → 全仓搜索 S.xxx
 */
export class AppState {
  site = "";
  /** 通道策略影子统计：建议与现状一致的次数 / 不一致次数 / 原因分布 */
  polSame = 0;
  polDiff = 0;
  polWhy: Record<string, number> = {}; // 策略建议的原因分布：polWhy[reason]++
  // —— 节点与选择 ——
  alive: Map<string, NodeEntry> = new Map();
  nstat: Map<string, NodeStats> = new Map();
  curs: Record<string, string> = { lat: "", tput: "" };
  prev: Record<string, string> = { lat: "", tput: "" };
  lastSwitch: Record<string, number> = { lat: 0, tput: 0 };
  switchHits: Record<string, number[]> = { lat: [], tput: [] };
  lastManual = 0;
  pxFailMem = 0;
  pxFailSeen = 0;
  probes = 0;
  hits = 0;
  // 探活结果按原因分类：区分"连不上"（可能是地区/线路）和"连上了但不是 CF 反代"（节点事实）
  probeWhy: Record<string, number> = {};
  // 候选池的本地探活结论（只在本 isolate 有效，不写 KV）：连续失败的候选不再占探测名额
  /** 探活连续失败次数 + 最后一次失败时间（带时间戳，超时自动作废） */
  probeBad: Map<string, { n: number; at: number }> = new Map();
  probeColo = "";
  /** 待复测：上一轮探活比同 /24 邻居慢一大截的节点（探活抖动一次不该定生死） */
  reProbe: string[] = [];
  /** 复测累计次数：线上用它判断"探活抖动"到底有多频繁（=0 说明这条优化没触发过） */
  reProbeN = 0; // 这批探活是在哪个机房做的（cron 拿不到 colo，记 "cron"）
  needPx: Map<string, number> = new Map();
  /** 站点最近一次「大响应」时间（用来做跨通道差分：别的通道能打通才算这条被封） */
  bigByHost: Map<string, number> = new Map();
  /** 最近一次大响应来自哪条通道（用于「差分」判封锁：同站点不同通道对比） */
  bigChan: Map<string, string> = new Map();
  /** 每「站点|通道」的小响应连击数 */
  smCnt: Map<string, number> = new Map();
  /** 每个站点最近 120s 内各通道的观测（环形 8 条）：v8 的「同窗口对照」 */
  peers: Map<string, Array<{ ck: string; down: number; at: number }>> = new Map();
  /** 每个站点见过的最大响应字节数：v8 的 bigTypical（tiny 的相对判据要用） */
  bigTyp: Map<string, number> = new Map();
  /** 复核队列：流量发现「可疑」后排队做同站点两条通道的实测差分 */
  vtQ: Array<{ host: string; ck: string; t: number }> = [];
  /** 最近一次复核的结果（供 debug 展示） */
  vtLast: { host: string; ck: string; a: number; b: number; v: string; at: number } | null = null;
  colo = "";
  funnel: Record<string, number> = { direct: 0, node: 0, v6: 0 };
  candN = 0; // 最近一次 candsFor 的候选数（观测用）
  inflight: Map<string, number> = new Map(); // 节点在途连接数（负载均衡用）
  // 候选排行缓存：只在大规模（alive≥24）时启用，各模式各自 20 秒
  // t 是全局作废戳（0 = 作废），at[m] 是该模式真正写入的时间
  rankCache: {
    t: number;
    at: Record<string, number>;
    v: Record<string, RankRow[]>;
    // 分片重建：大池一次算不完，用每次 pick 顺带推进一片，期间继续用上一版排行
    step: Record<string, { keys: string[]; pos: number; top: RankRow[]; extra: RankRow[]; ok: number }>;
  } = { t: 0, at: {}, v: {}, step: {} };
  // Thompson 采样的成员表缓存（按延迟前 TS_K 个），20 秒重建一次
  tsMem: { at: number; keys: string[] } = { at: 0, keys: [] };

  // —— 日计数 ——
  cntKeys = [
    "restore",
    "restoreSkip",
    "egSent",
    "psNote",
    "psDO",
    "psSent",
    "deadNote",
    "deadDO",
    "deadClear",
    "ftSkip",
    "blkBatch",
    "blkWrote",
    "blkNoPeer",
    "blkDO",
    "bizSweeps",
    "blkContra",
    "egProbe",
    "factsJoin",
    "factsDo",
    "factsCacheHit",
    "capSet",
    "capNoise",
    "rehab",
    "cfDiff",
    "dnsProbe",
    "dnsDO",
    "egDO",
    "cfObs",
    "conn",
    "direct",
    "node",
    "eCloseD",
    "eCloseP",
    "px4",
    "e4retry",
    "tfb",
    "pxf",
    "sw",
    "noCand",
    "tput",
    "stall",
    "cut",
    "ccut",
    "dead",
    "noPayload",
    "noAuth",
    "wsFail",
    "vtSeen",
    "vtPend",
    "vtSent",
    "vtDO",
    "trHit",
    "trSmall",
    "smN",
    "smD",
    "sz1",
    "sz2",
    "sz3",
    "sz4",
    "szBig",
    "vwild",
  ];
  cnt: Record<string, number> = {};
  cntDay = "";
  cntSent: Record<string, number> = {};

  // —— 信誉表与候选池 ——
  seed: Seed = { v: 0, ts: 0, poolGen: 0, poolN: 0, builtAt: 0, byColo: {}, cnt: null };
  gcnt: CounterDoc | null = null;
  seedAt = 0;
  seedDirty = false;
  /** 上一次读 seed 是否失败：失败时 write 必须跳过，不能拿空表覆盖别人的桶 */
  seedReadFail = false;
  pool: PoolEntry[] = [];
  /** 已上报到 DO 的判定（键 `target|chan`，值 = 到期时间） */
  /** 已交给上报、等待 ack 的强证据（k → 到期时间） */
  vtPend: Map<string, number> = new Map();
  vtSent: Map<string, number> = new Map();
  vtLoaded = false;
  /** 事实读失败后的冷却截止时间：失败一次不该把这个 isolate 的事实层永久关掉（v8 §20.5 允许 60 秒后重试） */
  vtCool = 0;
  /** 最近一次从事实层读到的 v4 出口（订阅渲染要把它们发成可实测的中继条目） */
  eg4Top: string[] = [];
  /** 本 isolate 解析过的事实开关（`env.facts`，见 `src/route/factflags.ts`）。 */
  factSet: Set<string> | null = null;
  /** 冷启动事实读取的 single-flight 句柄：同一波次并发连接共用一次 DO 读（null = 没有在飞）。 */
  vtFlight: Promise<void> | null = null;
  scanN = 12;
  poolIdx = 0;
  poolGen = 0;
  poolBuilt = 0;
  poolAt = 0; // 上次「按需加载候选池」的尝试时间（冷 isolate 首次连接用，节流 60 秒）
  aliveAt = 0; // 上次「按需起搏探活」的时间（冷 isolate 一条中继都没有时用，节流 5 分钟）

  // —— 计量 ——
  stats: Map<string, StatsLocal> = new Map();
  pend: Map<string, PendEntry> = new Map();
  pendAt = 0;
  pendMs = 30000; // 推送间隔地板：30 秒（原来 10 秒，DO 请求量 ×3）
  tflush: ReturnType<typeof setTimeout> | null = null;
  pendBytes = 0;
  doCalls = 0;
  meterCache: Map<string, { v: UsageMeter | null; t: number }> = new Map();
  statCache: Map<string, { v: StatsView; t: number }> = new Map();
  snapCache: { v: SnapDoc | null; t: number } = { v: null, t: 0 };
  /** 跨 isolate 的节点快照（Meter DO 里的 s），面板用；60 秒缓存 */
  nodeSnapCache: { t: number; v: Record<string, NodeSnap> } = { t: 0, v: {} };
  snapWritten = 0;
  snapBusy = false; // flushSnap 在飞：并发收尾只允许一个写
  snapChecked = 0; // 上次检查全局闸门的时间（避免每条连接都读一次 KV）
  snapBytes = 0;
  kvw = 0;
  kvStat: { ok: boolean | null; key: string; at: number; err?: string; quota?: boolean; quotaAt?: number } = {
    ok: null,
    key: "",
    at: 0,
  };

  // —— 按站点的节点画像（诊断 / 站点级偏好用）——
  //   hostNode[host][node] = {n, ok, bad, bytes, ttfb, at}
  //   只保留最近活跃的 120 个域名，每个域名最多 12 个节点
  hostNode: Map<string, Map<string, HNStat>> = new Map();
  hostDirect: Map<string, HDirect> = new Map();
  // 站点排行缓存（family|mode → 排好序的列表，30 秒），避免每次连接都重算
  hostRankCache: Map<string, { t: number; v: RankRow[] }> = new Map();
  nsWriteAt = 0;
  cronBusy = false; // cron 在跑：Cron Triggers 偶发重投递时不再叠加一轮

  // —— 用户与观测 ——
  usersCache: { v: Auth | null; t: number } = { v: null, t: 0 };
  usersSig = "";
  rtt: Map<string, Record<string, RttEntry>> = new Map();
  rttMiss: Map<string, number> = new Map(); // rtt:<id> 不存在时的负缓存（省 KV 读）
  errs: ErrItem[] = [];
  cagg: Map<string, { n: number; ok: number; dn: number; v: number[] }> = new Map(); // 连接观测按节点聚合

  // —— DNS 缓存 ——
  dnsCache: Map<string, { ip: string; t: number }> = new Map();
  v4AllCache: Map<string, { ips: string[]; t: number }> = new Map();
  /** 命中过 Cloudflare 托管的目标（host → 过期时间），省掉重复解析 */
  cfHost: Map<string, number> = new Map();
  cfHttp: Map<string, { code: number; colo: string; t: number }> = new Map();
  aaaaCache: Map<string, { ip: string; t: number }> = new Map();

  constructor() {
    // 计数器按 CNT_KEYS 初始化成 0，避免"某个键忘了写"导致 undefined
    for (const k of this.cntKeys) {
      this.cnt[k] = 0;
      this.cntSent[k] = 0;
    }
  }
}

export const S = new AppState();

