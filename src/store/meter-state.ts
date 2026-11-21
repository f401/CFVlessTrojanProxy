import type { FactTables, MeterStore } from "./metershard";

/**
 * `/add` 失败时回滚用的一份账本快照。
 *
 * 只覆盖「就地累加」的五件账本：用量、日计数、节点快照、错误环、连接观测。
 * 七张事实表按时间戳幂等（重发同一批不会重复计数），不需要回滚；
 * 唯独连接观测是**在表里就地累加**的，所以 `connRing` 必须深拷，否则回滚回不去。
 */
export interface LedgerSnapshot {
  /** 用量累计 */
  usage: UsageMeter;
  /** 全局日计数 */
  dayCounter: CounterDoc;
  /** 跨 isolate 的节点快照 */
  nodeSnapshots: Record<string, NodeSnap>;
  /** 错误环 */
  errors: ErrItem[];
  /** 连接观测环 */
  connRing: ClRec[];
}

/**
 * 计量 DO 的账本本体：五件账本 + 七张事实表 + 落盘形状。
 *
 * 为什么从 `Meter` 里拆出来：`Meter` 的职责是「DO 生命周期 + 端点分发」，
 * 而「这些字段怎么落盘、怎么从盘上读回来、老布局怎么迁移」是另一件事 ——
 * 混在一个类里时，改一个字段名要同时改恢复、落盘、回滚三处，漏一处不会有任何门禁变红
 * （v7.274 的 `restore()` 就是为了断开「改名」与「老数据兼容」的绑定才出现的）。
 * 现在映射只写在这一处：字段名是内存口径，`MeterStore` 的键是落盘口径。
 */
export class MeterState implements FactTables {
  /** 用量累计（`/get` 的响应体就是它） */
  usage: UsageMeter;
  /** 全局日计数（连接/走节点/断流…，按 UTC 日期一行） */
  dayCounter: CounterDoc;
  /** 跨 isolate 的节点快照（键 = 节点键） */
  nodeSnapshots: Record<string, NodeSnap>;
  /** 跨 isolate 的错误环（最多 50 条） */
  errors: ErrItem[];
  /** 连接记录环形：最近 60 条，离线标定用 */
  connRing: ClRec[];
  /*
   * 七张事实表的行形状单一真源在 metershard.ts 的 FactTables（line protocol）。
   * 这里 implements 它：任何一处的行类型漂移都会在编译期暴露，而不是四处各改一半。
   * 语义备忘：vt 老行是裸数字（状态默认 2，v7.164 起存 {s,t} 才保住 dead 的硬排除）；
   * hl.t 缺省表示 7.160 之前的老行；eg/ps/blk/dns 只折价，永不剔候选。
   */
  /** 判定表：`站点|通道` → 到期时间或 `{ s: 状态, t: 到期 }` */
  vt: FactTables["vt"];
  /** 中继存活度：ip → 计数 + 最后观测时间 */
  hl: FactTables["hl"];
  /** 出口族事实：ip → { f: 4|6, at } */
  eg: FactTables["eg"];
  /** 「站点 × 中继」成功率事实 */
  ps: FactTables["ps"];
  /** 中继「连不上」事实 */
  dead: FactTables["dead"];
  /** 单 IP 封锁事实 */
  blk2: FactTables["blk2"];
  /** DNS 事实 */
  dns: FactTables["dns"];
  /** 事实表代号：`a` 里记的号与分片里的号不同就说明分片是上一轮的残留（v7.219） */
  fs: number;
  /** 读不出来的 `a` 原文（换过 kek 或值被写坏）：第一次落盘前先备份到 `a_bak` */
  private bakRaw: unknown;

  /** 构造：全部字段回到「没有任何证据」的初值（`fs = 0` 表示事实就在 `a` 里、不读分片） */
  constructor() {
    this.usage = { up: 0, down: 0, conns: 0, first: 0, ts: 0, d: "", dU: 0, dD: 0 };
    this.dayCounter = { d: "" };
    // 节点 key 来自 ?spd 的外部快照：用 null 原型，`__proto__` 当键也不能改原型
    this.nodeSnapshots = Object.create(null) as Record<string, NodeSnap>;
    this.errors = [];
    this.connRing = [];
    this.vt = {};
    this.hl = {};
    this.eg = {};
    this.ps = {};
    this.dead = {};
    this.blk2 = {};
    this.dns = {};
    this.fs = 0;
    this.bakRaw = null;
  }

