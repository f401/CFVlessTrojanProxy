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
  pxFailMem = 0;
  pxFailSeen = 0;
  probes = 0;
  hits = 0;
  // 探活结果按原因分类：区分"连不上"（可能是地区/线路）和"连上了但不是 CF 反代"（节点事实）
  probeWhy: Record<string, number> = {};
  probeColo = "";
  needPx: Map<string, number> = new Map();
  /**
   * 每个站点上一批 tfb 的判定标签（`verdict/escalate`，例如 `chan/none`）。
   * 两个用途：① `tfb` 的两批共识（只有上一批也是 `chan` 才落封锁）；
   * ② 日志去重（标签没变就不重复写 `/logs`）。键是客户端给的站点名，因此必须限量。
   */
  tfbV: Map<string, string> = new Map();
  /** 每个站点最近 120s 内各通道的观测（环形 8 条）：v8 的「同窗口对照」 */
  peers: Map<string, Array<{ ck: string; down: number; at: number }>> = new Map();
  /** 每个站点见过的最大响应字节数：v8 的 bigTypical（tiny 的相对判据要用） */
  colo = "";
  funnel: Record<string, number> = { direct: 0, node: 0, v6: 0 };
  candN = 0; // 最近一次 candsFor 的候选数（观测用）
  inflight: Map<string, number> = new Map(); // 节点在途连接数（负载均衡用）
  // 候选排行的作废代数：谁发现「排序前提变了」就 +1，候选表（`CANDS`）自己比对代数决定是否重算。
  // 之所以放一个整数而不是那张缓存对象：缓存是候选表自己的状态（7.315 起搬进 `CandidateBoard`），
  // 这里只留「上一次作废是第几代」这一条能与它对齐的最小信息。
  rankGen = 0;

  // —— 日计数 ——

  // —— 信誉表与候选池 ——
  seed: Seed = { v: 0, ts: 0, poolGen: 0, poolN: 0, builtAt: 0, byColo: {}, cnt: null };
  seedDirty = false;
  /** 上一次读 seed 是否失败：失败时 write 必须跳过，不能拿空表覆盖别人的桶 */
  pool: PoolEntry[] = [];
  vtLoaded = false;
  /** 最近一次从事实层读到的 v4 出口（订阅渲染要把它们发成可实测的中继条目） */
  eg4Top: string[] = [];
  /** 本 isolate 解析过的事实开关（`env.facts`，见 `src/route/factflags.ts`）。 */
  factSet: Set<string> | null = null;
  /** 冷启动事实读取的 single-flight 句柄：同一波次并发连接共用一次 DO 读（null = 没有在飞）。 */
  scanN = 12;
  poolIdx = 0;
  poolGen = 0;
  poolBuilt = 0;

  // —— 计量 ——
  stats: Map<string, StatsLocal> = new Map();
  pend: Map<string, PendEntry> = new Map();
  /** 上报批次在途：同一 isolate 同时只跑一批，避免两批各 carry 同一组事实、先 ack 的把后一批的在途行一起清掉 */
  pendMs = 30000; // 推送间隔地板：30 秒（原来 10 秒，DO 请求量 ×3）
  pendBytes = 0;
  doCalls = 0;
  /** 增量上报的游标：一轮只带 PEND_MAX 个用户，下一轮从上次停下的位置继续（否则尾部永远排不上） */
  meterCache: Map<string, { v: UsageMeter | null; t: number }> = new Map();
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

  // —— 用户与观测 ——
  rtt: Map<string, Record<string, RttEntry>> = new Map();
  rttMiss: Map<string, number> = new Map(); // rtt:<id> 不存在时的负缓存（省 KV 读）
  errs: ErrItem[] = [];
  cagg: Map<string, { n: number; ok: number; dn: number; v: number[] }> = new Map(); // 连接观测按节点聚合

  /** CF HTTP 判定缓存：跨模块共享，仍由 S 持有 */
  cfHttp: Map<string, { code: number; colo: string; t: number }> = new Map();

  /**
   * 地区面板的已排序节点行缓存（短 TTL）。GET 每次重建 1600 行 + 排序会吃满免费版 10ms
   * CPU 预算，连续几次就触发 1102；面板是只读展示，允许几秒陈旧。rows 用 unknown[] 存，
   * 避免 core 依赖 routes 的类型。
   */
  regionRowsCache: { t: number; key: string; rows: unknown[] } | null = null;

  /**
   * `?format=json` 的序列化结果缓存（key = 站点 | 条数上限）。
   * 全量 1600 行序列化出来约 650 KB，每次重算 stringify + 覆盖率统计会吃满免费版 CPU
   * （实测 3 并发 61 秒里 26% 被 503 Worker exceeded resource limits）。
   * 与 regionRowsCache 同为 30 秒，面板轮询命中即零成本。
   */
  regionJsonCache: { t: number; key: string; text: string } | null = null;

  /** 本 isolate 累计下行字节（只用于取证：判断平台是否有「每 isolate 出流量上限」） */
  egressB = 0;

}

export const S = new AppState();

