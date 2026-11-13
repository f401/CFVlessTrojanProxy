import { SC } from "../core/const";
import { pcts } from "../core/hist";
export { capOf, p90Of, pctOf, p90Local, pcts } from "../core/hist";
import { S } from "../core/state";
export * from "./stat";
import { TEN_MB, ZERO_STAT, availOf, effView, invalidateRank, nsGet, pFailFast, pFailOf, pStallOf } from "./stat";

/* 节点评分：代价函数、抽样候选表、健康判定。统计原语在 stat.ts（为守住 560 行门禁拆开的）。 */
export interface ScoreParts {
  mode: Mode; score: number; latencyMs: number; e10Ms: number;
  pFailRisk: number; pStall: number; capBps: number; confB: number;
  nEff: number; latN: number; sampleAgeMs: number; xferMs: number;
  n: number; jitMs: number; failMs: number; gate: string;
}

/**
 * 评分明细（v2）：排序与面板共用同一份分项，避免"面板一套公式、选路另一套"。
 *
 *   延迟 L = confL × Lobs + (1-confL) × Lprior
 *   吞吐 E10 = confB × (10MiB/cap) + (1-confB) × (10MiB/prior)
 *   score = 目标项 + FAIL×pFailRisk + STALL×pStall
 */
export function scoreParts(k: string, mode: Mode, now = Date.now(), withGate = false, bytes = 0): ScoreParts {
  const m: Mode = mode === "tput" ? "tput" : "lat";
  const s = S.nstat.get(k) || ZERO_STAT;
  const a = S.alive.get(k);
  const e = effView(s, now);

  // —— 延迟 ——
  const tcp = s.tcp || (a && a.ms) || SC.P_TCP;
  const tls = s.tls || SC.P_TLS;
  const probeL = tcp + tls * SC.TLS_G + Math.max(0, tls - 2 * tcp - SC.LOSS_SLACK) * SC.LOSS_G;
  // 真实首字节是主信号：每条连接一个样本，按样本数加权（≤REAL_W），探活只留 PROBE_W 底仓
  const realL = s.pSum || s.msLocal || 0;
  // 单条坏连接不该定生死：超过探活 1.5 秒的部分截断
  const realC = realL > 0 ? Math.min(realL, probeL + 1500) : 0;
  const realW = realC > 0 ? Math.min(SC.REAL_W, e.okW) : 0;
  const Lobs = realW > 0 ? (probeL * SC.PROBE_W + realC * realW) / (SC.PROBE_W + realW) : probeL;
  const Lprior = (a && a.ms) || SC.P_TCP + SC.P_TLS * SC.TLS_G;
  const confL = 1 - Math.exp(-e.latN / 4);
  // 有真实样本就直接用它（Lobs 里已带 PROBE_W 底仓），否则才按"探活 + 先验"的置信度混合
  const latencyMs = realW > 0 ? Lobs : confL * probeL + (1 - confL) * Lprior;
  // 抖动：MAD×1.4826 换算成 σ。方差对单个离群点平方级敏感（样本已 winsorize，这里再稳一次）
  const jitMs = realL > 0 ? s.pSumSq * 1.4826 : 0;

  // —— 吞吐 ——：lat 模式用落盘的 p90（分位对等比衰减免疫，O(1) 等价）
  const capBps = m === "tput" ? pcts(s).cap || 0 : s.capBps || 0;
  // 目标流量 S 可覆盖（交互 64KB / 流媒体 1MB / 批量 16MB）
  const sz = bytes > 0 ? bytes : m === "tput" ? TEN_MB : SC.LAT_BYTES;
  const nEff = e.sumW2 > 0 ? (e.sumW * e.sumW) / e.sumW2 : 0;
  const sampleAge = s.lastSampleAt ? now - s.lastSampleAt : Infinity;
  let confB = 0;
  if (nEff >= SC.N_EFF_MIN && e.recentBytesW >= SC.RECENT_MIN && sampleAge <= SC.SAMPLE_TTL && capBps > 0) {
    confB = Math.min(1, e.recentBytesW / SC.RECENT_MIN) * (1 - Math.exp(-nEff / 4));
  }
  // 无本地吞吐样本时按固定先验（2MB/s）；不接受别的 isolate 的速率
  const e10Prior = (sz / SC.PRIOR_BPS) * 1000;
  // 延迟模式要算"传完一个典型请求"的时间；比先验快的证据按新鲜度贬值，比先验慢的原样保留
  const bwW =
    m === "lat" && capBps > 0 && s.lastSampleAt ? Math.max(0, 1 - (now - s.lastSampleAt) / SC.SAMPLE_TTL) : 0;
  const xferPrior = (sz / SC.PRIOR_BPS) * 1000;
  const xferMeas = capBps > 0 ? (sz / Math.max(8 * 1024, capBps)) * 1000 : 0;
  const xferMs =
    m !== "lat" ? 0 : !capBps ? xferPrior : xferMeas <= xferPrior ? bwW * xferMeas + (1 - bwW) * xferPrior : xferMeas;
  const e10Local = (sz / Math.max(capBps, 8 * 1024)) * 1000;
  const e10Ms = confB * e10Local + (1 - confB) * e10Prior;

  // —— 风险 ——
  const pFailRisk = Math.max(pFailOf(s, now, e), pFailFast(s, now));
  const pStall = pStallOf(s, now, e);
  const N = e.okW + e.failW;
  // 一次失败的代价 ≈ 重试一次（重连 + 重传），按本次目标流量 S 定价：
  // 交互 64KB 失败只丢一个 RTT，按 5000ms 计会把"快但偶尔失败"的节点永久判死
  // （仿真 oracle 用 cost/(1−p) 线性折算，20 节点场景命中率 0%、正常 DE 1.47x 全来自这个差）；
  // 批量 16MB 失败要重传，价格自然接近 20s。下限 400ms、上限 20s。
  const baseMs = latencyMs + (m === "tput" ? e10Ms : xferMs);
  const failMs = SC.FAIL_SCALE > 0 ? Math.min(20000, Math.max(400, SC.FAIL_SCALE * baseMs)) : SC.FAIL;
  let score = m === "tput"
    ? e10Ms + 0.5 * latencyMs + failMs * pFailRisk + SC.STALL * pStall
    : latencyMs + xferMs + SC.JIT_W * jitMs + failMs * pFailRisk + SC.STALL * pStall;

  // 低速惩罚只在"确实测出来"时才加，避免对无数据节点重复处罚
  if (m === "tput" && confB > 0.25 && capBps > 0 && capBps < 8 * 1024) score += 400;
  if (pStall > 0.25 && N >= 5) score += 400;

  let gate = "";
  if (withGate) {
    gate = !S.alive.has(k) ? "not-alive" : isBlack(k) ? "black" : isFrozen(k) ? "frozen"
      : (N >= 8 && availOf(s, now, e) < 0.4) ? "low-avail" : "ok";
  }

  return {
    mode: m, score, latencyMs, e10Ms, pFailRisk, pStall, capBps, confB,
    nEff, latN: e.latN, sampleAgeMs: Number.isFinite(sampleAge) ? sampleAge : -1, xferMs,
    n: N, jitMs, failMs, gate,
  };
}

