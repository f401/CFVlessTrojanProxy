import { SC } from "../core/const";
import { S } from "../core/state";
import { bestFor, isBlack, isFrozen, scoreParts, usable } from "../nodes/score";

/**
 * 延迟模式的 Thompson 采样。
 *
 * 为什么不是"分数排序 + 温度"：分数里含 8000×pFail，而 pFail 在 0.5% 量级根本测不准
 * （10 个样本时标准差 8.7%，×8000 = ±696ms），噪声远大于节点间 20–60ms 的真实差异。
 * 这里把失败率降级成**门槛**，排序只看可测的延迟，并按后验不确定性抽样：
 * 样本少的节点后验宽、自然会被抽到；样本多的靠均值竞争。
 *
 * 关键实现细节（都是仿真里踩出来的）：
 *   · 统计必须**每条连接重算** —— 缓存 1 秒就会让"刚拿到样本"的节点继续被当未知（1.22x → 1.59x）；
 *   · 只有**已测节点**参与抽样，未测节点（先验 10%）走 `bestFor` 兜底去热身；
 *   · 成员表（按延迟前 64）可以缓存 20 秒，它只决定"谁有资格被抽"。
 */

/** 标准正态（Box-Muller）；不用 while，避免 Math.random 被打桩成 0 时死循环 */
function gauss(): number {
  const u = Math.random() || 1e-9;
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 按延迟重建成员表（20 秒一次） */
function rebuild(mode: Mode, now: number) {
  const rows: { k: string; lat: number }[] = [];
  for (const k of S.alive.keys()) {
    if (isBlack(k) || isFrozen(k) || !usable(k)) continue;
    rows.push({ k, lat: scoreParts(k, mode, now).latencyMs });
  }
  rows.sort((a, b) => a.lat - b.lat);
  S.tsMem.keys = rows.slice(0, SC.TS_K).map((x) => x.k);
  S.tsMem.at = now;
}

/**
 * 选一个延迟节点：已测且过门槛的里面按后验抽样，选最小的。
 * @param {string} mode 只在这里用 "lat"
 * @returns {string} 节点 key（可能为空）
 */
export function pickTS(mode: Mode): string {
  const now = Date.now();
  if (!S.tsMem.at || now - S.tsMem.at > 20000 || !S.tsMem.keys.length) rebuild(mode, now);
  let best = "",
    bv = Infinity;
  for (const k of S.tsMem.keys) {
    if (!S.alive.has(k) || isBlack(k) || isFrozen(k)) continue;
    const p = scoreParts(k, mode, now);
    // 未测节点不参与抽样：先验 10% 会被门槛全挡掉，交给 bestFor 一个一个热身
    if (p.pFailRisk > SC.FAIL_GATE) continue;
    const sd = p.latencyMs / Math.sqrt(Math.max(1, p.latN));
    const v = p.latencyMs + gauss() * sd;
    if (v < bv) {
      bv = v;
      best = k;
    }
  }
  return best || bestFor(mode);
}
