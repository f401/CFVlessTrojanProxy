import { NODE_MEMORY } from "../core/node-memory";
import { SC } from "../core/const";
import { scoreParts, CANDS } from "../nodes/score";

/** 一次抽样里的单根候选臂：键、乐观代价、是否样本不足（样本不足的豁免剪枝） */
interface Arm {
  k: string;
  v: number;
  low: boolean;
}

/** 标准正态（Box-Muller）；不用 while，避免 Math.random 被打桩成 0 时死循环 */
function gauss(): number {
  const u = Math.random() || 1e-9;
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 功能：单层 Thompson 抽样器 —— 给一次挑路算出「乐观代价」并取最小的那条候选。
 *
 * 为什么值得成类：一次抽样要同时用到七个只依赖「这次请求」的量（池子大小、抽样宽度、
 * 乐观面系数、目标流量、探活剪枝线、池内最快带宽、当前最优均值），它们之间还有隐含的
 * 先后关系（池子大小决定抽样宽度，抽样宽度决定乐观面，池内最快带宽只在前若干名里扫）。
 * 散在一条 92 行函数里时，任何一处调参都要重新确认没有别的量跟着变。
 */
export class ThompsonPicker {
  /** 速率优先（lat）还是吞吐优先（tput）：决定带宽项用哪个尺度、剪枝线是否生效 */
  private readonly mode: Mode;
  /** 本次目标流量：失败与慢的代价按它折算，窗口内所有候选必须用同一个值 */
  private readonly bytes: number;
  /** 这次抽样的时间基准：所有候选的衰减必须按同一时刻算，否则排序会抖动 */
  private readonly now: number;
  /** 已排序的候选（`CANDS.list` 的前若干名），顺序即「先验名次」 */
  private readonly list: RankRow[];
  /** 池子大小（不是候选表长度）：抽样宽度与乐观面都按它算 */
  private readonly poolSize: number;
  /** 本次抽样宽度：池子越大越窄，避免把流量摊给明显更差的节点 */
  private readonly poolWidth: number;
  /** 乐观面系数：β·σ 的系数，已按池子大小收缩过 */
  private readonly optimism: number;
  /** 折算慢代价用的流量（没传 bytes 时按模式给一个典型值） */
  private readonly targetBytes: number;
  /** 探活剪枝线：延迟模式的候选一旦慢过它就不再参与竞争 */
  private readonly latCutMs: number;
  /** 池内（前若干名里）见过的最快带宽：给「还没测过带宽」的臂算乐观代价 */
  private readonly fastestBps: number;

  /**
   * 功能：把这次抽样的七个前置量一次算清（全部只依赖入参与当前状态，不再改状态）。
   * @param mode 速率优先或吞吐优先
   * @param bytes 本次目标流量，0 表示按模式取典型值
   */
  constructor(mode: Mode, bytes = 0) {
    this.mode = mode;
    this.bytes = bytes;
    this.now = Date.now();
    this.list = CANDS.list(mode);
    this.poolSize = this.poolLen();
    this.poolWidth = this.widthOf();
    this.optimism = this.betaOf();
    this.targetBytes = this.bytesOf();
    this.latCutMs = this.cutOf();
    this.fastestBps = this.topBpsOf();
  }

  /**
   * 功能：取池子大小（抽样宽度与乐观面的分母）。
   *
   * 为什么不能用候选表长度：`list` 已被 `CAND_KEEP` 截到 ≤288；也不能用 `NODE_MEMORY.candidateCount` ——
   * 大池分片重建期间它只反映「已经扫过的那一段」（2000 池实测在 128 → 2000 之间跳），
   * β 与抽样宽度会随切片进度变化 3 倍以上，等于把调好的大池参数作废（7.211）。
   * @returns 池子大小（存活表 → 候选数 → 候选表长度，逐级兜底）
   */
  private poolLen(): number {
    const nPool = NODE_MEMORY.alive.size || NODE_MEMORY.candidateCount || this.list.length;
    return nPool;
  }

  /**
   * 功能：按池子大小定这次的抽样宽度。
   *
   * 300~800 的池子里前 64 名含大量明显更差的节点（300 池实测 1.16x → 32 名 1.14x →
   * 16 名 1.13x），收窄能集中采样；2000 池前 64 只占 3%，收窄反而丢掉「可能变好」的候选
   * （1.16x → 32 名 1.20x → 16 名 1.22x）。所以大池按模式分开给宽度。
   * @returns 本次参与抽样的候选名额
   */
  private widthOf(): number {
    const kMax =
      this.poolSize >= SC.TS_K_BIG_MIN
        ? this.mode === "tput"
          ? SC.TS_K
          : SC.TS_K_LAT
        : SC.TS_K_SMALL;
    return kMax;
  }

  /**
   * 功能：算乐观面系数 β·√(min(1, 宽度/池子))。
   *
   * 候选越多，单个「没测过」的节点越不该抢流量：池子里有 800 个候选时，每个未测节点
   * 都拿满乐观面，等于把 5% 探索摊成「谁样本少谁上」的轮盘。池子小于宽度时不打折
   * （20 个候选的池子需要乐观面把差游标顶出去）。
   * @returns 乐观面系数（毫秒当量）
   */
  private betaOf(): number {
    const shrink = Math.sqrt(Math.min(1, this.poolWidth / Math.max(1, this.poolSize)));
    return SC.TS_BETA * shrink;
  }

  /**
   * 功能：定这次折算慢代价用的流量（毫秒 ↔ 字节的换算基准）。
   * @returns 目标字节数
   */
  private bytesOf(): number {
    if (this.bytes > 0) return this.bytes;
    return this.mode === "tput" ? 10 * 1048576 : SC.LAT_BYTES;
  }

  /**
   * 功能：算探活剪枝线（延迟模式专用）。
   *
   * 探活能判死的节点不该花流量：2000~3000 池里 2/3 的候选仅凭探活就比当前最优慢 50% 以上，
   * 给它们送样本等于用 1/3 的流量做无用测量（实测每次请求命中最优只有 18%~58%）。
   * 参考值取排行榜第一名的落盘延迟（O(1)），不额外遍历。
   * @returns 剪枝线（毫秒）
   */
  private cutOf(): number {
    const head = this.list.length ? NODE_MEMORY.stats.get(this.list[0].k) : undefined;
    const seen = head && (head.pSum || 0);
    const aliveMs = this.list.length ? NODE_MEMORY.alive.get(this.list[0].k)?.ms || 0 : 0;
    const latMin = seen || aliveMs || SC.P_TCP;
    return latMin * SC.TS_CUT_R + SC.TS_CUT_MS;
  }

  /**
   * 功能：扫出池内（前若干名里）见过的最快带宽，作为「还没测过带宽」的乐观上界。
   *
   * 只用先验 2MB/s 会让 16MB 批量场景里 40MB/s 的新节点看起来要 8 秒，永远赢不过已经测出
   * 10MB/s 的老节点（实测最优命中率 7%）；「池里最快」是一个有依据的乐观上界。
   * @returns 带宽（字节/秒），至少是先验值
   */
  private topBpsOf(): number {
    let capMax = SC.PRIOR_BPS;
    // 只扫前 poolWidth 名：那一批才是真正会被抽中的，全表扫会拖慢热路径
    for (let i = 0; i < this.list.length && i < this.poolWidth; i++) {
      const st = NODE_MEMORY.stats.get(this.list[i].k);
      if (st && (st.capBps || 0) > capMax) capMax = st.capBps || 0;
    }
    return capMax;
  }

  /**
   * 功能：算一根臂的不确定性 σ（延迟测不准 + 带宽没测过 + 失败率样本不足）。
   * @param p 这根臂的分数明细
   * @returns σ（毫秒当量）
   */
  private spreadOf(p: ReturnType<typeof scoreParts>): number {
    // 延迟项：均值标准误，样本越少越大
    const sdLat = p.latencyMs / Math.sqrt(Math.max(1, p.latN));
    // 带宽项按模式取尺度：延迟模式只关心典型请求的传输时间（e10 是 10MB 的量，会淹没一切）
    const scale = this.mode === "tput" ? p.e10Ms : p.xferMs;
    const sdTput = (1 - p.confB) * 0.6 * scale;
    // 失败率项：p(1-p)/n 的标准误，再折算成毫秒
    const sdFail = p.failMs * Math.sqrt(Math.max(0.02, p.pFailRisk * (1 - p.pFailRisk)) / (p.samples + 3));
    return Math.sqrt(sdLat * sdLat + sdTput * sdTput + sdFail * sdFail);
  }

  /**
   * 功能：算一根臂的乐观代价（越小越该选）。
   *
   * 三项各有来历：`mean` 是「按均值该花多少」，`queueMs` 是在途排队的等待，
   * 抖动项与 β·σ 一起决定「没测过的臂」有多容易被抽到。
   * @param p 这根臂的分数明细
   * @param inflight 这根臂上正在跑的连接数
   * @param spread 这根臂的不确定性 σ
   * @returns 乐观代价（毫秒当量）
   */
  private costOf(p: ReturnType<typeof scoreParts>, inflight: number, spread: number): number {
    const transfer = this.mode === "tput" ? p.e10Ms : p.xferMs;
    // 按这次请求的流量折算传输时间：有实测带宽就按实测，没有就按池内最快估
    const perRequest =
      p.capBps > 0
        ? (this.targetBytes / Math.max(8 * 1024, p.capBps)) * 1000
        : (this.targetBytes / this.fastestBps) * 1000;
    // 排队按「这次请求的传输时间」计价：用 10MB 的 e10 当服务时间会把 2MB 请求的排队高估 5 倍
    const queueMs = inflight > 0 ? inflight * perRequest : 0;
    // 带宽先验按池内最快做层次化收缩：TS_HIER=0 时退回旧口径（均值直接用 score），只用于 A/B
    const mean = SC.TS_HIER > 0 ? p.score - transfer + perRequest : p.score;
    // 探索方式：0 = UCB（减 βσ + 固定抖动）；1 = 纯 Thompson（按 σ 抽样，不另减乐观面）
    const noise = SC.TS_PURE ? Math.max(SC.TS_SD_MIN, spread) : SC.TS_SD_MIN;
    // 没有任何流量样本、探活又已经慢到追不上 → 只留作「实在没人」时兜底
    const deadEnd = this.mode === "lat" && p.samples < 1 && p.latencyMs > this.latCutMs ? 1e7 : 0;
    return mean + queueMs + gauss() * noise - (SC.TS_PURE ? 0 : this.optimism * spread) + deadEnd;
  }

  /**
   * 功能：遍历候选、给每根臂算乐观代价（顺带记下全池最优均值，供剪枝用）。
   * @returns 本次参与比较的臂，与全池最优均值（剪枝线的起点）
   */
  private arms(): { arms: Arm[]; bestMean: number } {
    const arms: Arm[] = [];
    let bestMean = Infinity, extra = 0;
    for (let i = 0; i < this.list.length; i++) {
      const k = this.list[i].k;
      // 超出抽样宽度的候选只在「样本不足」时补进来（上限 TS_EXTRA 个），否则大池里新节点永远当分母
      if (i >= this.poolWidth) {
        const st = NODE_MEMORY.stats.get(k);
        const n = st ? st.okW + st.failW : 0;
        if (n >= SC.N_EFF_MIN || extra++ >= SC.TS_EXTRA) continue;
      }
      const p = scoreParts(k, this.mode, this.now, false, this.bytes);
      const spread = this.spreadOf(p);
      // 在途条数决定排队等待：低并发时 inflight=0，完全退化成不带排队的公式
      const inflight = NODE_MEMORY.inflight.get(k) || 0;
      arms.push({ k, v: this.costOf(p, inflight, spread), low: p.confB < 0.05 || p.latN < 3 });
      if (p.score < bestMean) bestMean = p.score;
    }
    return { arms, bestMean };
  }

  /**
   * 功能：在臂里挑代价最小的；样本不足的臂豁免剪枝，全被剪掉时退回全体最小。
   *
   * 剪枝的理由：候选池 300 个时，全池抽样等于把流量摊给明显更差的节点
   * （仿真：300 节点 1.10x → 1.29x 全是这笔税）。只保留乐观值落在最优均值 TS_BAND 内的。
   * @param arms 本次参与比较的臂
   * @param bestMean 全池最优均值（剪枝线 = 它 + `SC.TS_BAND`）
   * @returns 选中的节点键；没有候选时返回空串
   */
  private pickOf(arms: Arm[], bestMean: number): string {
    const cut = bestMean + SC.TS_BAND;
    let best = "", bv = Infinity;
    for (const a of arms) {
      if (a.v > cut && !a.low) continue;
      if (a.v < bv) {
        bv = a.v;
        best = a.k;
      }
    }
    // 全被剪掉（Band 太小）时退回全体最小值，不要返回空串
    if (!best) {
      for (const a of arms) {
        if (a.v < bv) {
          bv = a.v;
          best = a.k;
        }
      }
    }
    return best;
  }

  /**
   * 功能：抽一次，返回选中的节点键。
   * @returns 节点键；无候选时返回空串
   */
  pick(): string {
    // 先把臂算完再挑：剪枝线要看到全池最优均值，边算边挑会用到半张表
    const { arms, bestMean } = this.arms();
    return this.pickOf(arms, bestMean);
  }
}
