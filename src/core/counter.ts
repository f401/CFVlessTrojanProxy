import { S } from "./state";

/* 日计数器：进程内计数、跨天清零、批次回滚 */

/** 跨天重置日计数：任何出口（cntView/cntDelta）都要先过这一层 */
function rollCntDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (S.cntDay === d) return;
  S.cntDay = d;
  for (const key of S.cntKeys) {
    S.cnt[key] = 0;
    S.cntSent[key] = 0;
  }
}

/** 计数（跨天自动清零） */
export function cnt(k: string, n = 1) {
  if (!S.cntKeys.includes(k)) {
    try {
      console.error("[cnt] unknown key", k);
    } catch (e) {}
    return;
  }
  rollCntDay();
  S.cnt[k] = (S.cnt[k] || 0) + (n === undefined ? 1 : n);
}

/**
 * 功能：读当日计数快照（先滚动日界）。
 * @returns 各计数字段与日期 d（YYYY-MM-DD）
 */
export function cntView() {
  rollCntDay();
  return { ...S.cnt, d: S.cntDay || new Date().toISOString().slice(0, 10) };
}

/**
 * 功能：取「自上次调用以来」的增量并把当前值记为已上报。
 * @returns 字段名 → 增量
 */
export function cntDelta() {
  rollCntDay();
  const out: Record<string, number> = {};
  for (const k of S.cntKeys) {
    const v = (S.cnt[k] || 0) - (S.cntSent[k] || 0);
    if (v) out[k] = v;
  }
  for (const k of S.cntKeys) S.cntSent[k] = S.cnt[k] || 0;
  return out;
}

/** 批次失败时把日计数基线退回去，下一轮重新发送 */
export function cntUnsend(delta: Record<string, number>) {
  for (const [k, v] of Object.entries(delta)) {
    if (S.cntSent[k] === undefined) continue;
    S.cntSent[k] = Math.max(0, (S.cntSent[k] || 0) - v);
  }
}

