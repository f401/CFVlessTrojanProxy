interface PickState {
  host?: string;
  node?: string;
  hostTrial?: boolean;
  trial?: boolean;
  retried?: boolean;
}

import { SC } from "../core/const";
import { shadowRate } from "../core/util";
import { hostKey, hostRank, hostUntried, logErr } from "../nodes/metrics";
import { MODES, aliveList, keyOf, pxGet } from "./pool";
import { cnt } from "../core/counter";
import { pxPolicy } from "./probe";
import {
  bestFor,
  candsFor,
  costOf,
  freezeNode,
  isBlack,
  isFrozen,
  nsFail,
  nsGet,
  ZERO_STAT,
  nsSiteFail,
} from "../nodes/score";
import { S } from "../core/state";

/* 节点选择：挑谁 / 何时换 / 失败怎么办 */
export class Selector {
  /** 按国家挑一个节点（地区出口） */
  async region(env: Env, cc: string | null) {
    const want = String(cc || "").toUpperCase();
    if (!want) return null;
    const list = await aliveList(env);
    const hit = list.filter(
      (x) => String(x.cc || "").toUpperCase() === want && !isBlack(keyOf(x)) && !isFrozen(keyOf(x)),
    );
    if (!hit.length) return null;
    hit.sort((a, b) => costOf(keyOf(a), "tput") - costOf(keyOf(b), "tput"));
    return hit[0];
  }

  /**
   * 选一个节点。
   *   ① 先看"这个站"的历史：有样本就按站点分选（hostCost）
   *   ② 冷启动（这个站试过的节点 <3）：一半概率去试一个没试过的
   *   ③ 都没有 → 回到全局游标 + 影子流量
   */
  pick(env: Env, mode: Mode, st: PickState | null) {
    const m = mode === "lat" ? "lat" : "tput";
    const now = Date.now();
    let cur = S.curs[m];
    // 游标可能是上一代候选池里的节点：池子刷新后 alive 里已经没有它了。
    // 以前会一直把连接拨到这个死地址，直到 cron 的 maybeSwitch 才发现。
    if (!cur || !S.alive.has(cur) || isBlack(cur) || isFrozen(cur)) {
      cur = bestFor(m);
      S.curs[m] = cur; // 没有候选就清空：别让面板/health 一直显示一个已经不存在的节点
    }
    if (!cur) cnt("noCand");
    const host = st && st.host ? String(st.host) : "";
    if (st) st.hostTrial = false;

    // 画像按"域名族"存（api.x.com 与 pbs.twimg.com 共用 x.com），读写必须用同一个键
    const fam = host ? hostKey(host) : "";
    if (host && fam) {
      const hm = S.hostNode.get(fam);
      const tried = hm ? hm.size : 0;

      // ① 有站点样本 → 按站点分选。
      //    少于 3 个节点有样本时排序没有比较意义（门槛在下面也要求 sampled>=3），
      //    直接跳过：省掉一次遍历全部节点的 hostRank 构建。
      if (tried >= 3) {
        const rank = hostRank(host, m);
        if (rank.length) {
          const best = rank[0].k;
          const bs = hm!.get(best);
          // 至少 3 个节点有样本、且首选样本不超过 2 小时，才敢用站点偏好覆盖全局
          let sampled = 0;
          for (const s of hm!.values()) if (s.n > 0) sampled++;
          const fresh = now - (bs ? bs.at || 0 : 0) <= 2 * 3600e3;
          if (bs && bs.n > 0 && sampled >= 3 && fresh) {
            // 稳定期留 2% 给次优节点，保持样本新鲜（不然一次侥幸定终身）。
            // 但次优和首选差太多时不换：那不是"保持新鲜"，是主动跳坑。
            const second = rank[1];
            if (second && second.v <= rank[0].v * 1.3 + 100 && !(st && st.retried) && Math.random() < 0.02) {
              if (st) st.node = second.k;
              return second.k;
            }
            if (st) st.node = best;
            return best;
          }
        }
      }
    }

    // ③ 全局：粘滞游标 + 自适应探索
    //   样本不足（nEff<3）→ 最多 10%，样本够了 → 回落到 pxShadow（默认 5%）
    //   站点冷启动和全局影子共用这一次掷骰，避免两层探索叠加
    const base = shadowRate(env);
    const needRate = cur ? this.nEffOf(cur) < SC.N_EFF_MIN : true;
    // pxShadow=0 视为"关闭探索"；否则样本不足时最高放到 EXPLORE_MAX
    const exploreP = base <= 0 ? 0 : Math.min(1, needRate ? Math.max(base, SC.EXPLORE_MAX) : base);
    const canTrial = !(st && st.retried);
    if (cur && canTrial && exploreP > 0 && Math.random() < exploreP) {
      // 这个站还没试够节点：先补站点样本（仍受同一个预算约束）
      if (host && fam) {
        const hm = S.hostNode.get(fam);
        if (!hm || hm.size < 3) {
          const t0 = hostUntried(host, m);
          if (t0) {
            nsGet(t0).lastTry = Date.now();
            if (st) {
              st.hostTrial = true;
              st.node = t0;
            }
            return t0;
          }
        }
      }
      const t = this.trial(m);
      if (t) {
        const s = nsGet(t);
        s.lastTry = Date.now();
        if (st) {
          st.trial = true;
          st.node = t;
        }
        return t;
      }
    }
    // ④ 负载感知：当前节点在途连接多的时候，允许溢出到分数接近的空闲候选
    if (cur && (S.inflight.get(cur) || 0) >= 2) {
      const cv = costOf(cur, m);
      let alt = "",
        bv = Infinity;
      // 看前 8 个而不是前 3 个：前 3 可能全忙，后面仍有同分数的空闲节点
      for (const x of candsFor(m).slice(0, 8)) {
        if (x.k === cur) continue;
        if (x.v > cv * 1.5) continue;
        if ((S.inflight.get(x.k) || 0) >= (S.inflight.get(cur) || 0)) continue;
        if (x.v < bv) {
          bv = x.v;
          alt = x.k;
        }
      }
      if (alt) cur = alt;
    }
    if (st) st.node = cur;
    return cur;
  }

