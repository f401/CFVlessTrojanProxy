import { ISOLATE } from "../core/state";
import { SEED_STORE } from "./seed";
import { NODE_MEMORY } from "../core/node-memory";
import { SELECTION_MEMORY } from "./selection-memory";
// 什么时候换节点：最短驻留时间（dwellOf）、切走判据、切完之后的观察窗与复查。
// 「挑谁」在 ./pickpath，「失败怎么记」在 ./failbook —— 这个文件只管「换不换」。

import { SC } from "../core/const";
import { logErr } from "../nodes/metrics";
import { MODES } from "./const";
import { cnt } from "../core/counter";
import { isBlack, isFrozen, scoreParts, CANDS } from "../nodes/score";

/**
 * 切换后的最短驻留时间。pxDwellMin 只接受正数覆盖；未设置 / 0 / 非法时
 * 回落到模式默认值（lat 10 分钟、tput 20 分钟），避免"配了 0 却以为关掉了"。
 */
export function dwellOf(env: Env, mode: Mode) {
  const def = mode === "tput" ? SC.DWELL_TPUT : SC.DWELL;
  const raw = env && env.pxDwellMin;
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 60000 : def;
}

/**
 * 轮换策略：每隔一段时间（或一次扫描之后）判断「现在这条还值不值得留」，
 * 决定是否切到抽样器给的下一条。游标与切换窗口由 SELECTION_MEMORY 持有，候选缓存由 CANDS 持有。
 */
export class Rotation {
  /** 重新评估是否该换节点（cron 与失败路径共用） */
  maybeSwitch(env: Env, mode: Mode) {
    const m = mode === "lat" ? "lat" : "tput";
    const now = Date.now();
    const cur = SELECTION_MEMORY.current[m];
    const cands = CANDS.list(m);
    if (!cands.length) return false;
    const best = cands[0];
    if (!cur) {
      SELECTION_MEMORY.current[m] = best.k;
      SELECTION_MEMORY.switchedAt[m] = now;
      return true;
    }
    if (!NODE_MEMORY.alive.has(cur) || isBlack(cur) || isFrozen(cur)) {
      SELECTION_MEMORY.switchTo(m, best.k, now);
      return true;
    }
    if (best.k === cur) return false;
    // 滞回必须按"主项"算：总分里含 8000×pFail 的风险项，拿总分乘比例会让
    // 风险项把延迟差异整个吃掉（250ms 的老节点门槛高达 210ms，60ms 的新节点永远换不上）。
    const cp = scoreParts(cur, m);
    const cv = cp.score;
    const h =
      m === "tput" ? Math.max(1, cp.e10Ms * SC.H_TPUT) : Math.max(SC.H_LAT, cp.latencyMs * SC.H_LAT_REL);
    if (cv - best.v <= h) return false;
    const dwell = dwellOf(env, m);
    if (now - (SELECTION_MEMORY.switchedAt[m] || 0) < dwell) return false;
    const hits = (SELECTION_MEMORY.switches[m] || []).filter((t) => now - t < 3600000);
    if (hits.length >= SC.BUDGET) {
      SELECTION_MEMORY.switches[m] = hits;
      return false;
    }
    hits.push(now);
    SELECTION_MEMORY.switches[m] = hits;
    SELECTION_MEMORY.switchTo(m, best.k, now);
    cnt("sw");
    logErr(`switch(${m}) ${cur} -> ${best.k}`, "v=" + Math.round(cv) + ">" + Math.round(best.v));
    return true;
  }

  /** cron 扫描收尾：重算两个模式的游标，再做定时轮换 */
  afterScan(env: Env) {
    for (const m of MODES) this.maybeSwitch(env, m);
    this.sched(env);
  }

  /**
   * 定时轮换：让"成绩接近"的前二名轮流吃真实流量，保证吞吐样本不全压在一个人身上。
   * @param {object} env Worker 环境
   * @returns {void}
   */
  sched(env: Env) {
    const h = env.pxSchedH === undefined ? 6 : Number(env.pxSchedH) || 0;
    if (!(h > 0)) return;
    const seedBucket = (SEED_STORE.document.byColo || {})[ISOLATE.colo || "*"] || {};
    const last = Math.max(SELECTION_MEMORY.switchedAt.lat || 0, SELECTION_MEMORY.switchedAt.tput || 0, seedBucket.lastSwitch || 0);
    // 冷启动（还没有任何切换记录）不要轮换：否则第一条 cron 会把刚选出的第 1 名
    // 换成第 2 名，第 2 名因此拿到最初 10 分钟的全部样本，反过来把第 1 名永久压住。
    if (!last) return;
    if (Date.now() - last < h * 3600000) return;
    for (const m of MODES) {
      const cands = CANDS.list(m);
      if (cands.length < 2) continue;
      const bs = cands[0].v;
      const pair = cands.filter((x) => x.v <= bs * 1.3).slice(0, 2);
      if (pair.length < 2) continue;
      const next = SELECTION_MEMORY.current[m] === pair[0].k ? pair[1].k : pair[0].k;
      if (!next || next === SELECTION_MEMORY.current[m]) continue;
      const prev = SELECTION_MEMORY.current[m];
      SELECTION_MEMORY.switchTo(m, next, Date.now());
      logErr(`sched(${m}) ${prev} -> ${next}`, "sched");
    }
    NODE_MEMORY.statisticsDirty = true;
  }
}