  /**
   * 把单键 `a` 解密后的整份账本装回内存（缺字段就保留默认值）。
   *
   * 逐项按「存储键 → 内存字段」映射，而不是 `Object.assign`：后者要求两侧键名逐字相同，
   * 于是「改字段名」与「读回老数据」被绑死。
   * @param {MeterBody} body 解密后的账本（键是落盘口径 `c`/`g`/`s`/`e`/`cl` + 七张事实表 + `fs`）
   * @returns {void}
   */
  adopt(body: MeterBody): void {
    if (body.c && typeof body.c === "object") this.usage = { ...this.usage, ...body.c };
    if (body.g && typeof body.g === "object") this.dayCounter = body.g as CounterDoc;
    if (body.s && typeof body.s === "object") this.nodeSnapshots = Object.assign(Object.create(null), body.s);
    if (Array.isArray(body.e)) this.errors = body.e;
    if (Array.isArray(body.cl)) this.connRing = body.cl as ClRec[];
    // 七张事实表：线格式在 `MeterBody` 里声明成「行数组」，而 DO 里存的是「键 → 证据」的映射
    // （DO 侧就是权威形状，跨 isolate 的出站切片在 factout 里做）。这里的 `as unknown as` 是
    // 「同一个值、两种口径」的显式说明；读端（`verdict.ts`/`factsOut`）本来就兼容老行格式。
    if (body.vt && typeof body.vt === "object") this.vt = body.vt as unknown as FactTables["vt"];
    if (body.hl && typeof body.hl === "object") this.hl = body.hl as unknown as FactTables["hl"];
    if (body.eg && typeof body.eg === "object") this.eg = body.eg as unknown as FactTables["eg"];
    if (body.ps && typeof body.ps === "object") this.ps = body.ps as unknown as FactTables["ps"];
    if (body.dead && typeof body.dead === "object") this.dead = body.dead as unknown as FactTables["dead"];
    if (body.blk2 && typeof body.blk2 === "object") this.blk2 = body.blk2 as unknown as FactTables["blk2"];
    if (body.dns && typeof body.dns === "object") this.dns = body.dns as unknown as FactTables["dns"];
    // 代号决定「要不要读分片」：0 表示事实就在这个值里，磁盘上的分片必是上一轮的残留
    this.fs = Number((body as unknown as { fs?: number }).fs) || 0;
  }

  /**
   * 老布局迁移之一：`c` 键里的用量（兼容更老的明文对象）。
   * @param {Record<string, number>} obj 老用量对象
   * @returns {void}
   */
  adoptUsage(obj: Record<string, number>): void {
    this.usage = { ...this.usage, ...obj };
  }

  /**
   * 老布局迁移之二：`e` 键里的错误环。
   * @param {ErrItem[]} list 老错误环
   * @returns {void}
   */
  adoptErrors(list: ErrItem[]): void {
    this.errors = list;
  }

  /**
   * 老布局迁移之三：`s` 键里的节点快照（同样用 null 原型）。
   * @param {Record<string, NodeSnap>} obj 老节点快照
   * @returns {void}
   */
  adoptSnapshots(obj: Record<string, NodeSnap>): void {
    this.nodeSnapshots = Object.assign(Object.create(null), obj);
  }

  /**
   * 老布局迁移之四：`g` 键里的日计数。
   * @param {Record<string, number>} obj 老日计数
   * @returns {void}
   */
  adoptDayCounter(obj: Record<string, number>): void {
    this.dayCounter = obj as CounterDoc;
  }

