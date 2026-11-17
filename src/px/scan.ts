// 池子维护的一轮：准入复测 → 探新候选 → 头部复测 → 存活表裁剪 → 国家码 → 统计表裁剪 → 中转实测 → 落盘。
// 这条流水线原来是 `pool.ts` 里一个 250 行的 `cronScan`，八段用「①②③」编号区分；
// 现在每段是一个方法，顺序写在 `run()` 里，改一段不用再数行号。

import { SC } from "../core/const";
import { HOOK } from "../core/hook";
import { S } from "../core/state";
import { splitRelay } from "../core/http80";
import { logErr } from "../nodes/metrics";
import { candsFor, invalidateRank, isBlack, isFrozen, nsProbe, nsProbeFail } from "../nodes/score";
import { ALIVE, ALIVE_MAX, bumpProbeBad, noteProbe, probeBadSkip, pxGet, sweepProbeBad } from "./alive";
import { POOL_TTL_MS, chunks, probeProxy, probeSni, refillPool } from "./probe";
import { commitPool, ensurePool } from "./poolgen";
import { SEEDS } from "./seed";
import { keyOf } from "./const";

/**
 * 一条探活结果（`bad` 非空表示失败原因；`tcp`/`tls` 是两段握手的耗时）。
 *
 * 继承 `NodeEntry` 而不是另立一份：探活结果要直接喂给 `keyOf()` 与 `addAlive()`，
 * 那两个函数的入参是 `NodeEntry`，形状不一致时只能靠 `as` 硬转 —— 转错不会有任何编译错误。
 */
interface ProbeHit extends NodeEntry {
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
 * 一轮池子维护的执行器。持有「这一轮」的池子快照与预算，
 * 每段一个方法，`run()` 只负责顺序。
 */
export class PoolScan {
  /** 这一轮用的环境（`scanSub` 这类可调项从这里读） */
  private readonly env: Env;
  /** 本轮准入名额（0 表示按池子大小自适应） */
  private readonly adm: number;
  /** 这一轮的候选池快照：重建成功后立刻换成新的，后面所有段落都用它 */
  private pool: PoolEntry[] = [];

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
    // 每轮先收拾「暂时跳过」表：过期记录对 probeBadSkip 已无意义，表本身也没有自愈路径
    sweepProbeBad();
    await pxGet(this.env);
    if (!(await this.loadPool())) return;
    await this.retestFlagged();
    await this.probeNew();
    await this.recheckHead();
    await this.refreshRest();
    if (this.pruneAndTrim()) {
      // 站点排行与分片排序里可能还留着刚被删的节点
      S.hostRankCache.clear();
      invalidateRank();
    }
    await ALIVE.fillCountries();
    this.trimStats();
    await this.probeRelays();
    await this.persistSeed();
  }

  /**
   * 功能：取候选池，必要时从上游重建。
   * @returns 有没有可用池子（空池子直接结束这一轮：没有候选可探，写任何东西都是噪声）
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

  /**
   * 功能：复测上一轮「比同 /24 邻居慢一大截」的节点。
   *
   * 一次抖动会被 EWMA 吃掉 30%，紧接着再测一次就能拉回来。
   * @returns 无
   */
  private async retestFlagged(): Promise<void> {
    const again = S.reProbe.splice(0, 4);
    if (!again.length) return;
    S.reProbeN += again.length;
    // 并行探这几条：它们上一轮刚被测过，再慢也就一个 CONNECT_MS
    const rr = await Promise.all(
      again.map(async (k) => {
        const [probeHost, probePort] = splitRelay(k, 443);
        return { k, r: await probeProxy(probeHost, probePort) };
      }),
    );
    for (const { k, r } of rr) {
      noteProbe(r);
      if (r && !r.bad) {
        nsProbe(k, r.ms, r.tcp || r.ms, r.tls || 0);
        // 复测结果比历史更慢时不要把 alive 里的延迟改大：这里只做「拉回来」
        const a = S.alive.get(k);
        if (a && r.ms < (a.ms || 1e9)) a.ms = r.ms;
      }
    }
  }

