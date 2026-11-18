import { S } from "../core/state";
import { logErr } from "../nodes/metrics";
import { NodeStatsTable, isBlack, isFrozen, CANDS } from "../nodes/score";
import { ProbeCooldown, pxGet, bumpProbeBad, noteProbe, AliveBoard, ALIVE_MAX } from "./alive";
import { POOL_TTL_MS, refillPool, probeSni, chunks, probeProxy } from "./probe";
import { commitPool, ensurePool } from "./poolgen";
import { SC } from "../core/const";
import { keyOf } from "./const";
import { HOOK } from "../core/hook";
import { SeedStore } from "./seed";
import { splitRelay } from "../core/relay-addr";
import { BudgetLedger } from "../core/budget-ledger";
import { BudgetedIO } from "../core/budgeted-io";
import { isBudgetExhausted } from "../core/budget-ledger";

// ---- 并入自 scan-probe.ts ----
// 新候选扫描：在「还没有结论」的候选里轮转，探一批，成功的进存活表并记样本。
//
// 与「存活节点复测」（`scan-alive.ts`）分开：那边的对象已经在表里、失败要记账；
// 这边的对象连表都没进、失败只记冷却，两者的失败语义完全不同。


/**
 * 新候选的执行器：持有这一轮的池子快照与准入名额。
 */
export class ScanProbe {
  /** 这一轮的候选池快照 */
  private readonly pool: PoolEntry[];
  /** 本轮准入名额（0 表示按池子大小自适应） */
  private readonly adm: number;
  /** 这一轮用的环境（`scanSub` 这类可调项从这里读） */
  private readonly env: Env;
  /** 这一轮探活能建几次连接：每次探活都从这里取号（cron 形态上限更大） */
  private readonly gate = new BudgetedIO(new BudgetLedger("cron"));

  /**
   * 功能：记下这一轮要扫的池子与配额。
   * @param pool 候选池快照
   * @param adm 本轮准入名额（0 表示自适应）
   * @param env Worker 环境
   */
  constructor(pool: PoolEntry[], adm: number, env: Env) {
    this.pool = pool;
    this.adm = adm;
    this.env = env;
  }