  /**
   * 把分片里读出的账本逐项装回内存。
   *
   * 五件账本整体替换（存储里的就是上一次落盘的完整值），只有用量做增量合并 ——
   * 它有「老值里有、存储里没有」的字段（`dU`/`dD` 是当日增量），覆盖会丢当天口径。
   * 七张事实表整张替换：旧格式（裸数字、缺 `at`）由各自的读取端兼容
   * （见 `src/route/verdict.ts` 与 `factsOut`），这里不做形状修补。
   * @param {MeterStore} parts 存储读出的账本（键是落盘格式）
   * @returns {void}
   */
  restore(parts: MeterStore): void {
    if (parts.c && typeof parts.c === "object") this.usage = { ...this.usage, ...parts.c };
    if (parts.g && typeof parts.g === "object") this.dayCounter = parts.g as CounterDoc;
    if (parts.s && typeof parts.s === "object") this.nodeSnapshots = Object.assign(Object.create(null), parts.s);
    if (Array.isArray(parts.e)) this.errors = parts.e as ErrItem[];
    // 用量做增量合并而不是覆盖：`dU`/`dD` 是当日增量，覆盖会丢当天的口径。
    if (Array.isArray(parts.cl)) this.connRing = parts.cl as ClRec[];
    if (parts.vt && typeof parts.vt === "object") this.vt = parts.vt;
    if (parts.hl && typeof parts.hl === "object") this.hl = parts.hl;
    if (parts.eg && typeof parts.eg === "object") this.eg = parts.eg;
    if (parts.ps && typeof parts.ps === "object") this.ps = parts.ps;
    if (parts.dead && typeof parts.dead === "object") this.dead = parts.dead;
    if (parts.blk2 && typeof parts.blk2 === "object") this.blk2 = parts.blk2;
    if (parts.dns && typeof parts.dns === "object") this.dns = parts.dns;
    // 七张事实表整张替换：旧格式（裸数字、缺 `at`）由读取端兼容，这里不修补形状。
  }

  /**
   * 把当前账本打成落盘形状（键是存储口径，改名只改这一处）。
   * @returns {MeterStore} 交给 `saveState()` 的账本
   */
  parts(): MeterStore {
    // 键名只在这一处出现：线格式与落盘格式都是 `c/g/s/e/cl`，长名只活在内存字段上。
    return {
      c: this.usage,
      g: this.dayCounter,
      s: this.nodeSnapshots,
      e: this.errors,
      cl: this.connRing,
      vt: this.vt,
      hl: this.hl,
      eg: this.eg,
      ps: this.ps,
      dead: this.dead,
      blk2: this.blk2,
      dns: this.dns,
    };
  }

  /**
   * 拍一张回滚快照（`/add` 落盘失败时用）。
   * @returns {LedgerSnapshot} 五件账本的深拷
   */
  snapshot(): LedgerSnapshot {
    return {
      usage: { ...this.usage },
      dayCounter: { ...this.dayCounter },
      nodeSnapshots: Object.assign(Object.create(null), this.nodeSnapshots),
      errors: this.errors.slice(),
      connRing: this.connRing.map((row) => ({ ...row })),
    };
  }

  /**
   * 把内存账本恢复到快照时的样子。
   * @param {LedgerSnapshot} snap `snapshot()` 拍下的快照
   * @returns {void}
   */
  rollback(snap: LedgerSnapshot): void {
    this.usage = snap.usage;
    this.dayCounter = snap.dayCounter;
    this.nodeSnapshots = snap.nodeSnapshots;
    this.errors = snap.errors;
    this.connRing = snap.connRing;
  }

  /**
   * 摘下「解不开的旧值」原文，供调用方备份一次（备份后必须清掉，否则每次落盘都重写）。
   * @returns {unknown} 原文；没有待备份的值时返回 `null`
   */
  takeBackup(): unknown {
    const raw = this.bakRaw;
    this.bakRaw = null;
    return raw;
  }

  /**
   * 记下「解不开的旧值」原文。
   *
   * 不能当成「没有账本」静默从零开始 —— 下一次 `/add` 就会把零值覆盖回去，
   * 历史用量与配额永久消失。这里只留底，真正的备份写入在 `Meter.save()` 里做。
   * @param {unknown} raw `a` 键里读出来的原文
   * @returns {void}
   */
  keepBackup(raw: unknown): void {
    this.bakRaw = raw;
  }
}