/** 节点代价（毫秒当量，越小越好） */
export function costOf(k: string, mode: Mode, now = Date.now()): number {
  return scoreParts(k, mode, now).score;
}

/** 是否处于冷却期 */
export function isBlack(k: string) {
  const s = S.nstat.get(k);
  return !!(s && s.blackUntil > Date.now());
}
/** 是否被回滚冻结 */
export function isFrozen(k: string) {
  const s = S.nstat.get(k);
  return !!(s && s.freeUntil > Date.now());
}
/** 冻结一个刚出问题的节点 */
export function freezeNode(k: string) {
  if (!k) return;
  const s = nsGet(k);
  s.freeUntil = Math.max(s.freeUntil || 0, Date.now() + SC.ROLL_FREEZE);
  S.hostRankCache.clear();     // 站点排行里不能再推荐它
  invalidateRank();
}

/**
 * 中转后仍然大量空关闭 → 这个节点基本是坏的。
 * 只看"走了中转"的口径，直连空关闭是目标站的问题，不能算到节点头上。
 * @param {object} s 统计对象
 * @returns {boolean} 是否可疑
 */
export function suspectOf(s: NodeStats | undefined): boolean {
  if (!s) return false;
  const viaP = s.eCloseP || 0;
  const attempts = (s.tS || 0) + viaP;
  return attempts >= 5 && viaP / attempts > 0.5;
}

