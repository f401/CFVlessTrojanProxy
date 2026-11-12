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
import { MODES, keyOf } from "./const";
import { pickTS } from "./ts";
import { aliveList, pxGet } from "./pool";
import { cnt } from "../core/counter";
import { pxPolicy } from "./probe";
import {
  bestFor,
  candsFor,
  rankedCands,
  costOf,
  freezeNode,
  isBlack,
  isFrozen,
  nsFail,
  nsGet,
  scoreParts,
  suspectOf,
  usable,
  ZERO_STAT,
  nsSiteFail,
} from "../nodes/score";
import { S } from "../core/state";

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

/* 节点选择：挑谁 / 何时换 / 失败怎么办 */
export class Selector {
  /** 按国家挑一个节点（地区硬要求：调用方不得回落到直连/全球） */
  async region(env: Env, cc: string | null, mode: Mode = "tput", avoid = "") {
    const want = String(cc || "").toUpperCase();
    if (!want) return null;
    const list = await aliveList(env);
    // 冷却/冻结是硬排除：全国都不可用就返回 null，交给上层 1011
    const live = list.filter((x) => {
      const k = keyOf(x);
      return String(x.cc || "").toUpperCase() === want && k !== avoid && !isBlack(k) && !isFrozen(k);
    });
    if (!live.length) return null;
    // 低可用/空关闭可疑是软排除：全国只剩它们时仍然要选一个（地区是硬要求）
    const ok = live.filter((x) => usable(keyOf(x)));
    const pool = ok.length ? ok : live;
    // 一次算分，别在 sort 比较器里反复调 costOf（30 个节点会算 150 次）
    const scored = pool.map((x) => ({ x, v: costOf(keyOf(x), mode) })).sort((a, b) => a.v - b.v);
    // 负载感知：最优代价 1.5 倍内挑在途最少的，避免全国连接全压在第一名
    const band = scored.filter((r) => r.v <= scored[0].v * 1.5 + 50).slice(0, 8);
    let pick = band[0];
    let load = S.inflight.get(keyOf(pick.x)) || 0;
    for (const r of band) {
      const l = S.inflight.get(keyOf(r.x)) || 0;
      if (l < load) {
        pick = r;
        load = l;
      }
    }
    return pick.x;
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
    // 游标只做面板/健康展示：真正走谁由 pickByScore 抽签决定。
    // 这里仍然维护游标，是为了面板/health 不显示一个已经死掉或冷却的节点。
    if (!cur || !S.alive.has(cur) || isBlack(cur) || isFrozen(cur)) {
      cur = bestFor(m);
      S.curs[m] = cur;
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

    // ②.5 延迟模式：Thompson 采样（失败率做门槛，只信已测节点）
    if (m === "lat" && SC.LAT_TS > 0) {
      const k = pickTS(m);
      if (k) {
        if (st) st.node = k;
        return k;
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
    // ④ 延迟模式：加权抽签（前 K 名按 exp(-(v-v0)/T) 抽）
    //    吞吐模式仍走粘滞游标 —— 抽签在"带宽崩塌"场景实测更差（2.68x → 4.22x）。
    const pick = this.pickByScore(m);
    if (pick) {
      let chosen = pick;
      // 负载感知：抽中的节点在途多时，换到分数接近、在途更少的候选
      if ((S.inflight.get(chosen) || 0) >= 2) {
        const cv = costOf(chosen, m);
        let alt = "",
          bv = Infinity;
        for (const x of candsFor(m).slice(0, 8)) {
          if (x.k === chosen) continue;
          if (x.v > cv * 1.5) continue;
          if ((S.inflight.get(x.k) || 0) >= (S.inflight.get(chosen) || 0)) continue;
          if (x.v < bv) {
            bv = x.v;
            alt = x.k;
          }
        }
        if (alt) chosen = alt;
      }
      if (st) st.node = chosen;
      return chosen;
    }
    // ⑤ 吞吐模式（或抽签关闭）：粘滞游标 + 负载溢出
    if (cur && (S.inflight.get(cur) || 0) >= 2) {
      const cv = costOf(cur, m);
      let alt = "",
        bv = Infinity;
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

  /**
   * 加权抽签（softmax）：在候选前 K 名里按 exp(-(v-v0)/T) 抽。
   * 单游标 + 滞回的毛病是"谁先拿到流量谁就永远赢"：游标拿 95% 流量 → 样本多 →
   * pFail 趋近 0 → 分数更低 → 继续拿流量。抽签让每个候选按分数分到流量，
   * 估计自然收敛；代价是"当前节点"不再是一个固定值（面板看 S.curs 的领先者）。
   * @param {string} mode "lat" | "tput"
   * @returns {string} 节点 key，没有候选返回 ""
   */
  pickByScore(mode: Mode): string {
    const T = mode === "tput" ? SC.ROUTE_T_TPUT : SC.ROUTE_T_LAT;
    if (!(T > 0)) return ""; // 关闭抽签：调用方退回粘滞游标
    // 只取前 K 个可用候选：candsFor 会对全表做一次 filter（400 节点 ~60µs/次）
    const list: { k: string; v: number }[] = [];
    for (const x of rankedCands(mode)) {
      if (list.length >= SC.ROUTE_K) break;
      if (!S.alive.has(x.k) || isBlack(x.k) || isFrozen(x.k)) continue;
      list.push(x);
    }
    if (!list.length) return "";
    const v0 = list[0].v;
    let tot = 0;
    const w = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const e = Math.exp(-(list[i].v - v0) / T);
      w[i] = e;
      tot += e;
    }
    let r = Math.random() * tot;
    for (let i = 0; i < list.length; i++) {
      r -= w[i];
      if (r <= 0) return list[i].k;
    }
    return list[0].k;
  }

  /** 有效吞吐窗口数：sumW²/sumW2（样本不足就不值得长期驻留） */
  nEffOf(k: string): number {
    const s = S.nstat.get(k);
    if (!s || !(s.sumW2 > 0)) return 0;
    return (s.sumW * s.sumW) / s.sumW2;
  }

  /** 待测队列：样本不足的节点，最久没试的优先（单遍扫描，不排序） */
  // watchlist 缓存：全表排序很贵（400 节点 ~1.5ms），60 秒重算一次就够
  private watchAt: Record<Mode, number> = { lat: 0, tput: 0 };
  private watch: Record<Mode, string[]> = { lat: [], tput: [] };
  /** watchlist 里"探活高估"的那几个：不算它们的样本进度，免得抢占正常探索 */
  private rehab: Record<Mode, Set<string>> = { lat: new Set(), tput: new Set() };

  /** 重建 watchlist：探活快 + 样本少的 32 个候选 */
  buildWatch(mode: Mode) {
    const enough = mode === "tput" ? SC.TRIAL_TPUT : SC.TRIAL_LAT;
    const cands: { k: string; v: number }[] = [];
    const rehab: { k: string; v: number }[] = [];
    for (const k of S.alive.keys()) {
      if (k === S.curs[mode] || isBlack(k) || isFrozen(k)) continue;
      const a = (S.alive.get(k) || {}) as NodeEntry;
      const s = S.nstat.get(k) || ZERO_STAT;
      if (suspectOf(s)) continue; // 连得上却传不出数据的节点，不值得占一次试探预算
      const n = (s.okW || 0) + (s.failW || 0);
      if (!a.ms) continue;
      if (a.ms > 250) {
        // 探活慢的节点一般不值得试；但"探活被瞬时拥塞抬到 400ms、实际 60ms"的节点
        // 永远拿不到真实样本就永远翻不了身（真实样本只能证明更慢）。留两个名额给它，
        // 按"最久没试过"轮转，样本进度按 +3 计，不抢占正常探索。
        if (!S.alive.size || a.ms > SC.REHAB_MS || n > 0) continue;
        rehab.push({ k, v: s.lastTry || 0 });
        continue;
      }
      if (n >= enough) continue; // 样本够了才毕业（3 个样本定生死＝把运气当能力）
      cands.push({ k, v: (a.ms || 250) + SC.WATCH_BONUS / Math.sqrt(n + 1) });
    }
    cands.sort((x, y) => x.v - y.v);
    rehab.sort((x, y) => x.v - y.v);
    const rh = rehab.slice(0, SC.REHAB_N);
    this.rehab[mode] = new Set(rh.map((x) => x.k));
    const room = Math.max(0, SC.WATCH_N - rh.length);
    this.watch[mode] = [...cands.slice(0, room).map((x) => x.k), ...rh.map((x) => x.k)];
    this.watchAt[mode] = Date.now();
    return this.watch[mode];
  }

  /** 探索预算只花在 watchlist 里：5% 摊到 N 个节点等于没探索 */
  trial(mode: Mode) {
    const enough = mode === "tput" ? SC.TRIAL_TPUT : SC.TRIAL_LAT;
    const pickIn = (list: string[]) => {
      let best = "",
        bestN = Infinity;
      for (const k of list) {
        if (k === S.curs[mode] || !S.alive.has(k) || isBlack(k) || isFrozen(k)) continue;
        const s = S.nstat.get(k) || ZERO_STAT;
        if (suspectOf(s)) continue;
        const n = (s.okW || 0) + (s.failW || 0) + (this.rehab[mode].has(k) ? 3 : 0);
        if (n >= enough) continue;
        if (n < bestN - 0.5) {
          best = k;
          bestN = n;
        }
      }
      return best;
    };
    let list = this.watch[mode];
    if (!list.length || Date.now() - this.watchAt[mode] > 60000) list = this.buildWatch(mode);
    return pickIn(list) || pickIn(this.buildWatch(mode));
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
    // 滞回必须按"主项"算：总分里含 8000×pFail 的风险项，拿总分乘比例会让
    // 风险项把延迟差异整个吃掉（250ms 的老节点门槛高达 210ms，60ms 的新节点永远换不上）。
    const cp = scoreParts(cur, m);
    const cv = cp.score;
    const h =
      m === "tput" ? Math.max(1, cp.e10Ms * SC.H_TPUT) : Math.max(SC.H_LAT, cp.latencyMs * SC.H_LAT_REL);
    if (cv - best.v <= h) return false;
    const dwell = dwellOf(env, m);
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
  onFail(_env: Env, mode: Mode, k: string, trial: boolean) {
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
    const seedBucket = (S.seed.byColo || {})[S.colo || "*"] || {};
    const last = Math.max(S.lastSwitch.lat || 0, S.lastSwitch.tput || 0, seedBucket.lastSwitch || 0);
    // 冷启动（还没有任何切换记录）不要轮换：否则第一条 cron 会把刚选出的第 1 名
    // 换成第 2 名，第 2 名因此拿到最初 10 分钟的全部样本，反过来把第 1 名永久压住。
    if (!last) return;
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