  /**
   * 功能：探一批「还没有结论」的新候选，并给同 /24 明显偏慢的节点打上「下一轮复测」。
   * @returns 无
   */
  async run(): Promise<void> {
    // 每轮扫多少：默认按「4 轮覆盖全池」，管理员的 ?scan= 只能往上抬，天花板 SCAN_MAX。
    // 120/轮时 1600 池要 6.7 小时才轮完，冷启动期（isolate 寿命短）等于永远只认识前 120 个。
    const want = this.adm > 0 ? this.adm : Math.max(S.scanN || 12, Math.ceil(this.pool.length / 4));
    // 子请求是硬上限：免费计划 50/次调用，每次探活 = 1 个 connect()。默认压在 48，
    // 付费计划或提高配额后用 env.scanSub 抬（仍不超过 SCAN_MAX）。
    const sub = Number(this.env.scanSub) > 0 ? Math.max(12, Number(this.env.scanSub)) : SC.SCAN_SUB;
    const scanN = Math.max(12, Math.min(Math.min(SC.SCAN_MAX, sub), want));
    // 只在「还没有结论」的候选里轮转：已经进池的（有流量样本，另有头部复测）和连续探活失败的
    // 不再占名额。公开池里九成以上是死的，纯轮转时它们每轮都被重复探一遍，好候选永远排不上。
    const open = this.pool.filter((c) => {
      const k = c.h + ":" + c.p;
      return !S.alive.has(k) && !ProbeCooldown.skip(k);
    });
    // 全都有结论时退回「没进池的候选」做低频复检（能在池里的靠头部复测 + 真实流量，不用再探活）
    const live = this.pool.filter((c) => !S.alive.has(c.h + ":" + c.p));
    const src = open.length ? open : live.length ? live : this.pool;
    const idx = S.poolIdx % Math.max(src.length, 1);
    const batch = src.slice(idx, idx + scanN);
    S.probeColo = S.colo || "cron";
    const rows = await probeBatch(batch.map((c) => c.h + ":" + c.p), this.gate);
    const hits: ProbeHit[] = [];
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i].r;
      noteProbe(x);
      bumpProbeBad(rows[i].k, !!(x && !x.bad));
      if (x && !x.bad) hits.push(x);
    }
    S.poolIdx = (idx + scanN) % Math.max(src.length, 1);
    S.probes += batch.length;
    S.hits += hits.length;
    this.markLaggards(hits);
    this.enterAlive(hits);
  }

  /**
   * 功能：同批对照 —— 同一个 /24 里其它节点都很快、只有它慢 3 倍以上，就排进下一轮复测。
   *
   * 不用绝对阈值（不同 /24 的基线差很多），也不动选路，只是多测一次。
   * @param hits 这一批探活的成功结果
   * @returns 无（写进 `S.reProbe`）
   */
  private markLaggards(hits: ProbeHit[]): void {
    const by24 = new Map<string, number[]>();
    for (const x of hits) {
      const p = String(x.h).split(".");
      if (p.length !== 4 || !(x.ms > 0)) continue;
      const k24 = p.slice(0, 3).join(".");
      const arr = by24.get(k24) || [];
      arr.push(x.ms);
      by24.set(k24, arr);
    }
    for (const x of hits) {
      const p = String(x.h).split(".");
      // 复测队列最多 8 条：再多就会把下一轮的探测预算全吃掉
      if (p.length !== 4 || !(x.ms > 0) || S.reProbe.length >= 8) continue;
      const arr = by24.get(p.slice(0, 3).join(".")) || [];
      // 少于此数无法算「同 /24 的中位」，单条样本的偏差不值得再测一次
      if (arr.length < 3) continue;
      const med = arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
      if (x.ms > Math.max(3 * med, 250) && !S.reProbe.includes(keyOf(x))) S.reProbe.push(keyOf(x));
    }
  }

  /**
   * 功能：把这一批成功的候选写进存活表并记节点统计。
   *
   * 探活 RTT 是「ClientHello → ServerHello」，与真实请求的首字节（含 TLS 握手）不是同一个量：
   * 写进 `nsLatency` 会让 `pSum` 停在 40ms 量级，第一条真实请求就 `cusumSum += 330 > CUSUM_H`
   * 把它冻 60 秒（7.183 在 `warm.ts` 修过同一处）。探活只贡献样本数与 `tcp`/`tls` 的 EWMA。
   * @param hits 这一批探活的成功结果
   * @returns 无
   */
  private enterAlive(hits: ProbeHit[]): void {
    for (const x of hits) {
      const k = keyOf(x);
      S.alive.set(k, {
        h: x.h,
        p: x.p,
        cc: x.cc || S.alive.get(k)?.cc || "",
        ms: x.ms,
      });
      NodeStatsTable.nsProbe(k, x.ms, x.tcp || x.ms, x.tls || 0);
    }
  }
}

// ---- 并入自 scan-alive.ts ----
// 存活节点复测：准入复测队列 → 头部（游标 + 吞吐前 3）→ 其余环切刷新延迟。
//
// 三段的差别只在「谁被选中」与「失败要不要记账」，探活动作本身由 `probe-batch.ts` 收口。


/**
 * 存活节点复测器：三段各自一个方法，状态全在 `S.alive` / `S.reProbe` 里。
 */
export class ScanAlive {
  /** 复测也要建连：每次探活从这里取号（cron 形态上限更大） */
  private readonly gate = new BudgetedIO(new BudgetLedger("cron"));

  /**
   * 功能：复测上一轮「比同 /24 邻居慢一大截」的节点。
   *
   * 一次抖动会被 EWMA 吃掉 30%，紧接着再测一次就能拉回来。
   * @returns 无
   */
  async retestFlagged(): Promise<void> {
    const again = S.reProbe.splice(0, 4);
    if (!again.length) return;
    S.reProbeN += again.length;
    // 这几条上一轮刚被测过，再慢也就一个建连预算，直接并发
    const rows = await Promise.all(again.map(async (k) => ({ k, r: await probeOne(k, this.gate) })));
    for (const { k, r } of rows) {
      noteProbe(r);
      if (r && !r.bad) {
        NodeStatsTable.nsProbe(k, r.ms, r.tcp || r.ms, r.tls || 0);
        // 复测结果比历史更慢时不要把存活表里的延迟改大：这里只做「拉回来」
        const a = S.alive.get(k);
        if (a && r.ms < (a.ms || 1e9)) a.ms = r.ms;
      }
    }
  }

  /**
   * 功能：算出「这一轮要复测的头部」：当前游标 + 吞吐分前 3 名。
   *
   * 以前这里取的是存活表的前三个 key（插入顺序），跟「前 3 名」没关系，
   * 真正该复测的头部节点反而一直轮不到。
   * @returns 最多 4 个候选键
   */
  keys(): string[] {
    const cur = S.curs.tput || S.curs.lat || "";
    const top3 = CANDS.list("tput")
      .map((x) => x.k)
      .filter((k) => k !== cur)
      .slice(0, 3);
    // 最多 4 条：游标 + 3 个头部，再多就挤占探新候选的 connect 名额
    return [cur, ...top3].filter(Boolean).slice(0, 4);
  }

