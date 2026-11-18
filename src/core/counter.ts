/* 日计数器：进程内计数、跨天清零、批次回滚。7.369 起自持状态，不再寄存在 AppState。 */

/** 日计数器：独占 keys/values/day/sent 四张表，进程内计数、跨天清零、批次回滚。 */
export class Counter {
  readonly keys = [
    "restore",
    "restoreSkip",
    "pendFail",
    "snapWriteFail",
    "snapReadFail",
    "snapFlushReadFail",
    "snapFlushFail",
    "snapUsersFail",
    "seedWriteFail",
  "statsSeedFail",
  "admStatsSkip",
    "snapSkip",
    "srcSkip",
    "pendSkip",
    "egSent",
    "rgFail",
    "psNote",
    "psDO",
    "deadNote",
    "deadDO",
    "deadClear",
    "ftSkip",
    "blkBatch",
    "blkWrote",
    "blkNoPeer",
    "blkDO",
    "bizSweeps",
    "blkContra",
    "blkMutedSkip",
    "cronStale",
    "factsJoin",
    "factsDo",
    "factsCacheHit",
    "vtCacheBad",
    // 账本解不开（换过 kek / 值被写坏）：次数不为 0 就说明有实例在从零记账，
    // 原文会被 save() 备份到 `a_bak`，人工可抢救（v7.220）
    "doBad",
    "logsDoFail",
  "dayDoFail",
  "shardBad",
    "capSet",
    "capNoise",
    "rehab",
    "dnsProbe",
    "dnsDO",
    "egDO",
    "cfObs",
    "conn",
    "direct",
    "node",
    "eCloseD",
    "eCloseP",
    "px4",
    "tfb",
    "skipCfRelay", "badRelay",
  "pxf",
    "sw",
    "noCand",
    "tput",
"stall",
    "ustall",
    "cut",
    "ccut",
    "dead",
    "noPayload",
    "noAuth",
    "wsFail",
    "vtSent",
    "vtDO",
    "trHit",
    "trSmall",
    "smN",
    "smD",
    "sz1",
    "sz2",
    "sz3",
    "sz4",
    "vwild",
  ];
  values: Record<string, number> = {};
  day = "";
  sent: Record<string, number> = {};

  constructor() {
    // 计数键初始化成 0，避免"某个键忘了写"导致 undefined
    for (const k of this.keys) {
      this.values[k] = 0;
      this.sent[k] = 0;
    }
  }

  /** 跨天重置：任何出口（view/delta）都先过这一层 */
  private rollDay(): void {
    const d = new Date().toISOString().slice(0, 10);
    if (this.day === d) return;
    this.day = d;
    for (const key of this.keys) {
      this.values[key] = 0;
      this.sent[key] = 0;
    }
  }

  /** 计数（跨天自动清零）；未知键只打日志不计数 */
  add(k: string, n = 1): void {
    if (!this.keys.includes(k)) {
      try { console.error("[cnt] unknown key", k); } catch (e) {}
      return;
    }
    this.rollDay();
    this.values[k] = (this.values[k] || 0) + (n === undefined ? 1 : n);
  }

  /** 当日计数快照（先滚动日界），附日期 d */
  view(): Record<string, number | string> {
    this.rollDay();
    return { ...this.values, d: this.day || new Date().toISOString().slice(0, 10) };
  }

  /** 取增量并把当前值记为已上报 */
  delta(): Record<string, number> {
    this.rollDay();
    const out: Record<string, number> = {};
    for (const k of this.keys) {
      const v = (this.values[k] || 0) - (this.sent[k] || 0);
      if (v) out[k] = v;
    }
    for (const k of this.keys) this.sent[k] = this.values[k] || 0;
    return out;
  }

  /** 批次失败时把基线退回去，下一轮重新发送 */
  unsend(delta: Record<string, number>): void {
    for (const [k, v] of Object.entries(delta)) {
      if (this.sent[k] === undefined) continue;
      this.sent[k] = Math.max(0, (this.sent[k] || 0) - v);
    }
  }
}

/** 全仓唯一的日计数持有者 */
export const COUNTER = new Counter();

/** 计数（跨天自动清零）——保留自由 API，状态归 COUNTER 所有 */
export function cnt(k: string, n = 1): void { COUNTER.add(k, n); }
/** 读当日计数快照 */
export function cntView(): Record<string, number | string> { return COUNTER.view(); }
/** 取上报增量 */
export function cntDelta(): Record<string, number> { return COUNTER.delta(); }
/** 回滚上报基线 */
export function cntUnsend(delta: Record<string, number>): void { COUNTER.unsend(delta); }
