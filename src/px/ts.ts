import { SC } from "../core/const";
import { S } from "../core/state";
import { candsFor, scoreParts } from "../nodes/score";

/**
 * 单层抽样器见文件底部 pickThom。
 */

/** 标准正态（Box-Muller）；不用 while，避免 Math.random 被打桩成 0 时死循环 */
function gauss(): number {
  const u = Math.random() || 1e-9;
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pickThom(mode: Mode, bytes = 0): string {
  const now = Date.now();
  const list = candsFor(mode);
  const ks: string[] = [], vs: number[] = [], low: boolean[] = [];
  let minScore = Infinity, extra = 0;
  // 候选越多，单个"没测过"的节点越不该抢流量：池子里有 800 个候选时，
  // 每个未测节点都拿满乐观面，等于把 5% 探索摊成"谁样本少谁上"的轮盘。
  // 池子小于 TS_K 时不打折（20 个候选的池子需要乐观面把差游标顶出去）。
  // 抽样池宽度按池子大小分档：300~800 的池子里前 64 名含大量明显更差的节点（300 池实测
  // 1.16x → 32 名 1.14x → 16 名 1.13x），收窄能集中采样；2000 池前 64 只占 3%，
  // 收窄反而丢掉"可能变好"的候选（1.16x → 32 名 1.20x → 16 名 1.22x）。
  // 注意分母是**池子**大小（S.candN），不是 list.length —— 后者已被 CAND_KEEP 截到 ≤288。
  const nPool = S.candN || S.alive.size || list.length;
  const kMax = nPool >= SC.TS_K_BIG_MIN ? (mode === "tput" ? SC.TS_K : SC.TS_K_LAT) : SC.TS_K_SMALL;
  const opt = SC.TS_BETA * Math.sqrt(Math.min(1, kMax / Math.max(1, nPool)));
  // 池内见过的最快带宽：给"还没测过带宽"的臂算乐观代价用。
  // 只用先验 2MB/s 会让 16MB 批量场景里 40MB/s 的新节点看起来要 8 秒，永远赢不过已经测出
  // 10MB/s 的老节点（实测最优命中率 7%）；"池里最快"是一个有依据的乐观上界。
  const szBytes = bytes > 0 ? bytes : mode === "tput" ? 10 * 1048576 : SC.LAT_BYTES;
  // 探活能判死的节点不该花流量：2000~3000 池里，2/3 的候选仅凭探活就比当前最优慢 50% 以上，
  // 给它们送样本等于用 1/3 的流量去做无用测量（实测每次请求命中最优只有 18%~58%）。
  // 用排行榜第一名的落盘延迟当参考（O(1)），不额外遍历。
  const s0 = list.length ? S.nstat.get(list[0].k) : undefined;
  const latMin = (s0 && (s0.pSum || 0)) || (list.length ? S.alive.get(list[0].k)?.ms || 0 : 0) || SC.P_TCP;
  const latCut = latMin * SC.TS_CUT_R + SC.TS_CUT_MS;
  let capMax = SC.PRIOR_BPS;
  for (let i = 0; i < list.length && i < kMax; i++) {
    const st = S.nstat.get(list[i].k);
    if (st && (st.capBps || 0) > capMax) capMax = st.capBps || 0;
  }
  for (let i = 0; i < list.length; i++) {
    const k = list[i].k;
    if (i >= kMax) {
      const st = S.nstat.get(k);
      const n = st ? st.okW + st.failW : 0;
      // 样本不足的节点补进池子（上限 TS_EXTRA 个），否则大池里新节点永远当分母
      if (n >= SC.N_EFF_MIN || extra++ >= SC.TS_EXTRA) continue;
    }
    const p = scoreParts(k, mode, now, false, bytes);
    // 不确定性 = 延迟测不准 + 带宽没测过 + 失败率样本不足；
    // 带宽项按模式取尺度：延迟模式只关心典型请求的传输时间（e10 是 10MB 的量，放进来会淹没一切）。
    const sdL = p.latencyMs / Math.sqrt(Math.max(1, p.latN));
    const sdB = (1 - p.confB) * 0.6 * (mode === "tput" ? p.e10Ms : p.xferMs);
    const sdF = p.failMs * Math.sqrt(Math.max(0.02, p.pFailRisk * (1 - p.pFailRisk)) / (p.n + 3));
    const sd = Math.sqrt(sdL * sdL + sdB * sdB + sdF * sdF);
    // 排队：单节点带宽是硬上限，在途 q 条时新连接要等 q 个服务时间。
    // 原来的"在途≥2 才换手"是二值策略，等于不知道 1 与 5 的区别；这里把等待显式计价，
    // 低并发时 inflight=0 → 完全退化成原公式（不影响单连接场景）。
    const qd = S.inflight.get(k) || 0;
    // 乐观面（UCB）：减去 β 倍不确定性。没测过的节点偏差大、天然被抽；
    // 样本攒够后 σ 收缩，退回按均值竞争 —— 不需要另设"探索率"。
    ks.push(k);
    // 带宽先验按"池内最快"做层次化收缩：有节点自己的测量就按测量算传输时间（哪怕只有一条样本），
    // 完全没测过的按池内最快带宽估。全局先验 2MB/s 会让 16MB 场景里 40MB/s 的节点看起来要 8 秒、
    // 永远排在"已测出 10MB/s"的节点后面（实测最优命中率只有 7%）；反过来，把没测过的也当最快的
    // 会在大池里放大探索（2000 池从 1.15 退化到 1.23）。
    const tms = mode === "tput" ? p.e10Ms : p.xferMs;
    const tRaw = p.capBps > 0 ? (szBytes / Math.max(8 * 1024, p.capBps)) * 1000 : (szBytes / capMax) * 1000;
    // 排队等待按"这次请求的传输时间"计价：用 10MB 的 e10 当服务时间会把 2MB 请求的排队高估 5 倍，
    // 慢节点反而显得"排队不长"。
    const qMs = qd > 0 ? qd * tRaw : 0;
    // TS_HIER=0 时退回旧口径（均值直接用 score），只用于 A/B 对照。
    const mean = SC.TS_HIER > 0 ? p.score - tms + tRaw : p.score;
    // 探索方式：0 = UCB（减 βσ + 固定抖动）；1 = 纯 Thompson（按 σ 抽样，不另减乐观面）。
    // 纯 Thompson 的好处：所有臂都没测过时 σ 相等，UCB 的乐观面会互相抵消、退化成"按均值挑"，
    // 而按 σ 抽样能让每个未测臂都有机会（跨模式 16MB 场景里 D 曾被 A/B/C 永久压住）。
    const noise = SC.TS_PURE ? Math.max(SC.TS_SD_MIN, sd) : SC.TS_SD_MIN;
    // 没有任何流量样本、探活又已经慢到追不上 → 只保留"实在没人"时兜底，不再参与竞争。
    const deadEnd = mode === "lat" && p.n < 1 && p.latencyMs > latCut ? 1e7 : 0;
    vs.push(mean + qMs + gauss() * noise - (SC.TS_PURE ? 0 : opt * sd) + deadEnd);
    // 样本不足的臂必须豁免剪枝：否则"没测过 → 先验很慢 → 被剪掉 → 永远没测过"锁死
    // （16MB 批量场景里 40MB/s 的节点因为先验只算 2MB/s，实测 10.8MB/s 的节点一直赢，
    //  最优命中率只有 7%）。
    low.push(p.confB < 0.05 || p.latN < 3);
    if (p.score < minScore) minScore = p.score;
  }
  // 剪掉「再乐观也追不上」的臂：候选池 300 个时，全池抽样等于把流量摊给明显更差的节点
  // （仿真：300 节点 1.10x → 1.29x 全是这笔税）。只保留乐观值落在最优均值 TS_BAND 内的。
  const cut = minScore + SC.TS_BAND;
  let best = "", bv = Infinity;
  for (let i = 0; i < ks.length; i++) {
    if (vs[i] > cut && !low[i]) continue;
    if (vs[i] < bv) { bv = vs[i]; best = ks[i]; }
  }
  // 全被剪掉（Band 太小）时退回全体最小值，不要返回空串
  if (!best) {
    for (let i = 0; i < ks.length; i++) if (vs[i] < bv) { bv = vs[i]; best = ks[i]; }
  }
  return best;
}
