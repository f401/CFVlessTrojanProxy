import { SC } from "../core/const";
import { pcts } from "../core/hist";
import { S } from "../core/state";
import { TEN_MB, ZERO_STAT, availOf, effView, pFailFast, pFailOf, pStallOf } from "./stat";
import { isBlack, isFrozen } from "./score-health";

/* 节点代价函数：把一条候选压成一个毫秒当量。排序（选路）与面板（`?dd`/`?pss`）读同一份分解，
   避免「面板一套公式、选路另一套」。纯计算：除了只读 S.nstat / S.alive，不改任何状态。 */

/** 一次评分的完整分解（面板分项与选路排序共用） */
export interface ScoreParts {
  mode: Mode; score: number; latencyMs: number; e10Ms: number;
  pFailRisk: number; pStall: number; capBps: number; confB: number;
  nEff: number; latN: number; sampleAgeMs: number; xferMs: number;
  samples: number; jitMs: number; failMs: number; gate: string;
}

/**
 * 功能：算某节点在某模式下的代价分解（延迟项、失败风险、卡顿、吞吐），是选路的唯一评分入口。
 *
 * 分项（排序与面板共用这一份）：
 *   延迟 L = confL × Lobs + (1-confL) × Lprior
 *   吞吐 E10 = confB × (10MiB/cap) + (1-confB) × (10MiB/prior)
 *   score = 目标项 + FAIL×pFailRisk + STALL×pStall
 * @param k 节点键 host:port
 * @param mode lat 速率优先 / tput 吞吐优先
 * @param now 当前时间戳
 * @param withGate 是否计入准入闸门（未探活的惩罚）
 * @param bytes 本次目标流量，用于按流量折算代价
 * @returns 代价分解对象（含 score、各项分量与置信度）
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
    samples: N, jitMs, failMs, gate,
  };
}

/**
 * 功能：只要总分（毫秒当量，越小越好）。
 * @param k 节点键 host:port
 * @param mode lat 速率优先 / tput 吞吐优先
 * @param now 当前时间戳
 * @returns 评分（越小越好）
 */
export function costOf(k: string, mode: Mode, now = Date.now()): number {
  return scoreParts(k, mode, now).score;
}