  /**
   * 功能：重测当前游标 + 吞吐分前 3 名（失败即进冷却）。
   * @returns 无
   */
  async recheckHead(): Promise<void> {
    await this.probeInto(this.keys(), true);
  }

  /**
   * 功能：其余存活节点只刷新延迟，不参与拉黑（抖动不该把存活项打死）。
   *
   * 从 `poolIdx` 开始轮转，别每次都测同样 12 个（插入顺序靠前的会一直被溺爱）。
   * @returns 无
   */
  async refreshRest(): Promise<void> {
    const recheck = this.keys();
    const allRest = [...S.alive.keys()].filter((k) => !recheck.includes(k));
    const start = allRest.length ? S.poolIdx % allRest.length : 0;
    // 从游标处环形切 12 条：这个数字要和一轮的 connect 预算（PROBE_CONC × 段数）配得上
    const rest = [...allRest.slice(start), ...allRest.slice(0, start)].slice(0, 12);
    await this.probeInto(rest, true);
  }

  /**
   * 功能：按并发上限探一批存活节点：成功就刷新延迟与统计，失败记一次探活失败。
   * @param keys 要探的候选键
   * @param failCounts 失败是否记进 `nsProbeFail`
   * @returns 无
   */
  private async probeInto(keys: string[], failCounts: boolean): Promise<void> {
    if (!keys.length) return;
    const rows = await probeBatch(keys, this.gate);
    for (const { k, r } of rows) {
      noteProbe(r);
      if (r && !r.bad) {
        NodeStatsTable.nsProbe(k, r.ms, r.tcp || r.ms, r.tls || 0);
        // 存活表里的 `ms` 就是面板与池子裁剪用的「实测延迟」，成功即覆盖
        const a = S.alive.get(k);
        if (a) a.ms = r.ms;
      } else if (failCounts) {
        NodeStatsTable.nsProbeFail(k);
      }
    }
  }
}

// ---- 并入自 scan-house.ts ----
// 一轮维护的收尾三件事：裁两张表（存活表 / 节点统计表）、中转实测、把池子落盘。
//
// 三件事的共同点是「都不产生新候选，只清理与记账」：放在一起，读者一眼能看出
// 哪一段会删数据（裁剪）、哪一段会花预算（中转实测）、哪一段会写 KV（落盘）。


/**
 * 一轮维护的收尾器：裁剪与记账，不产生新候选。
 */
export class ScanHouse {
  // 存活表的读写器：无字段，状态全在 `S.alive`；7.350 前它是模块级 `ALIVE`。
  private readonly board = new AliveBoard();
  /** 中转实测与 SNI 复测都要建连：从这个闸门取号（cron 形态上限更大） */
  private readonly gate = new BudgetedIO(new BudgetLedger("cron"));
  /**
   * 功能：裁存活表 —— 先移出被重罚的（冷却 ≥30 分钟），再按上限裁到 `ALIVE_MAX`。
   * @param pool 这一轮的池子快照（裁剪时优先保留仍在池里的）
   * @returns 是否改动过（改动过要清站点排行缓存）
   */
  prune(pool: PoolEntry[]): boolean {
    const pruned = this.board.pruneOverPunished();
    const trimmed = this.board.trimToMax(pool);
    return pruned || trimmed;
  }

  /**
   * 功能：给存活表补国家码（只影响展示与地区分组，不参与打分）。
   * @returns 无
   */
  async countries(): Promise<void> {
    await this.board.fillCountries();
  }

  /**
   * 功能：清理节点统计表 —— 候选池一轮轮扫下去 `nstat` 只增不减（实测能到 2000+ 条），
   * 每条带一个 12 格直方图。清掉「不在存活表、没有吞吐样本、6 小时没动静」的，再对总量做硬上限。
   * @returns 无
   */
  trimStats(): void {
    const live = new Set(S.alive.keys());
    const cut = Date.now() - 6 * 3600e3;
    for (const [k, s] of S.nstat) {
      // 有下行样本的节点可能还在被选（候选表会读它的分），不能按「不在存活表」删
      if (live.has(k) || (s.bytesDown || 0) > 0) continue;
      if ((s.at || 0) > cut) continue;
      S.nstat.delete(k);
    }
    if (S.nstat.size > ALIVE_MAX) {
      const old = [...S.nstat.entries()].filter(([k]) => !live.has(k)).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
      for (const [k] of old) {
        // 超上限时裁到 75%：留着余量，免得下一轮又要全表排序
        if (S.nstat.size <= ALIVE_MAX * 0.75) break;
        S.nstat.delete(k);
      }
    }
  }