  /** 有效吞吐窗口数：sumW²/sumW2（样本不足就不值得长期驻留） */
  nEffOf(k: string): number {
    const s = S.nstat.get(k);
    if (!s || !(s.sumW2 > 0)) return 0;
    return (s.sumW * s.sumW) / s.sumW2;
  }

  /** 待测队列：样本不足的节点，最久没试的优先（单遍扫描，不排序） */
  trial(mode: Mode) {
    let best = "",
      bestT = Infinity;
    for (const k of S.alive.keys()) {
      if (k === S.curs[mode] || isBlack(k) || isFrozen(k)) continue;
      const a = (S.alive.get(k) || {}) as NodeEntry;
      if (!a.ms || a.ms > 250) continue; // 只试"探活不慢"的节点，慢的试了只会更慢
      const s = S.nstat.get(k) || ZERO_STAT;
      const n = (s.okW || 0) + (s.failW || 0);
      // 样本够了就不再试探：按有效吞吐窗口数判断，而不是累计字节
      if (this.nEffOf(k) >= SC.N_EFF_MIN && n >= SC.TRIAL_N) continue;
      const t = s.lastTry || 0;
      if (t < bestT) {
        bestT = t;
        best = k;
      }
    }
    return best;
  }

  /** 重新评估是否该换节点（cron 与失败路径共用） */
  maybeSwitch(env: Env, mode: Mode) {
    const m = mode === "lat" ? "lat" : "tput";
    const now = Date.now();
    const cur = S.curs[m];
    const cands = candsFor(m);
    if (!cands.length) return false;
    const best = cands[0];
    if (!cur) {
      S.curs[m] = best.k;
      S.lastSwitch[m] = now;
      return true;
    }
    if (!S.alive.has(cur) || isBlack(cur) || isFrozen(cur)) {
      S.prev[m] = cur;
      S.curs[m] = best.k;
      S.lastSwitch[m] = now;
      return true;
    }
    if (best.k === cur) return false;
    const cv = costOf(cur, m);
    const h = m === "tput" ? Math.max(1, cv * SC.H_TPUT) : Math.max(SC.H_LAT, cv * 0.15);
    if (cv - best.v <= h) return false;
    const dwell = m === "tput" ? SC.DWELL_TPUT : SC.DWELL;
    if (now - (S.lastSwitch[m] || 0) < dwell) return false;
    const hits = (S.switchHits[m] || []).filter((t) => now - t < 3600000);
    if (hits.length >= SC.BUDGET) {
      S.switchHits[m] = hits;
      return false;
    }
    hits.push(now);
    S.switchHits[m] = hits;
    S.prev[m] = cur;
    S.curs[m] = best.k;
    S.lastSwitch[m] = now;
    cnt("sw");
    logErr(`switch(${m}) ${cur} -> ${best.k}`, "v=" + Math.round(cv) + ">" + Math.round(best.v));
    return true;
  }