/** 可疑节点的 key 版本（面板/规则共用一份判定） */
export function emptyCloseSuspect(k: string) {
  return suspectOf(S.nstat.get(k));
}

/**
 * 候选资格：活着、不在冷却/冻结、可用性够、不是空关闭可疑节点。
 * 全局选路与地区选路必须共用这一份判定 —— 否则 rg=xx 会绕过排除规则，
 * 把全国流量压到一个"连得上但永远传不出数据"的节点上。
 * @param {string} k "host:port"
 * @param {number} now 当前时间
 * @returns {boolean} 是否可用
 */
export function usable(k: string, now = Date.now()): boolean {
  if (!S.alive.has(k) || isBlack(k) || isFrozen(k)) return false;
  const s = S.nstat.get(k);
  if (!s) return true;
  const e = effView(s, now);
  const n = e.okW + e.failW;
  if (n >= 8 && availOf(s, now, e) < 0.4) return false;
  return !suspectOf(s);
}

/** 候选列表（已过滤黑名单/冻结，按代价升序） */
const CAND_TTL = 20000;      // 排行缓存寿命（按模式各记各的时间）
const CAND_CACHE_MIN = 24;   // 候选少的时候不必缓存（重算也就几十 µs）
const CAND_KEEP = 224;       // 排行榜只留前 N 名（pickThom 只看前 64 + 64 个样本不足的）
const CAND_EXTRA = 64;       // 额外兜一批样本不足的节点，否则新节点永远进不了抽样池
const CAND_SLICE = 128;      // 分片重建：每次 pick 最多给多少个节点打分（2000 候选一次算完要 4 ms）
const CAND_SLICE_MIN = 1200; // 池子大于这个数才分片：800 个候选整算 1.6 ms 还吃得下，2000 个就要 4 ms

/** 一次算完的排行（小池 / 大池冷启动）。只保留前 CAND_KEEP 名 + 最多 CAND_EXTRA 个样本不足的节点。 */
function buildCands(m: Mode, now: number): RankRow[] {
  const top: RankRow[] = [];
  let usableN = 0;
  for (const k of S.alive.keys()) {
    if (!usable(k)) continue;
    usableN++;
    const v = costOf(k, m);
    if (top.length < CAND_KEEP || v < top[top.length - 1].v) {
      let lo = 0;
      let hi = top.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        // 相等时插在后面：保持插入顺序（同价节点按 alive 顺序，结果可复现）
        if (top[mid].v <= v) lo = mid + 1;
        else hi = mid;
      }
      top.splice(lo, 0, { k, v });
      if (top.length > CAND_KEEP) top.pop();
    }
  }
  const seen = new Set(top.map((r) => r.k));
  let extra = 0;
  for (const k of S.alive.keys()) {
    if (extra >= CAND_EXTRA) break;
    if (seen.has(k) || !usable(k)) continue;
    const s = S.nstat.get(k);
    if (s && s.okW + s.failW >= SC.N_EFF_MIN) continue;
    top.push({ k, v: costOf(k, m) });
    seen.add(k);
    extra++;
  }
  S.candN = usableN;
  // 小池不写缓存：否则一次 2 节点的小算例会把后面 30 节点的算例喂成旧表
  if (S.alive.size >= CAND_CACHE_MIN) {
    const c = S.rankCache;
    S.rankCache = { ...c, t: now, at: { ...c.at, [m]: now }, v: { ...c.v, [m]: top } };
  }
  return top;
}

