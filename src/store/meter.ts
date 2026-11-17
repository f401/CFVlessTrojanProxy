import { factsOut } from "./factout";
import { unseal } from "./index";
import { MeterAdd } from "./meteradd";
import { cnt } from "../core/counter";
import { METER_DIAGNOSTICS } from "./meter-diagnostics";
import { readShards, saveState } from "./metershard";
import { MeterState } from "./meter-state";

/**
 * 用量账本（Durable Object，全局唯一）：一个用户一个实例，只有它能回答「已用多少字节」。
 *
 * 为什么必须是 DO：KV 最终一致、无法原子累加，多个 isolate 并发上报同一用户时只有单实例
 * 能把增量串行合并；配额判断与快照回写也在这一次串行里完成。
 * 与 `PendingLedger` 的分工：isolate 侧只攒增量、失败回滚；DO 侧落账、判额度、维护内存快照。
 * 账本本体与落盘映射在 `MeterState`（`src/store/meter-state.ts`），这里只管 DO 生命周期与端点。
 */
export class Meter {
  state: DurableObjectState;
  env: Env;
  /** 账本本体：五件账本 + 七张事实表 + 落盘形状（见 `MeterState`） */
  ledger: MeterState;
  /** 请求串行队列：/add 与 /set 交错会让内存和 storage 的顺序不一致 */
  q: Promise<unknown> = Promise.resolve();
  /** 端点分发器：`/add`、`/seed`、`/set` 与四个只读端点的实现都在同一个文件的 `MeterEndpoints` 里 */
  private readonly endpoints: MeterEndpoints;
  /**
   * 构造：从 storage 恢复累计值；blockConcurrencyWhile 保证恢复完成前不处理请求。
   * @param {DurableObjectState} state DO 状态对象（storage / blockConcurrencyWhile）
   * @param {Env} env 环境（KV / 密钥材料 / 计量实例名）
   */
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.ledger = new MeterState();
    // 端点拿到的是「账本本体 + DO 状态 + 落盘回调」三样，不持有 Meter 本身：
    // 否则回滚/落盘都要绕回外壳，端点的失败语义就说不清。
    this.endpoints = new MeterEndpoints(this.ledger, this.state, () => this.save());
    this.state.blockConcurrencyWhile(async () => {
      // 单键存储：每次 /add 只写 1 行。
      // 以前是 c/g/s/e 四个键 = 4 行，SQLite DO 的「行写入」额度（免费 10 万/天）
      // 会被吃掉 4 倍；一个持续活跃的 isolate 就要 3.4 万行/天。
      const all = await this.state.storage.get("a");
      if (all) {
        const o = await unseal<MeterBody>(env, all);
        if (o && typeof o === "object") {
          this.ledger.adopt(o);
        } else {
          // 换过 kek、或值被写坏：这份账本解不开。**不能当成「没有账本」静默从零开始** ——
          // 下一次 /add 就会把零值覆盖回去，历史用量与配额永久消失。这里只留底与计数，
          // 真正的写入让 save() 先把原文备份到 `a_bak`（人工可抢救）。
          cnt("doBad");
          this.ledger.keepBackup(all);
        }
        // 分片要在 `a` 之后再读：装不下时事实表搬去了 f1/f2/f3，只读 `a` 会看到空表
        await this.loadShards();
        return;
      }
      // 老结构（c/e/s/g 四个键）：读出来顺手迁到新键，再删掉旧的
      let migrated = false;
      const v = await this.state.storage.get("c");
      if (v) {
        const obj = await unseal<Record<string, number>>(env, v); // 兼容老的明文对象
        if (obj) {
          this.ledger.adoptUsage(obj);
          migrated = true;
        }
      }
      const ev = await this.state.storage.get("e");
      if (ev) {
        const o4 = await unseal<ErrItem[]>(env, ev);
        if (Array.isArray(o4)) {
          this.ledger.adoptErrors(o4);
          migrated = true;
        }
      }
      const sv = await this.state.storage.get("s");
      if (sv) {
        const o3 = await unseal<Record<string, NodeSnap>>(env, sv);
        if (o3 && typeof o3 === "object") {
          this.ledger.adoptSnapshots(o3);
          migrated = true;
        }
      }
      const gv = await this.state.storage.get("g");
      if (gv) {
        const obj2 = await unseal<Record<string, number>>(env, gv);
        if (obj2 && typeof obj2 === "object") {
          this.ledger.adoptDayCounter(obj2);
          migrated = true;
        }
      }
      if (migrated) {
        try {
          await this.save();
          for (const k of ["c", "e", "s", "g"]) await this.state.storage.delete(k);
        } catch (e) {}
        // 老布局的分片同样要读：从 7.218 起事实表可能只存在于 f1/f2/f3 里
        await this.loadShards();
      }
    });
  }

  /**
   * 把分片里的七张事实表读回内存（只在 `saveState()` 曾因体积拆过片时存在）。
   * 为什么单独一个方法：恢复有两条路径（新布局 `a`、老布局 `c/e/s/g`），分片对两条都适用，
   * 塞在任一条里都会让另一条漏读 —— 表现为「重启后事实全空」。
   * @returns {Promise<void>}
   */
  private async loadShards(): Promise<void> {
    const parts = await readShards(this.env, this.state.storage, this.ledger.fs);
    // 存储键与内存字段名不同（存储格式一经写入就不能改，否则老数据读不回来），
    // 逐项映射在 `MeterState.restore()` 里：改名时只改那一处。
    this.ledger.restore(parts);
  }

  /**
   * 把当前账本加密后写进 DO storage（装得下就单键 `a`，装不下按体积拆 `f1`/`f2`/`f3`）。
   * 体积预算与分片布局都在 `src/store/metershard.ts` 的 `saveState()` 里。
   * @returns {Promise<void>}
   */
  async save() {
    // 解不开的旧值只备份一次：`a_bak` 只给人工抢救用，不进任何读路径
    const bak = this.ledger.takeBackup();
    if (bak !== null) await this.state.storage.put("a_bak", bak);
    // 代号写回内存：下一次启动靠它判断「磁盘上的分片是不是上一轮的残留」
    this.ledger.fs = await saveState(this.env, this.state.storage, this.ledger.parts());
  }

  /**
   * DO 的请求入口：所有端点都交给 `MeterEndpoints`，这里只做串行化。
   * @param {Request} req 请求（`/add` 与 `/set` 的 body 为 JSON）
   * @returns {Promise<Response>} 端点响应
   */
  async fetch(req: Request): Promise<Response> {
    // DO 的异步存储操作会让多个请求在 await 处交错；这里按到达顺序串行化
    const run = this.q.then(() => this.endpoints.handle(req));
    this.q = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * 端点分发器：每次请求由 `Meter.fetch()` 在串行队列里调用一次。
 *
 * 顺序是契约的一部分：`/add` 必须排在诊断端点之前（诊断端点永远不落盘，
 * 而 `/add` 是唯一会改账本的），只读端点排在最后，兜底 `/get` 返回累计值。
 */
export class MeterEndpoints {
  /** `/add` 的合并器：八段口径各一个方法（见 `src/store/meteradd.ts`） */
  private readonly adder = new MeterAdd();

  /**
   * 构造：只保存账本、DO 状态与落盘回调，不做 I/O。
   * @param {MeterState} ledger 账本本体（`Meter` 持有并负责恢复）
   * @param {DurableObjectState} state DO 状态对象（诊断端点要用 storage）
   * @param {() => Promise<void>} persist 落盘回调（`Meter.save`）
   */
  constructor(
    private readonly ledger: MeterState,
    private readonly state: DurableObjectState,
    private readonly persist: () => Promise<void>,
  ) {}

  /**
   * 功能：按路径分派端点。
   * @param {Request} req 请求
   * @returns {Promise<Response>} 响应
   */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // `/add` 是唯一会改账本的端点，必须最先处理
    if (p.endsWith("/add")) return this.add(req);

    // 只读诊断端点（stage/tim/iter/burn/burnjs/crypto/tfb/tf）整体交给 MeterDiagnostics：
    // 它们不落盘、不碰账目，挤在这里只会把真正管账的那段埋掉。
    // 它们也不消费请求体，所以放在读账本之前不影响 `/seed`、`/set` 的 body。
    const diagnostic = await METER_DIAGNOSTICS.run(p, url, this.state);
    if (diagnostic) return diagnostic;

    const read = this.read(p);
    if (read) return read;

    // 灾备回填：只在当前为 0 时回填（天然幂等，重建 DO 后能自动恢复历史用量）
    if (p.endsWith("/seed")) return this.seed(req);
    if (p.endsWith("/set")) return this.set(req);

    // 兜底 `/get`：返回当前累计值
    return this.json();
  }

  /**
   * 功能：`/add` —— 把隔离侧攒的增量并进账本、落盘，失败回滚。
   * @param {Request} req 请求（body 为 `MeterBody`）
   * @returns {Promise<Response>} 当前累计值
   */
  private async add(req: Request): Promise<Response> {
    const d = await this.readBody(req);
    // 快照只覆盖「就地累加」的字段：事实表按时间戳幂等、用量/日计数/节点快照整体替换，
    // 连接观测是加法合并（行在表里就地累加）—— 所以 `cl` 必须深拷，否则回滚回不去。
    const snap = this.ledger.snapshot();
    this.adder.apply(this.ledger, d);
    // 每次都落盘：DO 随时可能被驱逐，靠内存攒着会在驱逐时全丢；
    // 落盘失败必须回滚内存，否则 pendFlush 重发同一批会把用量算两遍。
    try {
      await this.persist();
    } catch (e) {
      this.ledger.rollback(snap);
      throw e;
    }
    return this.json();
  }

  /**
   * 功能：`/seed` —— 只在账本完全为空时回填（天然幂等，重建脚本后能自动恢复历史用量）。
   * @param {Request} req 请求（body 为 `MeterBody`）
   * @returns {Promise<Response>} 当前累计值
   */
  private async seed(req: Request): Promise<Response> {
    const d = await this.readBody(req);
    const usage = this.ledger.usage;
    // 三个维度都为 0 才算「空」：只看字节会让「只建过连接」的用户永远回填不上
    if ((usage.up || 0) + (usage.down || 0) + (usage.conns || 0) !== 0) return this.json();
    const oldC = { ...usage };
    const today = new Date().toISOString().slice(0, 10);
    const restoreDay = String(d.d || "") === today;
    usage.up = Number(d.up) || 0;
    usage.down = Number(d.down) || 0;
    usage.conns = Number(d.conns) || 0;
    usage.first = Number(d.first) || Date.now();
    usage.ts = Date.now();
    // 灾备快照里的当日字段：DO 被重建后"今日"不该从 0 开始；
    // 快照不是今天的，就保留本地值（不把昨天的当日量当成今天的）
    usage.d = restoreDay ? today : usage.d || "";
    usage.dU = restoreDay ? Number(d.dU) || 0 : usage.dU || 0;
    usage.dD = restoreDay ? Number(d.dD) || 0 : usage.dD || 0;
    try {
      await this.persist();
    } catch (e) {
      this.ledger.usage = oldC;
      throw e;
    }
    return this.json();
  }

  /**
   * 功能：`/set` —— 恢复历史累计，只在传入值更大时覆盖（幂等）。
   * @param {Request} req 请求（body 为 `MeterBody`）
   * @returns {Promise<Response>} 当前累计值
   */
  private async set(req: Request): Promise<Response> {
    const d = await this.readBody(req);
    const usage = this.ledger.usage;
    const cur = (usage.up || 0) + (usage.down || 0);
    const want = (Number(d.up) || 0) + (Number(d.down) || 0);
    // 连接数也是单调量：只看字节会让「只建过连接、没有可计量流量」的用户恢复不到
    // conns/first；`/seed` 的门槛是 up+down+conns，两条恢复路径的口径必须一致
    const curN = usage.conns || 0;
    const wantN = Number(d.conns) || 0;
    // 任一维度需要恢复才写（`want > cur || wantN > curN`）：只看字节会让「只建过连接、
    // 没有可计量流量」的用户恢复不到 conns/first —— `wantN > curN` 这一支就是为它留的。
    if (!(want > cur || wantN > curN)) return this.json();

    const oldC = { ...usage };
    // 恢复历史累计不能把"今日"一起抹掉；只有快照的 d 是今天才采纳 dU/dD
    const today = new Date().toISOString().slice(0, 10);
    const restoreDay = String(d.d || "") === today;
    const sameDay = usage.d === today;
    const dU = restoreDay
      ? Math.max(Number(d.dU) || 0, sameDay ? usage.dU || 0 : 0)
      : sameDay
        ? usage.dU || 0
        : 0;
    const dD = restoreDay
      ? Math.max(Number(d.dD) || 0, sameDay ? usage.dD || 0 : 0)
      : sameDay
        ? usage.dD || 0
        : 0;
    this.ledger.usage = {
      // 两维各自取大（v7.181）：以前无条件写成快照值，只看 conns 变大就会把
      // up/down 换成快照里的旧数（快照可能落后几小时）——面板与订阅头的累计用量倒退。
      up: Math.max(Number(d.up) || 0, usage.up || 0),
      down: Math.max(Number(d.down) || 0, usage.down || 0),
      // conns 取两者更大：快照可能比 DO 落后几小时，直接赋值会让面板的连接数变小
      conns: Math.max(wantN, curN),
      // first 取更早的非零值：重建后不能把「首次使用时间」推后
      first: this.earlierFirst(Number(d.first) || 0, usage.first || 0),
      ts: Date.now(),
      d: restoreDay || sameDay ? today : usage.d || "",
      dU,
      dD,
    };
    try {
      await this.persist();
    } catch (e) {
      this.ledger.usage = oldC;
      throw e;
    }
    return this.json();
  }

  /**
   * 功能：`first` 的两个候选里取更早的非零值（都为 0 时用当前时间）。
   * @param {number} fromSnap 快照里的首次使用时间
   * @param {number} local 账本里的首次使用时间
   * @returns {number} 更早的那个非零值
   */
  private earlierFirst(fromSnap: number, local: number): number {
    if (fromSnap > 0 && local > 0) return Math.min(fromSnap, local);
    return fromSnap || local || Date.now();
  }

  /**
   * 功能：四个只读端点的出站形状（`/cl`、`/hl`、`/vt`、`/cnt`）。
   * @param {string} p 请求路径
   * @returns {Response | null} 命中就返回响应，没命中返回 null
   */
  private read(p: string): Response | null {
    if (p.endsWith("/cl")) return Response.json({ cl: this.ledger.connRing });
    if (p.endsWith("/hl")) {
      const rows = Object.entries(this.ledger.hl).map(([i, x]) => ({
        i,
        o: x.o,
        b: x.b,
        d: x.d,
        t: Number(x.t) || 0,
      }));
      // 按证据时间降序出站（v7.216）：以前按「坏证据条数」排，于是表里超过 120 条中继时，
      // 只有一两条新证据的中继永远排在最后、一条都发不出去 —— 而「这条中继刚刚成功过」
      // 正是最该扩散给别的 isolate 的那条证据（30 分钟半衰期，还没等它排上队就过期了）。
      // 存储侧本来就只留最新的 200 条（同一条判据），出站再按新鲜度切才自洽；
      // 条数只当并列时的次序，避免同一毫秒写入的行顺序抖动。
      rows.sort((a, b) => b.t - a.t || b.d + b.b - (a.d + a.b));
      return Response.json({ hl: rows.slice(0, 120) });
    }
    // 七张表的出站形状与切片顺序都在 src/store/factout.ts（v7.187）
    if (p.endsWith("/vt")) return Response.json(factsOut(this.ledger));
    if (p.endsWith("/cnt")) {
      return Response.json({
        g: this.ledger.dayCounter,
        c: this.ledger.usage,
        s: this.ledger.nodeSnapshots,
        e: this.ledger.errors,
      });
    }
    return null;
  }

  /**
   * 功能：读 JSON 请求体；不是对象就当空体（三条改账本的端点共用这一段容错）。
   * @param {Request} req 请求
   * @returns {Promise<MeterBody>} 解析结果，非法时为空对象
   */
  private async readBody(req: Request): Promise<MeterBody> {
    try {
      const j = await req.json();
      if (j && typeof j === "object" && !Array.isArray(j)) return j as MeterBody;
    } catch (e) {
      // 客户端可能发空体或截断的 JSON：当成「没有任何增量」而不是 500
    }
    return {};
  }

  /**
   * 功能：把当前累计值序列化成 JSON 响应。
   * @returns {Response} 200 + {up, down, conns, first, ts}
   */
  private json(): Response {
    return Response.json(this.ledger.usage);
  }
}