  /**
   * 功能：中转实测 —— 拿「实际失败过的站点」当目标，由池子自己判断哪个节点能替它出网。
   *
   * Worker 看不到 HTTP 状态码，但能看「这个节点有没有把该 SNI 的握手转出去」。
   * @returns 无
   */
  async relays(): Promise<void> {
    const tNow = Date.now();
    const targets: string[] = [];
    // 每轮最多两个站点：每次瞄准 = 4 条节点 × 一次握手，预算要留给探活
    for (const [h, t] of S.needPx) if (t > tNow && targets.length < 2) targets.push(h);
    if (!targets.length) return;
    const pool4 = (await this.board.list())
      .filter((x) => !isBlack(keyOf(x)) && !isFrozen(keyOf(x)))
      .slice(0, 4);
    if (!pool4.length) return;
    for (const h of targets) {
      // 探测本身失败也只当「没转出去」：这里要的是可用的那条，不是错误分类
      const res = (await Promise.all(
        pool4.map((x) => probeSni(x.h, x.p, h, 2200, this.gate).catch((e) => {
          if (isBudgetExhausted(e)) throw e; // 额度耗尽不是探测失败，别上报成中继坏（F1.2）
          return { err: "tcp" } as { hs?: number };
        })),
      )) as { hs?: number }[];
      res.forEach((x, i) => {
        if (HOOK.relayProbe) HOOK.relayProbe(h, pool4[i].h, !!x.hs, x.hs || 0);
      });
    }
  }

  /**
   * 功能：每轮最多写一次 seed，且两次落盘间隔 ≥55 分钟（`S.seed.ts` 来自 KV，跨 isolate 有效）。
   *
   * cron 是 30 分钟一轮，早先每轮都强制写 = 48 次/天，光这一项就吃掉 5% 的日额度。
   * @param env Worker 环境
   * @returns 无
   */
  async persistSeed(env: Env): Promise<void> {
    if (Date.now() - (S.seed.ts || 0) >= 55 * 60000) {
      await SeedStore.write(env, S.colo ? undefined : true, true);
    }
  }
}

// ---- 并入自 probe-batch.ts ----
// 探活批处理：把「一批候选键」按并发上限切成段，逐段握手，结果原样交回。
//
// 抽出来是因为池子维护、头部复测、新候选扫描三处都做同一件事（切段 + 并发 + 收集），
// 而并发上限 `SC.PROBE_CONC` 是免费计划最容易撞线的额度（全局同时只有 6 个 `connect()`）。


/**
 * 一条探活结果（`bad` 非空表示失败原因；`tcp`/`tls` 是两段握手的耗时）。
 *
 * 继承 `NodeEntry` 而不是另立一份：探活结果要直接喂给 `keyOf()` 与存活表，
 * 那两个函数的入参是 `NodeEntry`，形状不一致时只能靠 `as` 硬转 —— 转错不会有任何编译错误。
 */
export interface ProbeHit extends NodeEntry {
  /** 探活耗时（毫秒，两段握手之和）；`NodeEntry` 里它是可选的，这里必须有值才算命中 */
  ms: number;
  /** TCP 段耗时（失败时是它先失败，两者一起看才分得清是网络还是 TLS） */
  tcp?: number;
  /** TLS 段耗时 */
  tls?: number;
  /** 失败原因（`err`/`notTls`/`noCf` 等，写进 `S.probeWhy` 的同一套词） */
  bad?: string;
}

/**
 * 功能：探一条候选（键形如 `host:port`）。
 * @param key 候选键
 * @returns 探活结果；解析不出端口时回 `null`
 */
export async function probeOne(key: string, gate: BudgetedIO = BudgetedIO.unlimited()): Promise<ProbeHit | null> {
  const [probeHost, probePort] = splitRelay(key, 443);
  return (await probeProxy(probeHost, probePort, gate)) as ProbeHit | null;
}

/**
 * 功能：按并发上限探一批候选键（顺序与入参一致，失败项原样留在结果里）。
 *
 * `SC.PROBE_CONC` 是段大小而不是总并发：超时那条会被 `probeProxy` 内部收口，
 * 所以段与段之间不必再等待，串行发段只是为了让同时在飞的握手数不超过额度。
 * @param keys 候选键
 * @returns 与 `keys` 一一对应的结果
 */