/** 候选排行（按代价升序）。大池分片重建：每次调用只给 CAND_SLICE 个节点打分，
 *  边算边维护有界的前 CAND_KEEP 名（不做事后排序），2000 候选不再有 4 ms 的重建尖峰。 */
export function rankedCands(mode: Mode): RankRow[] {
  const m: Mode = mode === "tput" ? "tput" : "lat";
  const now = Date.now();
  const c = S.rankCache;
  // 小池不进缓存：测试与冷启动都要看到当前真实列表
  const cached = S.alive.size >= CAND_CACHE_MIN ? c.v[m] : undefined;
  if (cached && c.t && now - (c.at[m] || 0) < CAND_TTL) return cached;
  if (S.alive.size < CAND_CACHE_MIN || S.alive.size < CAND_SLICE_MIN) return buildCands(m, now);
  const steps = c.step || (c.step = {});
  let st = steps[m];
  if (!st) {
    st = { keys: [...S.alive.keys()], pos: 0, top: [], extra: [], ok: 0 };
    c.step[m] = st;
  }
  const end = Math.min(st.keys.length, st.pos + CAND_SLICE);
  for (let i = st.pos; i < end; i++) {
    const k = st.keys[i];
    if (!usable(k)) continue;
    st.ok++;
    const v = costOf(k, m);
    if (st.top.length < CAND_KEEP || v < st.top[st.top.length - 1].v) {
      let lo = 0;
      let hi = st.top.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        // 相等时插在后面：保持插入顺序（同价节点按 alive 顺序，结果可复现）
        if (st.top[mid].v <= v) lo = mid + 1;
        else hi = mid;
      }
      st.top.splice(lo, 0, { k, v });
      if (st.top.length > CAND_KEEP) st.top.pop();
    } else if (st.extra.length < CAND_EXTRA) {
      const s = S.nstat.get(k);
      if (!(s && s.okW + s.failW >= SC.N_EFF_MIN)) st.extra.push({ k, v });
    }
  }
  st.pos = end;
  S.candN = st.ok;
  if (st.pos < st.keys.length) {
    // 半程不重发表格（省掉每 pick 一次 concat）；只有冷启动时才把半程结果先用起来
    if (cached) return cached;
    S.rankCache = { ...c, v: { ...c.v, [m]: st.top } };
    return st.top;
  }
  const rows = st.extra.length ? st.top.concat(st.extra) : st.top;
  delete c.step[m];
  S.rankCache = { ...c, t: now, at: { ...c.at, [m]: now }, v: { ...c.v, [m]: rows } };
  return rows;
}

/** 候选列表（已过滤黑名单/冻结，按代价升序）。缓存只冻结排序，不冻结"能不能用"。 */
export function candsFor(mode: Mode): RankRow[] {
  const out: RankRow[] = [];
  for (const r of rankedCands(mode)) if (S.alive.has(r.k) && !isBlack(r.k) && !isFrozen(r.k)) out.push(r);
  return out;
}

/** 下一个候选（可跳过 avoid，可限定地区） */
export function nextNode(mode: Mode, avoid: string, cc?: string | null): string {
  const want = String(cc || "").toUpperCase();
  for (const x of candsFor(mode)) {
    if (x.k === avoid) continue;
    if (want) {
      const a = S.alive.get(x.k);
      if (!a || String(a.cc || "").toUpperCase() !== want) continue;
    }
    return x.k;
  }
  return "";
}

/** 当前最优（候选表第一名的 key） */
export function bestFor(mode: Mode): string {
  const c = candsFor(mode);
  return c.length ? c[0].k : "";
}