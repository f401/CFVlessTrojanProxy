/**
 * 全局可变状态（每个 isolate 一份）
 *
 * 以前这些是散落在 px.ts / store.ts / metrics.ts 里的裸 `let`，任何一个文件
 * 都能随手改，改坏了很难定位。现在统一收进 AppState，由 S 单例持有：
 *   · 想改状态 → 只能通过 S.xxx
 *   · 想知道"谁动了它" → 全仓搜索 S.xxx
 */
class AppState {
  // —— 节点与选择 ——
  alive: Map<string, NodeEntry> = new Map();
  nstat: Map<string, NodeStats> = new Map();
  curs: Record<string, string> = { lat: "", tput: "" };
  prev: Record<string, string> = { lat: "", tput: "" };
  lastSwitch: Record<string, number> = { lat: 0, tput: 0 };
  switchHits: Record<string, number[]> = { lat: [], tput: [] };
  lastUp = 0;
  lastManual = 0;
  pxFailMem = 0;
  pxFailSeen = 0;
  probes = 0;
  hits = 0;
  needPx: Map<string, number> = new Map();
  colo = "";
  funnel: Record<string, number> = { direct: 0, node: 0, v6: 0 };

  // —— 日计数 ——
  cntKeys = ["conn", "direct", "node", "eCloseD", "eCloseP", "sw", "noCand",
    "tput", "stall", "cut", "dead", "noPayload", "noAuth", "wsFail"];
  cnt: Record<string, any> = {};
  cntSent: Record<string, any> = {};

  // —— 信誉表与候选池 ——
  seed: Seed = { v: 0, ts: 0, poolGen: 0, poolN: 0, builtAt: 0, byColo: {}, cnt: null };
  gcnt: any = null;
  seedAt = 0;
  seedDirty = false;
  pool: PoolEntry[] = [];
  scanN = 12;
  poolIdx = 0;
  poolGen = 0;
  poolBuilt = 0;

  // —— 计量 ——
  stats: Map<string, any> = new Map();
  pend: Map<string, any> = new Map();
  pendAt = 0;
  pendMs = 10000;
  tflush: any = null;
  pendBytes = 0;
  doCalls = 0;
  meterCache: Map<string, any> = new Map();
  statCache: Map<string, any> = new Map();
  snapCache: any = { v: null, t: 0 };
  snapWritten = 0;
  snapBytes = 0;
  kvw = 0;
  kvStat: any = { ok: null, key: "", at: 0 };

  // —— 按站点的节点画像（诊断 / 站点级偏好用）——
  //   hostNode[host][node] = {n, ok, bad, bytes, ttfb, at}
  //   只保留最近活跃的 120 个域名，每个域名最多 12 个节点
  hostNode: Map<string, Map<string, HNStat>> = new Map();
  hostDirect: Map<string, HDirect> = new Map();

  // —— 用户与观测 ——
  usersCache: { v: Auth | null; t: number } = { v: null, t: 0 };
  usersSig = "";
  rtt: Map<string, any> = new Map();
  errs: ErrItem[] = [];

  // —— DNS 缓存 ——
  dnsCache: Map<string, any> = new Map();
  aaaaCache: Map<string, any> = new Map();

  constructor() {
    // 计数器按 CNT_KEYS 初始化成 0，避免"某个键忘了写"导致 undefined
    for (const k of this.cntKeys) {
      this.cnt[k] = 0;
      this.cntSent[k] = 0;
    }
  }
}

const S = new AppState();