  /**
   * 失败处理：记账 → 必要时回滚/换节点。
   * 影子连接的失败只记在该节点头上，不动主游标。
   * @param {object} env Worker 环境
   * @param {string} mode 模式
   * @param {string} k 节点
   * @param {boolean} trial 是否为影子连接
   * @returns {void}
   */
  onFail(env: Env, mode: Mode, k: string, trial: boolean) {
    if (!k) return;
    nsFail(k);
    if (trial) {
      freezeNode(k);
      return;
    }
    const m = mode === "lat" ? "lat" : "tput";
    const prev = S.prev[m];
    const now = Date.now();
    if (
      k === S.curs[m] &&
      prev &&
      S.alive.has(prev) &&
      !isBlack(prev) &&
      !isFrozen(prev) &&
      now - (S.lastSwitch[m] || 0) < SC.ROLL_WIN
    ) {
      S.curs[m] = prev;
      S.prev[m] = "";
      S.lastSwitch[m] = now;
      freezeNode(k);
      logErr(`rollback(${m}) ${k} -> ${prev}`, "60s");
      return;
    }
    if (k === S.curs[m]) {
      const b = bestFor(m);
      if (b && b !== k) {
        S.prev[m] = k;
        S.curs[m] = b;
        S.lastSwitch[m] = now;
        logErr(`fail-switch(${m}) ${k} -> ${b}`, "");
      }
    }
  }

  /** 只记一次全局失败，不动游标也不冻结（站点级试探失败用） */
  async softFail(k: string) {
    // 站点级试探失败：只轻记全局，不动主游标
    if (k) nsSiteFail(k);
  }

  /** 记一次失败；连续到阈值就换节点。兼容旧调用。 */
  async bumpFail(env: Env, mode: Mode, k: string, trial: boolean, kind: "node" | "site" = "node") {
    if (kind === "site") {
      // 目标站侧的问题：不推进失败计数、不换全局游标，只轻记节点
      if (k) nsSiteFail(k);
      return;
    }
    const node = k || S.curs[mode === "lat" ? "lat" : "tput"] || S.curs.tput || S.curs.lat || "";
    this.onFail(env, mode, node, !!trial);
    if (trial) return; // 影子/站点试探失败不惩罚主游标，也不进全局失败记忆
    S.pxFailSeen = 1;
    S.pxFailMem += 1;
    const { fail, force } = pxPolicy(env);
    if (S.pxFailMem < fail) return;
    const n = S.pxFailMem;
    S.pxFailMem = 0;
    if (n >= force) {
      S.prev.tput = "";
      S.prev.lat = "";
    }
    this.maybeSwitch(env, "lat");
    this.maybeSwitch(env, "tput");
  }

  /** 链路健康：清零计数。成功样本由 Connection.flush 在收尾时统一记一次。 */
  async resetFail(_env: Env, _k: string) {
    if (!S.pxFailSeen) return;
    S.pxFailSeen = 0;
    S.pxFailMem = 0;
  }

  /** 当前节点（"auto" 模式才用池子；手动配置直接返回） */
  async current(env: Env, mode: Mode, st: PickState | null) {
    const raw = String(env.proxyip || "").trim();
    if (!raw) return "";
    const m = mode === "lat" ? "lat" : "tput";
    if (raw.toLowerCase() !== "auto") {
      if (st) st.node = raw;
      return raw;
    }
    await pxGet(env);
    const k = this.pick(env, m, st);
    return k || "";
  }

  /**
   * 定时轮换：让"成绩接近"的前二名轮流吃真实流量，保证吞吐样本不全压在一个人身上。
   * @param {object} env Worker 环境
   * @returns {void}
   */
  sched(env: Env) {
    const h = env.pxSchedH === undefined ? 6 : Number(env.pxSchedH) || 0;
    if (!(h > 0)) return;
    const seedBucket = (S.seed.byColo || {})[S.colo || "*"] || {};
    const last = Math.max(S.lastSwitch.lat || 0, S.lastSwitch.tput || 0, seedBucket.lastSwitch || 0);
    if (Date.now() - last < h * 3600000) return;
    for (const m of MODES) {
      const cands = candsFor(m);
      if (cands.length < 2) continue;
      const bs = cands[0].v;
      const pair = cands.filter((x) => x.v <= bs * 1.3).slice(0, 2);
      if (pair.length < 2) continue;
      const next = S.curs[m] === pair[0].k ? pair[1].k : pair[0].k;
      if (!next || next === S.curs[m]) continue;
      const prev = S.curs[m];
      S.curs[m] = next;
      S.lastSwitch[m] = Date.now();
      S.prev[m] = prev;
      logErr(`sched(${m}) ${prev} -> ${next}`, "sched");
    }
    S.seedDirty = true;
  }

  /**
   * 一轮扫描：重建池子 → 探测候选 → 复测 alive → 重算游标 → 落盘。
   * @param {object} env Worker 环境
   * @returns {Promise<void>}
   */
}

export const SEL = new Selector();