export async function probeBatch(keys: string[], gate: BudgetedIO = BudgetedIO.unlimited()): Promise<Array<{ k: string; r: ProbeHit | null }>> {
  const out: Array<{ k: string; r: ProbeHit | null }> = [];
  for (const seg of chunks(keys, SC.PROBE_CONC)) {
    const part = await Promise.all(seg.map(async (k) => ({ k, r: await probeOne(k, gate) })));
    for (const row of part) out.push(row);
  }
  return out;
}

// ---- 门面（对外导出面保持不变） ----
// 池子维护的一轮编排：取池子 → 新候选扫描 → 存活复测 → 裁剪与统计 → 中转实测 → 落盘。
//
// 八段的具体动作分别住在三个文件里（`scan-probe.ts` 探新、`scan-alive.ts` 复测、
// `scan-house.ts` 清理与记账），这里只保留顺序 —— 改一段不用再数行号，
// 也能一眼看出「哪一段会花 connect 名额、哪一段会删数据、哪一段会写 KV」。


/**
 * 一轮池子维护的执行器。持有「这一轮」的池子快照与预算，每段一个执行器，`run()` 只负责顺序。
 */
export class PoolScan {
  /** 这一轮用的环境（`scanSub` 这类可调项从这里读） */
  private readonly env: Env;
  /** 本轮准入名额（0 表示按池子大小自适应） */
  private readonly adm: number;
  /** 这一轮的候选池快照：重建成功后立刻换成新的，后面所有段落都用它 */
  private pool: PoolEntry[] = [];
  /** 存活节点复测器（无自有状态，章节全在 `S` 里） */
  private readonly alive = new ScanAlive();
  /** 收尾器：裁剪、统计、中转实测、落盘 */
  private readonly house = new ScanHouse();

  /**
   * 功能：记下这一轮的环境与配额。
   * @param env Worker 环境
   * @param adm 本轮准入名额（0 表示按池子大小自适应）
   */
  constructor(env: Env, adm = 0) {
    this.env = env;
    this.adm = adm;
  }

  /**
   * 功能：跑完整的一轮。任一段失败都不影响后面的段落（各段自有 try/catch 的调用方在 cron）。
   * @returns 无
   */
  async run(): Promise<void> {
    // 每轮先收拾「暂时跳过」表：过期记录对跳过判断已无意义，表本身也没有自愈路径
    ProbeCooldown.sweep();
    await pxGet(this.env);
    // 空池子直接结束这一轮：没有候选可探，写任何东西都是噪声
    if (!(await this.loadPool())) return;
    await this.alive.retestFlagged();
    await new ScanProbe(this.pool, this.adm, this.env).run();
    await this.alive.recheckHead();
    await this.alive.refreshRest();
    // 裁剪动过存活表时，站点排行与分片排序里可能还留着刚被删的节点
    if (this.house.prune(this.pool)) {
      S.hostRankCache.clear();
      NodeStatsTable.invalidateRank();
    }
    // 国家码只影响展示与地区分组，放在裁剪之后（被裁掉的节点不必再查一次）
    await this.house.countries();
    await this.house.trimStats();
    await this.house.relays();
    await this.house.persistSeed(this.env);
  }

  /**
   * 功能：取候选池，必要时从上游重建。
   * @returns 有没有可用池子
   */
  private async loadPool(): Promise<boolean> {
    this.pool = await ensurePool(this.env);
    if (!this.pool.length || Date.now() - S.poolBuilt > POOL_TTL_MS) {
      const { pool: fresh } = await refillPool(this.env, S.pool.length);
      if (fresh.length) {
        const c = await commitPool(this.env, fresh);
        // 提交被拒（缩水守卫）时保留旧池：换成缩水的新池会让可用节点瞬间变少
        if (c.ok) this.pool = fresh;
        else logErr(`pool commit rejected: ${c.reason}`, "");
      }
      if (!this.pool.length) return false;
    }
    return true;
  }
}

/**
 * 功能：跑一轮池子维护（对外入口，`cron.ts` 与 `/<uuid>/debug?scan=` 都用它）。
 * @param env Worker 环境
 * @param adm 本轮准入名额（0 表示按池子大小自适应）
 * @returns 无
 */
export async function cronScan(env: Env, adm = 0): Promise<void> {
  await new PoolScan(env, adm).run();
}
