/**
 * 全局可变状态（每个 isolate 一份）
 *
 * 以前这些是散落在 px.ts / store.ts / metrics.ts 里的裸 `let`，任何一个文件
 * 都能随手改，改坏了很难定位。现在统一收进 AppState，由 S 单例持有：
 *   · 想改状态 → 只能通过 S.xxx
 *   · 想知道"谁动了它" → 全仓搜索 S.xxx
 */
export class AppState {
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
  needPx: Map<string, number> = new Map();
  colo = "";
  funnel: Record<string, number> = { direct: 0, node: 0, v6: 0 };
  candN = 0; // 最近一次 candsFor 的候选数（观测用）
  inflight: Map<string, number> = new Map(); // 节点在途连接数（负载均衡用）
  // 候选排行缓存：只在大规模（alive≥24）时启用，20 秒一轮
  rankCache: { t: number; v: Record<string, RankRow[]> } = { t: 0, v: {} };

  // —— 日计数 ——
  cntKeys = [
    "conn",
    "direct",
    "node",
    "eCloseD",
    "eCloseP",
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
  scanN = 12;
  poolIdx = 0;
  poolGen = 0;
  poolBuilt = 0;

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

  // —— DNS 缓存 ——
  dnsCache: Map<string, { ip: string; t: number }> = new Map();
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