  /**
   * 功能：探一批「还没有结论」的新候选，并给同 /24 明显偏慢的节点打上「下一轮复测」。
   * @returns 无
   */
  private async probeNew(): Promise<void> {
    // 每轮扫多少：默认按「4 轮覆盖全池」，管理员的 ?scan= 只能往上抬，天花板 SCAN_MAX。
    // 120/轮时 1600 池要 6.7 小时才轮完，冷启动期（isolate 寿命短）等于永远只认识前 120 个。
    const want = this.adm > 0 ? this.adm : Math.max(S.scanN || 12, Math.ceil(this.pool.length / 4));
    // 子请求是硬上限：免费计划 50/次调用，每次探活 = 1 个 connect()。默认压在 48，
    // 付费计划或提高配额后用 env.scanSub 抬（仍不超过 SCAN_MAX）。
    const sub = Number(this.env.scanSub) > 0 ? Math.max(12, Number(this.env.scanSub)) : SC.SCAN_SUB;
    const scanN = Math.max(12, Math.min(Math.min(SC.SCAN_MAX, sub), want));
    // 只在「还没有结论」的候选里轮转：已经进池的（有流量样本，另有 recheckHead）和连续探活失败的
    // 不再占名额。公开池里九成以上是死的，纯轮转时它们每轮都被重复探一遍，好候选永远排不上。
    const open = this.pool.filter((c) => {
      const k = c.h + ":" + c.p;
      return !S.alive.has(k) && !probeBadSkip(k);
    });
    // 全都有结论时退回「没进池的候选」做低频复检（能在池里的靠 recheckHead + 真实流量，不用再探活）
    const live = this.pool.filter((c) => !S.alive.has(c.h + ":" + c.p));
    const src = open.length ? open : live.length ? live : this.pool;
    const idx = S.poolIdx % Math.max(src.length, 1);
    const batch = src.slice(idx, idx + scanN);
    const hits: ProbeHit[] = [];
    S.probeColo = S.colo || "cron";
    // 并发上限按 SC.PROBE_CONC 切段（免费计划全局只有 6 个 connect 名额）
    for (const seg of chunks(batch, SC.PROBE_CONC)) {
      const part = await Promise.all(seg.map((c) => probeProxy(c.h, c.p)));
      for (let j = 0; j < seg.length; j++) {
        const x = part[j];
        noteProbe(x);
        const k = seg[j].h + ":" + seg[j].p;
        bumpProbeBad(k, !!(x && !x.bad));
      }
      // 只有探活的候选才可能被同 /24 对照筛出来
      for (const x of part) if (x && !x.bad) hits.push(x as ProbeHit);
    }
    S.poolIdx = (idx + scanN) % Math.max(src.length, 1);
    S.probes += batch.length;
    S.hits += hits.length;
    this.markLaggards(hits);
    // 进 alive 与写节点统计：这两件事只对成功的那批做
    for (const x of hits) {
      const k = keyOf(x);
      S.alive.set(k, {
        h: x.h,
        p: x.p,
        cc: x.cc || ((S.alive.get(k) || {}) as NodeEntry).cc || "",
        ms: x.ms,
      });
      // 探活 RTT 是「ClientHello → ServerHello」，与真实请求的首字节（含 TLS 握手）不是同一个量：
      // 写进 nsLatency 会让 pSum 停在 40ms 量级，第一条真实请求就 cusumSum += 330 > CUSUM_H 把它冻 60 秒
      // （7.183 在 warm.ts 修过同一处）。探活只贡献样本数 probeSamples 与 tcp/tls 的 EWMA。
      nsProbe(k, x.ms, x.tcp || x.ms, x.tls || 0);
    }
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
      const k = keyOf(x);
      if (x.ms > Math.max(3 * med, 250) && !S.reProbe.includes(k)) S.reProbe.push(k);
    }
  }

  /**
   * 功能：算出「这一轮要复测的头部」：当前游标 + 吞吐分前 3 名。
   *
   * 以前这里取的是 alive 的前三个 key（插入顺序），跟「前 3 名」没关系，
   * 真正该复测的头部节点反而一直轮不到。
   * @returns 最多 4 个候选键
   */
  private recheckKeys(): string[] {
    const cur = S.curs.tput || S.curs.lat || "";
    const top3 = candsFor("tput")
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
  private async recheckHead(): Promise<void> {
    await this.probeInto(this.recheckKeys(), true);
  }

  /**
   * 功能：其余 alive 只刷新延迟，不参与拉黑（抖动不该把 alive 打死）。
   *
   * 从 `poolIdx` 开始轮转，别每次都测同样 12 个（插入顺序靠前的会一直被溺爱）。
   * @returns 无
   */
  private async refreshRest(): Promise<void> {
    const recheck = this.recheckKeys();
    const allRest = [...S.alive.keys()].filter((k) => !recheck.includes(k));
    const start = allRest.length ? S.poolIdx % allRest.length : 0;
    // 从游标处环形切 12 条：这个数字要和一轮的 connect 预算（PROBE_CONC × 段数）配得上
    const rest = [...allRest.slice(start), ...allRest.slice(0, start)].slice(0, 12);
    await this.probeInto(rest, true);
  }

  /**
   * 功能：按并发上限探一批存活节点：成功就刷新延迟与统计，失败记一次 probeFail。
   * @param keys 要探的候选键
   * @param failCounts 失败是否记进 `nsProbeFail`（alive 的复测要记；新候选不记，它们连 alive 都还没进）
   * @returns 无
   */
  private async probeInto(keys: string[], failCounts: boolean): Promise<void> {
    if (!keys.length) return;
    for (const seg of chunks(keys, SC.PROBE_CONC)) {
      const rows = await Promise.all(
        seg.map(async (k) => {
          const [probeHost, probePort] = splitRelay(k, 443);
          return { k, r: await probeProxy(probeHost, probePort) };
        }),
      );
      for (const { k, r } of rows) {
        noteProbe(r);
        if (r && !r.bad) {
          nsProbe(k, r.ms, r.tcp || r.ms, r.tls || 0);
          // alive 里的 ms 就是面板与池子裁剪用的「实测延迟」，成功即覆盖
          const a = S.alive.get(k);
          if (a) a.ms = r.ms;
        } else if (failCounts) {
          nsProbeFail(k);
        }
      }
    }
  }

  /**
   * 功能：裁存活表 —— 先移出被重罚的（冷却 ≥30 分钟），再按上限裁到 `ALIVE_MAX`。
   * @returns 是否改动过（改动过要清站点排行缓存）
   */
  private pruneAndTrim(): boolean {
    const pruned = ALIVE.pruneOverPunished();
    const trimmed = ALIVE.trimToMax(this.pool);
    return pruned || trimmed;
  }

  /**
   * 功能：清理节点统计表 —— 候选池一轮轮扫下去 `nstat` 只增不减（实测能到 2000+ 条），
   * 每条带一个 12 格直方图。清掉「不在 alive、没有吞吐样本、6 小时没动静」的，再对总量做硬上限。
   * @returns 无
   */
  private trimStats(): void {
    const live = new Set(S.alive.keys());
    const cut = Date.now() - 6 * 3600e3;
    for (const [k, s] of S.nstat) {
      // 有下行样本的节点可能还在被选（candsFor 会读它的分），不能按「不在 alive」删
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
  private async probeRelays(): Promise<void> {
    const tNow = Date.now();
    const targets: string[] = [];
    // 每轮最多两个站点：每次瞄准 = 4 条节点 × 一次握手，预算要留给探活
    for (const [h, t] of S.needPx) if (t > tNow && targets.length < 2) targets.push(h);
    if (!targets.length) return;
    const pool4 = (await ALIVE.list())
      .filter((x) => !isBlack(keyOf(x)) && !isFrozen(keyOf(x)))
      .slice(0, 4);
    if (!pool4.length) return;
    for (const h of targets) {
      // 探测本身失败也只当「没转出去」：这里要的是可用的那条，不是错误分类
      const res = (await Promise.all(
        pool4.map((x) => probeSni(x.h, x.p, h, 2200).catch(() => ({ err: "tcp" }) as { hs?: number })),
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
   * @returns 无
   */
  private async persistSeed(): Promise<void> {
    if (Date.now() - (S.seed.ts || 0) >= 55 * 60000) {
      await SEEDS.write(this.env, S.colo ? undefined : true, true);
    }
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
